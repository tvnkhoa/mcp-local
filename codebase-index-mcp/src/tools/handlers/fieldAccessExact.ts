/**
 * R3 exact — `find_field_accesses` for a TS/JS field, answered by the TypeScript LanguageService.
 *
 * The graph's TS/JS lane has property edges only for `this.<member>`, so for a Zod contract key or an
 * interface property it can give at best a lower bound (MCP-ISSUE-067). This lane resolves the field
 * with the type checker instead (`services/typeResolution/`) and answers with coverage `exact`, the
 * sites the checker cannot attribute listed by file, or — on a cap breach — coverage `gap` and no
 * list at all.
 *
 * Where it runs (release I1): in the type-resolution worker thread (`fieldWorkerClient.ts`), so a cold
 * program build never blocks this server's event loop. A call waits for its answer at most the R1
 * query budget (`CODEBASE_INDEX_QUERY_REFRESH_BUDGET_MS`); past that it answers coverage `gap`, kind
 * `building`, with no list, and the build carries on in the background.
 *
 * When it runs: the lane is on (`CODEBASE_INDEX_TS_LS_ENABLED`, default true), the repo has indexed
 * TS/JS files, and the field is a TS/JS one — a `symbolId` in a TS/JS file, or a `name` with no
 * exact-name property symbol outside TS/JS (a C# property keeps the graph answer, which is
 * receiver-typed there). A name with no property-like TS/JS declaration but a graph property also
 * falls back to the graph.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { buildTypedCoverageBlock } from "../../middleware/coverage.js";
import type { resolveResponseProfile } from "../../middleware/responseFormatter.js";
import type { StaleWarning } from "../../services/git/gitHelpers.js";
import { isTestPath } from "../../services/indexing/fileFilter.js";
import type { FieldAnswer, FieldCandidate, FieldPick, FieldSite } from "../../services/typeResolution/fieldReferences.js";
import { getFieldWorkerClient } from "../../services/typeResolution/fieldWorkerClient.js";
import type { HandlerContext } from "./handlerContext.js";

// .vue is in the family: the Vue lane indexes defineProps members as graph properties, and a .vue-only
// property must not send a TS-family field back to the graph's lower bound (release E live check).
const TS_JS_FILE = /\.(?:[cm]?[jt]sx?|vue)$/i;
const TS_JS_LANGUAGES = ["typescript", "javascript"] as const;

export type ExactFieldArgs = {
  repoId: string;
  symbolId?: string;
  name?: string;
  declarationFile?: string;
  declarationLine?: number;
  ownerName?: string;
  mode: "read" | "write" | "all";
  limit: number;
  excludeTests: boolean;
};

type TsLsConfig = NonNullable<NonNullable<HandlerContext["constants"]>["TS_LS"]>;

/** One field query, answered by the worker within the call's wait budget. */
function askWorker(cfg: TsLsConfig, input: { repoId: string; repoPath: string; runKey: string; relativeFiles: readonly string[] }, field: string, pick: FieldPick): Promise<FieldAnswer> {
  return getFieldWorkerClient().ask({
    program: input,
    field,
    pick,
    caps: { budgetMs: cfg.budgetMs, maxRssMb: cfg.maxRssMb },
    waitMs: cfg.remainingWaitMs?.() ?? cfg.waitMs ?? cfg.budgetMs
  });
}

