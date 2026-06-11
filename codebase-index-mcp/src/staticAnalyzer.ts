import type Database from "better-sqlite3";
import { isTestPath } from "./fileFilter.js";

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

/**
 * C# kinds that the dead-code heuristics treat as a "class". Records (and record structs) used
 * to be indexed as `class`, so the suppression heuristics below keyed on `kind === "class"`
 * implicitly covered them; after ISSUE-015 relabeled records they must be listed explicitly or
 * record validators/attributes/services/endpoints regress to false dead-code positives.
 */
const CSHARP_CLASS_LIKE_KINDS = new Set<string>(["class", "record", "record struct"]);

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
  const sourceFiles = allPaths.filter((x) => !isTestPath(x));

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
  const selectedTests = targetNormalized
    ? (targetIsTest
        ? testFiles.filter((x) => x === targetNormalized)
        : testFiles
            .filter(
              (x) =>
                normalizeBase(x) === normalizeBase(targetNormalized) ||
                x.includes(normalizeBase(targetNormalized)) ||
                sharedTokenCoverage(testTokensOf(x), targetTokens) >= 0.5
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

    const ranked = [...sourceScoreMap.entries()]
      .map(([sourceFile, v]) => ({
        testFile,
        sourceFile,
        score: Math.min(1, Number(v.score.toFixed(4))),
        reasons: [...v.reasons]
      }))
      .filter((x) => x.score >= minScore)
      .sort((a, b) => b.score - a.score || a.sourceFile.localeCompare(b.sourceFile))
      .slice(0, maxCandidates);

    output.push(...ranked);
    if (output.length >= limit) {
      break;
    }
  }

  return output.slice(0, limit);
}

export function findEntryPoints(
  db: Database.Database,
  repoId: string,
  filePathPrefix: string | null,
  kind: string | null,
  limit: number
): { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null; entryReason: string }[] {
  // Dedicated fast-path: surface C# route handlers from the routes table
  if (kind === "route_handler") {
    const routeConditions: string[] = ["r.repo_id = ?"];
    const routeParams: unknown[] = [repoId];
    if (filePathPrefix) {
      routeConditions.push("replace(r.file_path, char(92), '/') like ?");
      routeParams.push(`${filePathPrefix.replace(/\\/g, "/")}%`);
    }
    const routeWhere = routeConditions.join(" and ");
    routeParams.push(limit);
    const routeRows = db
      .prepare(
        `
        select
          r.handler_symbol_id as symbolId,
          coalesce(hs.name, r.handler_symbol_id) as name,
          'route_handler' as kind,
          r.file_path as filePath,
          r.line as line,
          r.http_method || ' ' || r.route_template as signature
        from routes r
        left join symbols hs on hs.repo_id = r.repo_id and hs.symbol_id = r.handler_symbol_id
        where ${routeWhere}
        order by r.file_path, r.line
        limit ?
        `
      )
      .all(...routeParams) as { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string }[];
    return routeRows.map((r) => ({ ...r, entryReason: "route_handler" }));
  }

  // Tier 1: runtime bootstrap files — match regardless of path separator (Windows stores backslash)
  const bootstrapFileNames = [
    "Program.cs", "Startup.cs", "main.ts", "main.js", "index.ts", "index.js",
    "App.tsx", "App.ts", "server.ts", "server.js"
  ];
  const bootstrapOrClauses = bootstrapFileNames
    .map(() => "(replace(s.file_path, char(92), '/') like ? or replace(s.file_path, char(92), '/') = ?)")
    .join(" or ");
  const bootstrapParams = bootstrapFileNames.flatMap((f) => [`%/${f}`, f]);

  const bootstrapRows = db
    .prepare(
      `
      select distinct s.symbol_id as symbolId, s.name, s.kind, s.file_path as filePath, s.line, s.signature
      from symbols s
      where s.repo_id = ?
        and s.kind in ('module', 'function', 'method', 'class', 'record', 'record struct')
        and (${bootstrapOrClauses})
      order by s.file_path, s.line
      limit ?
      `
    )
    .all(repoId, ...bootstrapParams, Math.min(limit, 20)) as {
      symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null;
    }[];

  const bootstrapResults = bootstrapRows.map((r) => ({ ...r, entryReason: "bootstrap_file" }));
  const remaining = limit - bootstrapResults.length;

  if (remaining <= 0) {
    return bootstrapResults;
  }

  // Tier 2: uncalled public symbols (no incoming CALLS edges)
  const conditions: string[] = [
    "s.repo_id = ?",
    "s.kind not in ('module', 'property', 'constructor', 'type')"
  ];
  const params: unknown[] = [repoId];

  if (filePathPrefix) {
    conditions.push("replace(s.file_path, char(92), '/') like ?");
    params.push(`${filePathPrefix.replace(/\\/g, "/")}%`);
  }
  if (kind) {
    conditions.push("s.kind = ?");
    params.push(kind);
  }

  // Exclude symbols already in bootstrap results
  const bootstrapIds = bootstrapResults.map((r) => r.symbolId);
  if (bootstrapIds.length > 0) {
    const bph = bootstrapIds.map(() => "?").join(", ");
    conditions.push(`s.symbol_id not in (${bph})`);
    params.push(...bootstrapIds);
  }

  const where = conditions.join(" and ");
  params.push(repoId, remaining);

  const uncalledRows = db
    .prepare(
      `
      select s.symbol_id as symbolId, s.name, s.kind, s.file_path as filePath, s.line, s.signature
      from symbols s
      where ${where}
        and not exists (
          select 1 from edges e
          where e.repo_id = ? and e.type = 'CALLS' and e.to_id = s.symbol_id
        )
      order by s.file_path, s.line
      limit ?
      `
    )
    .all(...params) as { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null }[];

  const uncalledResults = uncalledRows.map((r) => ({ ...r, entryReason: "uncalled_symbol" }));

  // Filter out well-known bootstrap function/method names that are never called by other code
  // but are conventional entry points or lifecycle hooks — not truly dead code.
  const bootstrapFunctionNames = new Set([
    "main", "bootstrap", "setup", "configure", "init", "start", "boot",
    "run", "launch", "startup", "initialize", "teardown", "cleanup", "shutdown",
    "onLoad", "onReady", "afterAll", "beforeAll", "afterEach", "beforeEach"
  ]);
  const filteredResults = uncalledResults.filter(
    (r) => !bootstrapFunctionNames.has(r.name) && !bootstrapFunctionNames.has(r.name.toLowerCase())
  );

  return [...bootstrapResults, ...filteredResults];
}

