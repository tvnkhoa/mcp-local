/**
 * Name affinity, and the test-to-source linkage built on it.
 *
 * The scoring here is deliberately naive - token overlap after singularization - because this
 * server may not invoke an LLM. Everything else in this file exists to make that naivety good
 * enough: the stopword list keeps affinity on the entity rather than the CQRS layer, and the EF
 * carve-out admits the integration test that is the only real proof of a persistence change.
 */

import type Database from "better-sqlite3";
import { isTestPath } from "../indexing/fileFilter.js";

/**
 * Files that can never be "the code under test" (MCP-ISSUE-058(c)).
 *
 * The docs lane indexes Markdown into the same `files` table, and "not a test path" was the only
 * filter on the source side — so a prose flow document scored a name-affinity link against a handler
 * test and was returned as its `sourceFile`.
 */
const NON_CODE_SOURCE_EXT = /\.(md|markdown|mdx|txt|rst|adoc|json|ya?ml|xml|csv|lock|ini|toml|cfg|conf|sql|html?|css|scss|svg)$/i;

function isNonCodePath(filePath: string): boolean {
  return NON_CODE_SOURCE_EXT.test(filePath);
}

// ENH-029-D: EF/persistence changes (value converters, CHECK constraints, migrations) are only
// proven by the round-trip integration test, but name-affinity linkage favors the same-named unit
// test. When the changed file lives in the persistence layer, admit + boost integration tests.
const INFRA_PERSISTENCE_PATH = /\/(migrations|data\/configurations|configurations|persistence|dbcontext|infrastructure\/data)\//i;
const INTEGRATION_TEST_PATH = /(integration|systemtests?|\/system\/|e2e|endtoend|roundtrip)/i;

/** True for a changed source file in the EF/persistence layer (converter/CHECK/migration). */
export function isInfraPersistencePath(filePath: string): boolean {
  return INFRA_PERSISTENCE_PATH.test(filePath.replace(/\\/g, "/"));
}

/** True for an integration/system/e2e test (proves the persistence round-trip), not a unit test. */
export function isIntegrationTestPath(filePath: string): boolean {
  return INTEGRATION_TEST_PATH.test(filePath.replace(/\\/g, "/"));
}

// ISSUE-017: name-affinity fallback. Static CALLS/IMPORTS edges miss tests that exercise a
// handler via `new XHandler(ctx).Handle(...)` or a MediatR stub (no resolvable edge), and the
// exact-base name_similarity check below only fires when the normalized base names are *equal*.
// So a feature's own tests (e.g. EmailSignaturesCommandHandlerTests ↔ CreateEmailSignatureCommandHandler)
// were dropped to residualRisk. Affinity links them on shared *distinctive* tokens (entity name),
// excluding the role words every CQRS file shares so unrelated `*CommandHandler` pairs don't match.

/** Role/verb words shared by many CQRS files — excluded so affinity keys on the entity, not the layer. */
const NAME_AFFINITY_STOPWORDS = new Set<string>([
  "test", "spec", "fixture", "mock", "stub",
  "command", "query", "handler", "validator", "controller", "service", "repository",
  "endpoint", "endpointgroup", "factory", "builder", "behaviour", "behavior", "middleware",
  "request", "response", "result", "dto", "model", "entity", "configuration", "config",
  "create", "update", "delete", "get", "list", "upsert", "patch", "set", "add", "remove",
  "find", "fetch", "save", "apply", "toggle", "archive", "enable", "disable"
]);