/** The TS lane's answer, or null when the graph should answer instead. */
export async function tryExactFieldAccesses(
  args: ExactFieldArgs,
  ctx: HandlerContext,
  profile: ReturnType<typeof resolveResponseProfile>,
  staleWarning: StaleWarning | null
): Promise<CallToolResult | null> {
  const cfg = ctx.constants?.TS_LS;
  if (!cfg?.enabled) return null;
  const { store } = ctx;
  const repo = store.getRepository(args.repoId);
  if (!repo) return null;

  let field = args.name;
  let pick = { declarationFile: args.declarationFile, declarationLine: args.declarationLine, ownerName: args.ownerName };
  if (args.symbolId) {
    const symbol = store.getSymbolsByIds(args.repoId, [args.symbolId])[0];
    if (!symbol || !TS_JS_FILE.test(symbol.filePath)) return null;
    field = symbol.name;
    pick = { declarationFile: symbol.filePath.replace(/\\/g, "/"), declarationLine: symbol.line, ownerName: undefined };
  }
  if (!field) return null;
  const graphProperties = store.getSymbolCandidates(args.repoId, field, 25).filter((c) => c.kind === "property" && c.name === field);
  if (!args.symbolId && graphProperties.some((c) => !TS_JS_FILE.test(c.filePath)) && !graphProperties.some((c) => TS_JS_FILE.test(c.filePath))) return null;

  const relativeFiles = store.listIndexedFilePaths(args.repoId, TS_JS_LANGUAGES);
  if (relativeFiles.length === 0) return null;
  const answer = await askWorker(cfg, { repoId: args.repoId, repoPath: repo.repoPath, runKey: store.getLatestRun(args.repoId)?.runId ?? "none", relativeFiles }, field, cleanPick(pick));
  if (answer.status === "no_declaration" && graphProperties.length > 0) return null;
  return ctx.asText(renderAnswer(answer, args, profile, staleWarning), profile);
}

/**
 * The TS lane's raw answer for one field and pick, for callers that render it themselves
 * (`query_docs{mode:"term"}`). Null when the lane is off or the repo has no TS/JS files.
 */
export async function exactFieldAnswer(ctx: HandlerContext, repoId: string, field: string, pick: FieldPick): Promise<FieldAnswer | null> {
  const cfg = ctx.constants?.TS_LS;
  if (!cfg?.enabled) return null;
  const repo = ctx.store.getRepository(repoId);
  if (!repo) return null;
  const relativeFiles = ctx.store.listIndexedFilePaths(repoId, TS_JS_LANGUAGES);
  if (relativeFiles.length === 0) return null;
  return askWorker(cfg, { repoId, repoPath: repo.repoPath, runKey: ctx.store.getLatestRun(repoId)?.runId ?? "none", relativeFiles }, field, cleanPick(pick));
}

function cleanPick(p: { declarationFile?: string; declarationLine?: number; ownerName?: string }): { declarationFile?: string; declarationLine?: number; ownerName?: string } {
  return {
    ...(p.declarationFile !== undefined && { declarationFile: p.declarationFile }),
    ...(p.declarationLine !== undefined && { declarationLine: p.declarationLine }),
    ...(p.ownerName !== undefined && { ownerName: p.ownerName })
  };
}

function compactCandidate(c: FieldCandidate): { id: string; declarationKind: string; ownerName: string; spreadInto?: string[]; readCount: number; writeCount: number } {
  return {
    id: c.id,
    declarationKind: c.declarationKind,
    ownerName: c.ownerName,
    ...(c.spreadInto.length > 0 && { spreadInto: c.spreadInto }),
    readCount: c.readCount,
    writeCount: c.writeCount
  };
}