export function findImplementations(
  db: Database.Database,
  repoId: string,
  interfaceName: string,
  limit: number
): { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null }[] {
  // Find resolved IMPLEMENTS edges (toId = symbolId of interface)
  const targets = db
    .prepare(`select symbol_id as symbolId from symbols where repo_id = ? and name = ? and kind = 'interface'`)
    .all(repoId, interfaceName) as { symbolId: string }[];

  // Also check unresolved iface: placeholder edges
  const rows: { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null }[] = [];

  if (targets.length > 0) {
    const ph = targets.map(() => "?").join(",");
    const fromResolved = db
      .prepare(
        `
        select distinct s.symbol_id as symbolId, s.name, s.kind, s.file_path as filePath, s.line, s.signature
        from edges e
        inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
        where e.repo_id = ? and e.type = 'IMPLEMENTS' and e.to_id in (${ph})
        order by s.file_path, s.line
        limit ?
        `
      )
      .all(repoId, ...targets.map((t) => t.symbolId), limit) as { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null }[];
    rows.push(...fromResolved);
  }

  // Also check unresolved iface: placeholders
  const fromUnresolved = db
    .prepare(
      `
      select distinct s.symbol_id as symbolId, s.name, s.kind, s.file_path as filePath, s.line, s.signature
      from edges e
      inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
      where e.repo_id = ? and e.type = 'IMPLEMENTS' and e.to_id = ?
      order by s.file_path, s.line
      limit ?
      `
    )
    .all(repoId, `iface:${interfaceName}`, limit) as { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null }[];

  for (const r of fromUnresolved) {
    if (!rows.some((existing) => existing.symbolId === r.symbolId)) {
      rows.push(r);
    }
  }

  return rows.slice(0, limit);
}

/**
 * Suggest indexed interface names similar to a (likely mistyped or unindexed) name.
 * Used by find_implementations to surface a "did you mean" list when an exact match
 * yields zero implementations — mirrors findSimilarPackageContractIds for packages.
 * Matches case-insensitively on substring (covers prefix/suffix/typo-adjacent names).
 */