/** Naive singularizer good enough to bridge singular source ↔ plural test names (EmailSignature ↔ EmailSignatures). */
function singularizeToken(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return token.slice(0, -3) + "y";
  if (token.length > 4 && token.endsWith("ses")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

/** Split a file base into lower-cased, singularized, distinctive tokens (camel/Pascal/snake/kebab aware). */
function distinctiveNameTokens(filePath: string): Set<string> {
  const base = (filePath.replace(/\\/g, "/").split("/").pop() ?? filePath)
    .replace(/\.(tsx?|jsx?|mjs|cjs|py|cs)$/i, "")
    // Strip test/spec markers only at a real boundary — a delimiter or a PascalCase suffix —
    // so source bases that merely END in the letters "test" (Greatest, Manifest, Latest) are
    // not mangled into a wrong token. (review)
    .replace(/([._-](test|spec)s?|(test|spec)_)$/i, "")
    .replace(/(Tests?|Specs?)$/, "");
  const tokens = base
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .map((t) => singularizeToken(t.toLowerCase()))
    .filter((t) => t.length >= 3 && !NAME_AFFINITY_STOPWORDS.has(t));
  return new Set(tokens);
}

/** Shared-distinctive-token coverage of `target` by `candidate` (0..1). */
function sharedTokenCoverage(candidateTokens: Set<string>, targetTokens: Set<string>): number {
  if (targetTokens.size === 0) return 0;
  let shared = 0;
  for (const t of targetTokens) if (candidateTokens.has(t)) shared++;
  return shared / targetTokens.size;
}

export function linkTestsToSource(
  db: Database.Database,
  repoId: string,
  filePath: string | null,
  limit: number,
  maxCandidates: number,
  minScore: number,
  // Optional cross-call cache of source-file → distinctive tokens. change_impact probes many
  // source files in one request; passing a shared map tokenizes each source at most once for
  // the whole request instead of re-tokenizing the entire source set on every call. (review)
  sourceTokensCache?: Map<string, Set<string>>
): {
  testFile: string;
  sourceFile: string;
  score: number;
  reasons: string[];
}[] {
  const normalizePath = (v: string) => v.replace(/\\/g, "/");
  const normalizeBase = (v: string) => {
    const base = normalizePath(v).split("/").pop() ?? v;
    return base
      .replace(/\.(tsx?|jsx?|mjs|cjs|py|cs)$/i, "")
      .replace(/(\.test|\.spec|_test|test_|tests?)$/i, "")
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase();
  };

  const files = db
    .prepare(`select path as filePath from files where repo_id = ? order by path`)
    .all(repoId) as { filePath: string }[];

  const allPaths = files.map((x) => normalizePath(x.filePath));
  const testFiles = allPaths.filter(isTestPath);
  // MCP-ISSUE-058(c): "not a test" is not the same as "is source". With the docs lane enabled, the
  // candidate set included Markdown, and the tool answered
  // `sourceFile: "docs/02-flows/flow-call-log-reply.md"` for a handler test — a documentation file
  // is never the code under test.
  const sourceFiles = allPaths.filter((x) => !isTestPath(x) && !isNonCodePath(x));

  const targetNormalized = filePath ? normalizePath(filePath) : null;
  const targetIsTest = targetNormalized ? isTestPath(targetNormalized) : false;
  // ISSUE-017: when probing a source file, also admit tests sharing the source's distinctive
  // tokens (entity name) so the name-affinity scoring below has a candidate to link — exact/
  // path-substring selection alone never surfaces EmailSignaturesCommandHandlerTests for
  // CreateEmailSignatureCommandHandler.
  // Lazy, memoized tokenizers. Source tokens reuse the caller-supplied cache (shared across a
  // change_impact request); test tokens are cached per call so the selection filter and the
  // scoring loop below don't tokenize the same test name twice. (review)
  const sourceTokensByFile = sourceTokensCache ?? new Map<string, Set<string>>();
  const sourceTokensOf = (f: string): Set<string> => {
    let t = sourceTokensByFile.get(f);
    if (!t) {
      t = distinctiveNameTokens(f);
      sourceTokensByFile.set(f, t);
    }
    return t;
  };
  const testTokensByFile = new Map<string, Set<string>>();
  const testTokensOf = (f: string): Set<string> => {
    let t = testTokensByFile.get(f);
    if (!t) {
      t = distinctiveNameTokens(f);
      testTokensByFile.set(f, t);
    }
    return t;
  };

  const targetTokens = targetNormalized && !targetIsTest ? distinctiveNameTokens(targetNormalized) : new Set<string>();
  /** Non-null when the caller named a SOURCE file: every emitted pair must be about that file. */
  const anchorSourceFile = targetNormalized && !targetIsTest ? targetNormalized : null;
  // ENH-029-D: a persistence-layer change must run the integration tests even when their names
  // don't share the changed file's tokens — admit them on path so the boost below can rank them.
  const targetIsInfraPersistence = Boolean(targetNormalized) && !targetIsTest && isInfraPersistencePath(targetNormalized!);
  const selectedTests = targetNormalized
    ? (targetIsTest
        ? testFiles.filter((x) => x === targetNormalized)
        : testFiles
            .filter(
              (x) =>
                normalizeBase(x) === normalizeBase(targetNormalized) ||
                x.includes(normalizeBase(targetNormalized)) ||
                sharedTokenCoverage(testTokensOf(x), targetTokens) >= 0.5 ||
                (targetIsInfraPersistence && isIntegrationTestPath(x))
            )
            .slice(0, Math.max(limit * 2, 20)))
    : testFiles.slice(0, Math.max(limit * 3, 100));

  const output: {
    testFile: string;
    sourceFile: string;
    score: number;
    reasons: string[];
  }[] = [];

  for (const testFile of selectedTests) {
    const testBase = normalizeBase(testFile);
    const testTokens = testTokensOf(testFile);
    const sourceScoreMap = new Map<string, { score: number; reasons: Set<string> }>();

    const addScore = (sourceFile: string, score: number, reason: string) => {
      const current = sourceScoreMap.get(sourceFile) ?? { score: 0, reasons: new Set<string>() };
      current.score += score;
      current.reasons.add(reason);
      sourceScoreMap.set(sourceFile, current);
    };

    for (const sourceFile of sourceFiles) {
      if (normalizeBase(sourceFile) === testBase && testBase.length > 0) {
        addScore(sourceFile, 0.55, "name_similarity");
        continue;
      }
      // ISSUE-017: name-affinity fallback. Link when the source's distinctive tokens are (mostly)
      // present in the test name — the entity/handler the test is named after. Scored 0.42..0.5 so
      // it clears the default minScore (0.4) yet ranks below exact/import/call links, and is tagged
      // `name-affinity` so callers know it's a heuristic (not edge-proven) link.
      const srcTokens = sourceTokensOf(sourceFile);
      if (srcTokens.size === 0 || testTokens.size === 0) continue;
      let shared = 0;
      for (const t of srcTokens) if (testTokens.has(t)) shared++;
      if (shared > 0 && shared / srcTokens.size >= 0.5) {
        addScore(sourceFile, Math.min(0.5, 0.42 + 0.05 * (shared - 1)), "name-affinity");
      }
    }

    const importedSourceFiles = db
      .prepare(
        `
        select distinct st.file_path as sourceFile
        from edges e
        inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
        inner join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
        where e.repo_id = ? and e.type = 'IMPORTS' and replace(sf.file_path, char(92), '/') = ?
        limit 500
        `
      )
      .all(repoId, testFile) as { sourceFile: string }[];

    for (const row of importedSourceFiles) {
      addScore(normalizePath(row.sourceFile), 0.3, "import_trace");
    }

    const calledSourceFiles = db
      .prepare(
        `
        select distinct st.file_path as sourceFile
        from edges e
        inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
        inner join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
        where e.repo_id = ? and e.type = 'CALLS' and replace(sf.file_path, char(92), '/') = ?
        limit 500
        `
      )
      .all(repoId, testFile) as { sourceFile: string }[];

    for (const row of calledSourceFiles) {
      addScore(normalizePath(row.sourceFile), 0.25, "call_trace");
    }

    // ENH-029-D: boost the integration test ↔ changed-persistence-file link so the round-trip test
    // (the only layer that proves a converter/CHECK/migration) ranks into testsToRun. Scored 0.6 so
    // it clears minScore and outranks a same-named unit test's name-affinity link.
    if (targetIsInfraPersistence && targetNormalized && isIntegrationTestPath(testFile)) {
      addScore(targetNormalized, 0.6, "infrastructure_integration_priority");
    }

    const scored = [...sourceScoreMap.entries()]
      .map(([sourceFile, v]) => ({
        testFile,
        sourceFile,
        score: Math.min(1, Number(v.score.toFixed(4))),
        reasons: [...v.reasons]
      }))
      .filter((x) => x.score >= minScore)
      .sort((a, b) => b.score - a.score || a.sourceFile.localeCompare(b.sourceFile));

    // MCP-ISSUE-058(c): `filePath` seeded the TEST candidate set but never constrained the answer, so
    // asking about `Domain/Entities/Conversation.cs` returned 20 repo-wide pairs of which exactly one
    // involved the requested file — every selected test had been paired with its OWN best source.
    // When the caller names a source file, that file is the anchor, not a hint.
    //
    // Applied HERE, inside the loop (code review 2026-08-10). As a post-loop filter it ran after two
    // things had already thrown the anchor away: `slice(0, maxCandidates)` — default 3 — could drop
    // the anchored pair in favour of a test's own better-scoring source, and `output.length >= limit`
    // could break out before a later test file contributed the only anchored pair at all. The
    // symptom was `link_tests_to_source(filePath: X)` answering "no covering tests" for a file that
    // has them, which `change_impact` then reports as `residualRisk.untestedChangedFiles`.
    const ranked = (anchorSourceFile ? scored.filter((x) => normalizePath(x.sourceFile) === anchorSourceFile) : scored)
      .slice(0, maxCandidates);

    output.push(...ranked);
    // Only rows that survived the anchor count toward `limit` — that is the whole point of moving it.
    if (output.length >= limit) {
      break;
    }
  }

  return output.slice(0, limit);
}