function renderAnswer(
  answer: FieldAnswer,
  args: ExactFieldArgs,
  profile: ReturnType<typeof resolveResponseProfile>,
  staleWarning: StaleWarning | null
): unknown {
  const stale = staleWarning ? { commitsBehind: staleWarning.commitsBehind, dirtyCount: staleWarning.dirtyCount } : null;
  const staleBlock = staleWarning ? { staleWarning } : {};
  if (answer.status === "cap_breach") {
    const coverage = buildTypedCoverageBlock({ gaps: [], breach: answer.breach });
    return { engine: answer.meta.engine, field: answer.field, readCount: null, writeCount: null, accessesWithheld: true, coverage: profile === "nano" ? coverage.confidence : coverage, typeResolution: answer.meta, ...staleBlock };
  }
  const coverage = buildTypedCoverageBlock({ gaps: answer.gaps, staleness: stale });
  const nonMatches = answer.nonMatches.length > 0 ? { nonMatches: answer.nonMatches } : {};
  const typeResolution = profile === "nano" ? { programFiles: answer.meta.programFiles, cold: answer.meta.cold, totalMs: answer.meta.totalMs } : answer.meta;

  if (answer.status === "no_declaration") {
    return {
      engine: answer.meta.engine, field: answer.field, property: null, readCount: 0, writeCount: 0,
      note: `no property-like declaration named '${answer.field}' (Zod shape key, field bag spread into a Zod shape, interface/type property, class property or accessor) exists in the repo's TS/JS program.`,
      ...nonMatches, coverage: profile === "nano" ? coverage.confidence : coverage, typeResolution, ...staleBlock
    };
  }
  if (answer.status !== "ok") {
    return {
      engine: answer.meta.engine, field: answer.field, property: null,
      ambiguity: answer.status === "ambiguous"
        ? `${String(answer.candidates.length)} different fields are declared with this name. Counts below are exact per candidate; re-ask with declarationFile (+ declarationLine) or ownerName for one candidate's sites.`
        : "the pick (declarationFile/declarationLine/ownerName) matched none of the candidates below — or more than one; narrow it.",
      candidates: profile === "verbose" ? answer.candidates : answer.candidates.map(compactCandidate),
      ...nonMatches, coverage: profile === "nano" ? coverage.confidence : coverage, typeResolution, ...staleBlock
    };
  }

  const keep = (s: FieldSite): boolean => !args.excludeTests || !isTestPath(s.file);
  const sites = answer.sites.filter(keep);
  const reads = sites.filter((s) => s.kind === "READ");
  const writes = sites.filter((s) => s.kind === "WRITE");
  const definitions = sites.filter((s) => s.kind === "DEFINITION");
  const row = (s: FieldSite): Record<string, unknown> =>
    profile === "verbose" || profile === "standard"
      ? { ...s }
      : { file: s.file, line: s.line, enclosingName: s.enclosingName, how: s.how, ...(s.viaParse && { viaParse: true }) };
  const page = (xs: FieldSite[]): FieldSite[] => xs.slice(0, args.limit);
  const truncated = reads.length > args.limit || writes.length > args.limit;
  const declaration = { ...compactCandidate(answer.selected), file: answer.selected.file, line: answer.selected.line, ...(answer.selected.aliases.length > 0 && { aliases: answer.selected.aliases }) };
  const otherCandidates = answer.candidates.filter((c) => c.id !== answer.selected.id).map(compactCandidate);

  if (profile === "nano") {
    const top = [...(args.mode !== "read" ? writes : []), ...(args.mode !== "write" ? reads : [])].slice(0, 10).map((s) => ({ kind: s.kind, file: s.file, line: s.line, enclosingName: s.enclosingName }));
    return { engine: answer.meta.engine, field: answer.field, declaration: { file: answer.selected.file, line: answer.selected.line, ownerName: answer.selected.ownerName }, readCount: reads.length, writeCount: writes.length, top, hasMore: reads.length + writes.length > top.length, gapCount: coverage.gaps.length, coverage: coverage.confidence, typeResolution, ...staleBlock };
  }
  return {
    engine: answer.meta.engine,
    field: answer.field,
    declaration,
    mode: args.mode,
    readCount: reads.length,
    writeCount: writes.length,
    ...(args.excludeTests && { excludeTests: true }),
    ...(args.mode !== "write" && { reads: page(reads).map(row) }),
    ...(args.mode !== "read" && { writes: page(writes).map(row) }),
    definitions: definitions.map((s) => ({ file: s.file, line: s.line, how: s.how })),
    ...(truncated && { truncated: true, note: `lists are capped at limit=${String(args.limit)}; the counts are complete.` }),
    ...(otherCandidates.length > 0 && { otherCandidates }),
    ...nonMatches,
    coverage,
    typeResolution,
    ...staleBlock
  };
}