export function findSimilarInterfaceNames(
  db: Database.Database,
  repoId: string,
  interfaceName: string,
  limit: number
): string[] {
  const needle = `%${interfaceName.trim()}%`;
  const rows = db
    .prepare(
      `select distinct name from symbols
       where repo_id = ? and kind = 'interface' and name like ? collate nocase and name != ?
       order by length(name), name
       limit ?`
    )
    .all(repoId, needle, interfaceName, limit) as { name: string }[];
  return rows.map((r) => r.name);
}

export function detectCircularDependencies(
  db: Database.Database,
  repoId: string,
  filePathPrefix: string | null,
  mode: "module" | "symbol",
  includeCalls: boolean,
  maxDepth: number,
  maxCycles: number
): {
  mode: "module" | "symbol";
  cycleCount: number;
  cycles: { path: string[]; edgeTypes: string[]; length: number }[];
} {
  const edgeTypes = includeCalls ? ["IMPORTS", "DEPENDS_ON", "CALLS"] : ["IMPORTS", "DEPENDS_ON"];
  const edgePlaceholders = edgeTypes.map(() => "?").join(", ");
  const params: unknown[] = [repoId, ...edgeTypes];

  let rows: { fromId: string; toId: string; edgeType: string }[];
  if (mode === "module") {
    let filterSql = "";
    if (filePathPrefix) {
      filterSql = " and (replace(sf.file_path, char(92), '/') like ? or replace(st.file_path, char(92), '/') like ?)";
      const prefix = `${filePathPrefix.replace(/\\/g, "/")}%`;
      params.push(prefix, prefix);
    }

    rows = db
      .prepare(
        `
        select distinct
          replace(sf.file_path, char(92), '/') as fromId,
          replace(st.file_path, char(92), '/') as toId,
          e.type as edgeType
        from edges e
        inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
        inner join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
        where e.repo_id = ?
          and e.type in (${edgePlaceholders})
          and sf.file_path is not null
          and st.file_path is not null
          and sf.file_path != st.file_path
          ${filterSql}
        limit 50000
        `
      )
      .all(...params) as { fromId: string; toId: string; edgeType: string }[];
  } else {
    let filterSql = "";
    if (filePathPrefix) {
      filterSql = " and (replace(sf.file_path, char(92), '/') like ? or replace(st.file_path, char(92), '/') like ?)";
      const prefix = `${filePathPrefix.replace(/\\/g, "/")}%`;
      params.push(prefix, prefix);
    }

    rows = db
      .prepare(
        `
        select distinct
          e.from_id as fromId,
          e.to_id as toId,
          e.type as edgeType
        from edges e
        inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
        inner join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
        where e.repo_id = ?
          and e.type in (${edgePlaceholders})
          ${filterSql}
        limit 50000
        `
      )
      .all(...params) as { fromId: string; toId: string; edgeType: string }[];
  }

  const adjacency = new Map<string, { to: string; edgeType: string }[]>();
  for (const row of rows) {
    if (row.fromId === row.toId) {
      continue;
    }
    const list = adjacency.get(row.fromId) ?? [];
    list.push({ to: row.toId, edgeType: row.edgeType });
    adjacency.set(row.fromId, list);
  }

  const nodes = [...adjacency.keys()].sort();
  const seen = new Set<string>();
  const cycles: { path: string[]; edgeTypes: string[]; length: number }[] = [];

  const canonicalCycleKey = (core: string[]): string => {
    const candidates: string[] = [];
    const n = core.length;
    for (let i = 0; i < n; i++) {
      const rotated = [...core.slice(i), ...core.slice(0, i)].join("->");
      candidates.push(rotated);
    }
    const reversed = [...core].reverse();
    for (let i = 0; i < n; i++) {
      const rotated = [...reversed.slice(i), ...reversed.slice(0, i)].join("->");
      candidates.push(rotated);
    }
    candidates.sort();
    return candidates[0] ?? core.join("->");
  };

  const stackNodes: string[] = [];
  const stackEdgeTypes: string[] = [];

  const dfs = (start: string, current: string): void => {
    if (cycles.length >= maxCycles) {
      return;
    }

    const outgoing = adjacency.get(current) ?? [];
    for (const edge of outgoing) {
      if (cycles.length >= maxCycles) {
        return;
      }

      if (edge.to === start && stackNodes.length > 1) {
        const core = [...stackNodes];
        const key = canonicalCycleKey(core);
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push({
            path: [...core, start],
            edgeTypes: [...stackEdgeTypes, edge.edgeType],
            length: core.length
          });
        }
        continue;
      }

      if (stackNodes.includes(edge.to) || stackNodes.length >= maxDepth) {
        continue;
      }

      stackNodes.push(edge.to);
      stackEdgeTypes.push(edge.edgeType);
      dfs(start, edge.to);
      stackNodes.pop();
      stackEdgeTypes.pop();
    }
  };

  for (const start of nodes) {
    if (cycles.length >= maxCycles) {
      break;
    }
    stackNodes.length = 0;
    stackEdgeTypes.length = 0;
    stackNodes.push(start);
    dfs(start, start);
  }

  cycles.sort((a, b) => a.length - b.length || a.path.join("->").localeCompare(b.path.join("->")));
  return {
    mode,
    cycleCount: cycles.length,
    cycles
  };
}

export function getDeadCodeCandidates(
  db: Database.Database,
  repoId: string,
  filePathPrefix: string | null,
  language: string | null,
  kind: string | null,
  includePrivate: boolean,
  limit: number
): {
  candidates: {
    symbolId: string;
    name: string;
    kind: string;
    filePath: string;
    line: number;
    signature: string | null;
    language: string | null;
    incomingCalls: number;
    incomingTypeRefs: number;
    incomingImports: number;
    deadReason: string;
  }[];
  suppressed: {
    total: number;
    reasons: Record<string, number>;
  };
  scanPolicy: {
    mode: "skip_low_confidence";
    note: string;
  };
} {
  const conditions: string[] = [
    "s.repo_id = ?",
    "s.kind not in ('module', 'property', 'constructor', 'type', 'interface')"
  ];
  const params: unknown[] = [repoId];

  if (filePathPrefix) {
    conditions.push("replace(s.file_path, char(92), '/') like ?");
    params.push(`${filePathPrefix.replace(/\\/g, "/")}%`);
  }
  if (language) {
    conditions.push("coalesce(f.language, '') = ?");
    params.push(language.toLowerCase());
  }
  if (kind) {
    conditions.push("s.kind = ?");
    params.push(kind);
  }
  if (!includePrivate) {
    conditions.push("coalesce(s.signature, '') not like 'private %'");
    conditions.push("s.name not like '_%'");
  }

  const where = conditions.join(" and ");
  const stmt = db.prepare(
    `
    select
      s.symbol_id as symbolId,
      s.name as name,
      s.kind as kind,
      s.file_path as filePath,
      s.line as line,
      s.signature as signature,
      f.language as language,
      (select count(*)
         from edges e
        where e.repo_id = s.repo_id
          and e.type = 'CALLS'
          and (
            e.to_id = s.symbol_id
            or e.to_id = ('callee:' || s.name)
          )) as incomingCalls,
      (select count(*)
         from edges e
        where e.repo_id = s.repo_id
          and e.type = 'TYPE_REF'
          and (
            e.to_id = s.symbol_id
            or e.to_id = ('type:' || s.name)
          )) as incomingTypeRefs,
      (select count(*) from edges e where e.repo_id = s.repo_id and e.to_id = s.symbol_id and e.type = 'IMPORTS') as incomingImports,
      (select count(*) from edges e where e.repo_id = s.repo_id and e.to_id = s.symbol_id and e.type = 'PUBLISHES') as incomingPublishes,
      (select count(*) from edges e where e.repo_id = s.repo_id and e.from_id = s.symbol_id and e.type = 'CALLS') as outgoingCalls,
      (
        select count(*)
        from edges e
        inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
        inner join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
        where e.repo_id = s.repo_id
          and st.file_path = s.file_path
          and sf.file_path != st.file_path
          and e.type in ('CALLS', 'IMPORTS', 'TYPE_REF')
      ) as fileIncomingUsages
    from symbols s
    left join files f on f.repo_id = s.repo_id and f.path = s.file_path
    where ${where}
    order by s.file_path, s.line
    limit ? offset ?
    `
  );
  const chunkSize = Math.max(limit * 3, 100);
  const rows: {
    symbolId: string;
    name: string;
    kind: string;
    filePath: string;
    line: number;
    signature: string | null;
    language: string | null;
    incomingCalls: number;
    incomingTypeRefs: number;
    incomingImports: number;
    incomingPublishes: number;
    outgoingCalls: number;
    fileIncomingUsages: number;
  }[] = [];
  for (let offset = 0; ; offset += chunkSize) {
    const batch = stmt.all(...params, chunkSize, offset) as {
      symbolId: string;
      name: string;
      kind: string;
      filePath: string;
      line: number;
      signature: string | null;
      language: string | null;
      incomingCalls: number;
      incomingTypeRefs: number;
      incomingImports: number;
      incomingPublishes: number;
      outgoingCalls: number;
      fileIncomingUsages: number;
    }[];
    if (batch.length === 0) {
      break;
    }
    rows.push(...batch);
    if (batch.length < chunkSize) {
      break;
    }
  }

  const bootstrapFileNames = [
    "Program.cs", "Startup.cs", "main.ts", "main.js", "index.ts", "index.js",
    "App.tsx", "App.ts", "server.ts", "server.js"
  ];

  const results: {
    symbolId: string;
    name: string;
    kind: string;
    filePath: string;
    line: number;
    signature: string | null;
    language: string | null;
    incomingCalls: number;
    incomingTypeRefs: number;
    incomingImports: number;
    deadReason: string;
  }[] = [];
  const suppressedReasons = new Map<string, number>();
  const recordSuppressed = (reason: string) => {
    suppressedReasons.set(reason, (suppressedReasons.get(reason) ?? 0) + 1);
  };

  const utilityNamePattern = /^(to|from|get|set|map|parse|format|build|create|validate|convert|helper|util)/i;
  const entryNamePattern = /^(main|init|initialize|bootstrap|start|run|handle|on|process|execute|dispatch|trigger)/i;
  const csharpUtilityClassNamePattern = /(extractor|helper|extensions|codec|composer|factory|builder|parser|formatter|normalizer|provider)$/i;
  const csharpConstantContainerNamePattern = /(constants?|errorcodes|statuscodes|codes|types|keys|outcomes|reasons|roles|policies|claimtypes|headernames|items)$/i;
  const csharpUtilityMethodNamePattern = /^(create|build|compose|format|normalize|parse|tryparse|failure|success|from|to)/i;
  const csharpValidatorHelperMethodNamePattern = /^(be|have|is|can|should|must|tryparse|normalize|format|supports?)/i;

  const fileContexts = new Map<string, {
    hasValidatorClass: boolean;
    hasInterfaceImplementationClass: boolean;
    hasAttributeClass: boolean;
    hasStaticUtilityClass: boolean;
    hasServiceLikeClass: boolean;
    isConstantContainerFile: boolean;
  }>();

  for (const row of rows) {
    if ((row.language ?? "").toLowerCase() !== "csharp" || !CSHARP_CLASS_LIKE_KINDS.has(row.kind)) {
      continue;
    }

    const signatureLower = (row.signature ?? "").toLowerCase();
    const fileContext = fileContexts.get(row.filePath) ?? {
      hasValidatorClass: false,
      hasInterfaceImplementationClass: false,
      hasAttributeClass: false,
      hasStaticUtilityClass: false,
      hasServiceLikeClass: false,
      isConstantContainerFile: false
    };
    const normalizedPath = row.filePath.replace(/\\/g, "/").toLowerCase();

    if (
      /validator$/i.test(row.name) ||
      signatureLower.includes("abstractvalidator<") ||
      signatureLower.includes("ivalidator<")
    ) {
      fileContext.hasValidatorClass = true;
    }

    if (
      /(?:public|internal)(?:\s+(?:sealed|abstract|partial|static))*\s+class\s+/i.test(row.signature ?? "") &&
      /\s:\s*i[a-z]/.test(signatureLower) &&
      !/\s:\s*attribute\b/.test(signatureLower)
    ) {
      fileContext.hasInterfaceImplementationClass = true;
    }

    if (/attribute$/i.test(row.name) || /\s:\s*attribute\b/.test(signatureLower)) {
      fileContext.hasAttributeClass = true;
    }

    if (
      /(public|internal|file) static class /i.test(row.signature ?? "") &&
      (
        csharpUtilityClassNamePattern.test(row.name) ||
        csharpConstantContainerNamePattern.test(row.name)
      )
    ) {
      fileContext.hasStaticUtilityClass = true;
    }

    if (
      /(service|resolver|worker)$/i.test(row.name) ||
      /:\s*backgroundservice\b/.test(signatureLower)
    ) {
      fileContext.hasServiceLikeClass = true;
    }

    if (normalizedPath.includes("/constants/")) {
      fileContext.isConstantContainerFile = true;
    }

    fileContexts.set(row.filePath, fileContext);
  }

  const isLikelyEntryPoint = (row: {
    kind: string;
    name: string;
    filePath: string;
    signature: string | null;
    language: string | null;
    outgoingCalls: number;
  }): boolean => {
    // Keep the heuristic narrow to reduce cross-language false negatives.
    if ((row.language ?? "").toLowerCase() !== "csharp") {
      return false;
    }

    if (row.outgoingCalls < 2) {
      return false;
    }

    const normalizedPath = row.filePath.replace(/\\/g, "/").toLowerCase();
    const signatureLower = (row.signature ?? "").toLowerCase();
    const name = row.name;
    const fileContext = fileContexts.get(row.filePath) ?? {
      hasValidatorClass: false,
      hasInterfaceImplementationClass: false,
      hasAttributeClass: false,
      hasStaticUtilityClass: false,
      hasServiceLikeClass: false,
      isConstantContainerFile: false
    };

    const hasEntryName = entryNamePattern.test(name);
    const hasUtilityName = utilityNamePattern.test(name);
    const inEntryPath =
      normalizedPath.endsWith("/program.cs") ||
      normalizedPath.endsWith("/startup.cs") ||
      normalizedPath.includes("/controllers/") ||
      normalizedPath.includes("/handlers/") ||
      normalizedPath.includes("/hubs/") ||
      normalizedPath.includes("/backgroundservices/") ||
      normalizedPath.includes("/hostedservices/") ||
      normalizedPath.includes("/api/");
    const isPublicLike = signatureLower.startsWith("public ") || signatureLower.includes(" public ");

    // Lightweight score inspired by GitNexus entry-point scoring:
    // require outgoing calls, then combine path/name/visibility hints.
    let score = 0;
    if (isPublicLike) score += 1;
    if (hasEntryName) score += 1;
    if (inEntryPath) score += 1;
    if (row.outgoingCalls >= 3) score += 1;
    if (hasUtilityName) score -= 1;

    return score >= 2 && (hasEntryName || inEntryPath);
  };

  const getCSharpSuppressionReason = (row: {
    kind: string;
    name: string;
    filePath: string;
    signature: string | null;
    language: string | null;
    outgoingCalls: number;
    fileIncomingUsages: number;
  }): string | null => {
    if ((row.language ?? "").toLowerCase() !== "csharp") {
      return null;
    }

    const normalizedPath = row.filePath.replace(/\\/g, "/").toLowerCase();
    const signatureLower = (row.signature ?? "").toLowerCase();
    const name = row.name;
    const fileContext = fileContexts.get(row.filePath) ?? {
      hasValidatorClass: false,
      hasInterfaceImplementationClass: false,
      hasAttributeClass: false,
      hasStaticUtilityClass: false,
      hasServiceLikeClass: false,
      isConstantContainerFile: false
    };

    const isExtensionMethod =
      row.kind === "method" && /\(\s*this\s+/i.test(row.signature ?? "");
    if (isExtensionMethod) {
      return "heuristic_runtime_or_convention_usage";
    }

    const isMigrationOrDesignerArtifact =
      normalizedPath.includes("/migrations/") ||
      normalizedPath.endsWith(".designer.cs");
    if (isMigrationOrDesignerArtifact) {
      return "heuristic_runtime_or_convention_usage";
    }

    const isValidatorClass =
      CSHARP_CLASS_LIKE_KINDS.has(row.kind) && (
        normalizedPath.includes("/validators/") ||
        /validator$/i.test(name) ||
        signatureLower.includes("abstractvalidator<") ||
        signatureLower.includes("ivalidator<")
      );
    if (isValidatorClass) {
      return "heuristic_runtime_or_convention_usage";
    }

    const isValidatorHelperMethod =
      row.kind === "method" &&
      fileContext.hasValidatorClass &&
      signatureLower.startsWith("private ") &&
      csharpValidatorHelperMethodNamePattern.test(name);
    if (isValidatorHelperMethod) {
      return "heuristic_runtime_or_convention_usage";
    }

    const fileName = normalizedPath.split("/").pop() ?? "";
    const isInterfaceContractMethod =
      row.kind === "method" && (
        normalizedPath.includes("/interfaces/") ||
        normalizedPath.includes("/contracts/") ||
        normalizedPath.includes("/abstractions/") ||
        /^i[a-z].*\.cs$/.test(fileName)
      );
    if (isInterfaceContractMethod) {
      return "heuristic_contract_declaration";
    }

    const isAbstractContractMethod =
      row.kind === "method" && (
        signatureLower.startsWith("public abstract ") ||
        signatureLower.startsWith("protected abstract ") ||
        /abstractions?\.cs$/.test(fileName)
      );
    if (isAbstractContractMethod) {
      return "heuristic_contract_declaration";
    }

    const isInterfaceImplementationClass =
      CSHARP_CLASS_LIKE_KINDS.has(row.kind) &&
      fileContext.hasInterfaceImplementationClass &&
      /(?:public|internal)(?:\s+(?:sealed|abstract|partial|static))*\s+class\s+/i.test(row.signature ?? "");
    if (isInterfaceImplementationClass) {
      return "heuristic_runtime_or_convention_usage";
    }

    const isInterfaceImplementationMethod =
      row.kind === "method" &&
      fileContext.hasInterfaceImplementationClass &&
      signatureLower.startsWith("public ") &&
      !signatureLower.includes(" static ");
    if (isInterfaceImplementationMethod) {
      return "heuristic_runtime_or_convention_usage";
    }

    const isReflectionTargetInInterfaceImplementationFile =
      row.kind === "method" &&
      fileContext.hasInterfaceImplementationClass &&
      signatureLower.startsWith("private ") &&
      /(internal|handle|resolve|publish|send|map|serialize|execute|observe)/i.test(name);
    if (isReflectionTargetInInterfaceImplementationFile) {
      return "heuristic_runtime_or_convention_usage";
    }

    const isAttributeClass =
      CSHARP_CLASS_LIKE_KINDS.has(row.kind) &&
      fileContext.hasAttributeClass &&
      (/attribute$/i.test(name) || /\s:\s*attribute\b/.test(signatureLower));
    if (isAttributeClass) {
      return "heuristic_runtime_or_convention_usage";
    }

    const isServiceLikeClass =
      CSHARP_CLASS_LIKE_KINDS.has(row.kind) &&
      fileContext.hasServiceLikeClass &&
      /(service|resolver|worker)$/i.test(name);
    if (isServiceLikeClass) {
      return "heuristic_runtime_or_convention_usage";
    }

    const isFrameworkRegisteredClass =
      CSHARP_CLASS_LIKE_KINDS.has(row.kind) &&
      (
        /(interceptor|authorizationhandler|initiali[sz]er|hostoptions|options)$/i.test(name) ||
        normalizedPath.includes("/interceptors/")
      );
    if (isFrameworkRegisteredClass) {
      return "heuristic_runtime_or_convention_usage";
    }

    const isServiceLikeMethod =
      row.kind === "method" &&
      fileContext.hasServiceLikeClass &&
      (
        signatureLower.startsWith("public ") ||
        signatureLower.startsWith("protected override ") ||
        signatureLower.startsWith("private ")
      ) &&
      /(apply|get|resolve|execute|purge|map|serialize|handle|send|publish)/i.test(name);
    if (isServiceLikeMethod) {
      return "heuristic_runtime_or_convention_usage";
    }

    const isFrameworkRegisteredMethod =
      row.kind === "method" &&
      (
        /(interceptor|authorizationhandler|initiali[sz]er|hostoptions|options)/i.test(fileName) ||
        normalizedPath.includes("/interceptors/")
      );
    if (isFrameworkRegisteredMethod) {
      return "heuristic_runtime_or_convention_usage";
    }

    // Minimal API endpoints, middleware, and OpenAPI transformers are
    // registered via convention/framework and never have direct inbound call edges.
    const isMinimalApiEndpointMethod =
      row.kind === "method" &&
      (
        normalizedPath.includes("/endpoints/") ||
        normalizedPath.includes("/middleware/")
      );
    if (isMinimalApiEndpointMethod) {
      return "heuristic_runtime_or_convention_usage";
    }

    const isMinimalApiEndpointClass =
      CSHARP_CLASS_LIKE_KINDS.has(row.kind) &&
      (
        normalizedPath.includes("/endpoints/") ||
        normalizedPath.includes("/middleware/") ||
        /(middleware|transformer|operationtransformer)$/i.test(name)
      );
    if (isMinimalApiEndpointClass) {
      return "heuristic_runtime_or_convention_usage";
    }

    const isRegistrationExtensionsClass =
      CSHARP_CLASS_LIKE_KINDS.has(row.kind) &&
      (/extensions$/i.test(name) || name === "DependencyInjection") &&
      signatureLower.startsWith("public static class ");
    if (isRegistrationExtensionsClass) {
      return "heuristic_runtime_or_convention_usage";
    }

    const isInternalStaticHelperContainerClass =
      CSHARP_CLASS_LIKE_KINDS.has(row.kind) &&
      signatureLower.includes("static class") &&
      (
        signatureLower.startsWith("public static class ") ||
        signatureLower.startsWith("internal static class ") ||
        signatureLower.startsWith("file static class ")
      ) &&
      (
        normalizedPath.includes("/extensions/") ||
        normalizedPath.includes("/helpers/") ||
        /(extractor|helper|extensions|codec|composer)$/i.test(name)
      );
    if (isInternalStaticHelperContainerClass) {
      return "heuristic_helper_container";
    }

    const isConstantContainerClass =
      CSHARP_CLASS_LIKE_KINDS.has(row.kind) &&
      (
        csharpConstantContainerNamePattern.test(name) ||
        fileContext.isConstantContainerFile
      ) &&
      signatureLower.includes("class ");

    if (isConstantContainerClass) {
      return "heuristic_runtime_or_convention_usage";
    }

    const isConstantContainerMethod =
      row.kind === "method" &&
      fileContext.isConstantContainerFile &&
      signatureLower.includes("static ");
    if (isConstantContainerMethod) {
      return "heuristic_runtime_or_convention_usage";
    }

    const isPublicStaticUtilityContainerClass =
      CSHARP_CLASS_LIKE_KINDS.has(row.kind) &&
      fileContext.hasStaticUtilityClass &&
      signatureLower.includes("static class") &&
      csharpUtilityClassNamePattern.test(name);
    if (isPublicStaticUtilityContainerClass) {
      return "heuristic_helper_container";
    }

    const isPublicStaticUtilityMethod =
      row.kind === "method" &&
      signatureLower.startsWith("public static ") &&
      csharpUtilityMethodNamePattern.test(name) &&
      (
        fileContext.hasStaticUtilityClass ||
        normalizedPath.includes("/common/") ||
        normalizedPath.includes("/models/")
      );
    if (isPublicStaticUtilityMethod) {
      return "heuristic_runtime_or_convention_usage";
    }

    const isPrivateStaticFactoryHelperMethod =
      row.kind === "method" &&
      row.outgoingCalls > 0 &&
      signatureLower.startsWith("private static ") &&
      /^(create|build|compose|resolve|map|convert|deserialize)/i.test(name) &&
      (
        /<t>/i.test(row.signature ?? "") ||
        signatureLower.includes("result<") ||
        signatureLower.includes("task<") ||
        /failure|factory|builder/i.test(name)
      );

    return isPrivateStaticFactoryHelperMethod ? "heuristic_runtime_or_convention_usage" : null;
  };

  for (const row of rows) {
    const normalizedPath = row.filePath.replace(/\\/g, "/");
    const isBootstrap = bootstrapFileNames.some((f) => normalizedPath.endsWith(`/${f}`) || normalizedPath === f);
    if (isBootstrap) {
      recordSuppressed("bootstrap_file");
      continue;
    }

    if (isLikelyEntryPoint(row)) {
      recordSuppressed("heuristic_entry_point");
      continue;
    }

    const csharpSuppressionReason = getCSharpSuppressionReason(row);
    if (csharpSuppressionReason) {
      recordSuppressed(csharpSuppressionReason);
      continue;
    }

    // incomingPublishes: a consumer reached over the message bus (ISSUE-020) is live even with
    // no static CALLS edge — counting it prevents a false dead-code flag for IConsumer<T> types.
    if ((row.incomingCalls + row.incomingTypeRefs + row.incomingImports + row.incomingPublishes) > 0) {
      continue;
    }

    results.push({
      ...row,
      deadReason: "no_incoming_calls_typerefs_imports"
    });

    if (results.length >= limit) {
      break;
    }
  }

  return {
    candidates: results,
    suppressed: {
      total: [...suppressedReasons.values()].reduce((sum, count) => sum + count, 0),
      reasons: Object.fromEntries([...suppressedReasons.entries()].sort((a, b) => a[0].localeCompare(b[0])))
    },
    scanPolicy: {
      mode: "skip_low_confidence",
      note: "Suppressed symbols are excluded from dead-code candidates because they match low-confidence runtime/convention heuristics; exclusion does not prove the symbol is live."
    }
  };
}
