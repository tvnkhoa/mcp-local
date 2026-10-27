import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveResponseProfile } from "../../middleware/responseFormatter.js";
import { buildCoverageBlock } from "../../middleware/coverage.js";
import { isTestPath } from "../../services/indexing/fileFilter.js";
import { readWorkingTreeState } from "../../services/git/gitHelpers.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { HandlerContext } from "./handlerContext.js";
import { dropTestRows } from "./testFilter.js";

// ── dead_code_scan ────────────────────────────────────────────────────────────

export function handleDeadCodeScan(
  args: {
    repoId: string;
    filePathPrefix?: string;
    language?: string;
    kind?: string;
    includePrivate: boolean;
    limit: number;
    profile: string;
  },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  const scan = store.getDeadCodeCandidates(
    args.repoId,
    args.filePathPrefix ?? null,
    args.language ?? null,
    args.kind ?? null,
    args.includePrivate,
    args.limit
  );
  const rows = scan.candidates;

  // No candidates and nothing suppressed → likely thin graph coverage, not a clean bill of health.
  const emptyHint =
    rows.length === 0 && scan.suppressed.total === 0
      ? { hint: "no dead-code candidates and nothing suppressed — this can also mean call/import edges are unresolved; cross-check a suspect symbol with get_call_chain or find_entry_points before assuming all code is live." }
      : {};

  if (profile === "nano") {
    const topSymbols = rows.slice(0, 10).map((x) => ({ name: x.name, kind: x.kind, filePath: x.filePath, line: x.line }));
    return ctx.asText({ repoId: args.repoId, count: rows.length, topSymbols, hasMore: rows.length > topSymbols.length, suppressed: scan.suppressed, scanPolicy: scan.scanPolicy, ...emptyHint }, profile);
  }
  if (profile === "compact") {
    return ctx.asText({ repoId: args.repoId, count: rows.length, suppressed: scan.suppressed, scanPolicy: scan.scanPolicy, symbols: rows.map((x) => ({ symbolId: x.symbolId, name: x.name, kind: x.kind, filePath: x.filePath, line: x.line, deadReason: x.deadReason })), ...emptyHint }, profile);
  }
  return ctx.asText({ repoId: args.repoId, count: rows.length, suppressed: scan.suppressed, scanPolicy: scan.scanPolicy, symbols: rows, ...emptyHint }, profile);
}

// ── detect_circular_dependencies ─────────────────────────────────────────────

export function handleDetectCircularDependencies(
  args: {
    repoId: string;
    filePathPrefix?: string;
    mode: string;
    includeCalls: boolean;
    maxDepth: number;
    maxCycles: number;
    profile: string;
  },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  const result = store.detectCircularDependencies(
    args.repoId,
    args.filePathPrefix ?? null,
    args.mode as Parameters<typeof store.detectCircularDependencies>[2],
    args.includeCalls,
    args.maxDepth,
    args.maxCycles
  );
  if (profile === "nano") {
    const topCycles = result.cycles.slice(0, 5).map((c) => ({ path: c.path, length: c.length }));
    return ctx.asText({ repoId: args.repoId, mode: result.mode, cycleCount: result.cycleCount, topCycles }, profile);
  }
  if (profile === "compact") {
    return ctx.asText({ repoId: args.repoId, mode: result.mode, cycleCount: result.cycleCount, cycles: result.cycles.map((c) => ({ path: c.path, edgeTypes: c.edgeTypes, length: c.length })) }, profile);
  }
  return ctx.asText({ repoId: args.repoId, ...result }, profile);
}

// ── find_entry_points ─────────────────────────────────────────────────────────

export function handleFindEntryPoints(
  args: { repoId: string; filePathPrefix?: string; kind?: string; limit: number; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  const entries = ctx.store.findEntryPoints(args.repoId, args.filePathPrefix ?? null, args.kind ?? null, args.limit);
  const runtimeEntryPoints = entries.filter((e) => e.entryReason === "bootstrap_file");
  const graphEntryPoints = entries.filter((e) => e.entryReason === "uncalled_symbol");
  // MCP-ISSUE-044: the route fast-path stamps a THIRD `entryReason` ("route_handler"), which matched
  // neither array above — so `kind:"route_handler"` returned a non-zero `total` with two empty arrays
  // and nothing downstream could act on it. Route rows get their own array, and `total` is now derived
  // from what is actually emitted, so a fourth reason cannot reintroduce the same silent hole.
  const routeEntryPoints = entries.filter((e) => e.entryReason === "route_handler");
  const emitted = [...runtimeEntryPoints, ...graphEntryPoints, ...routeEntryPoints];
  const unclassified = entries.filter((e) => !emitted.includes(e));
  // `entryPoints` is just runtime+graph concatenated; drop the duplicate in token-lean profiles
  // (nano/compact) and keep it only in standard/verbose for backward compatibility.
  const includeFlat = profile === "standard" || profile === "verbose";
  return ctx.asText({
    repoId: args.repoId,
    total: emitted.length + unclassified.length,
    runtimeEntryPoints,
    graphEntryPoints,
    ...(routeEntryPoints.length > 0 && { routeEntryPoints }),
    ...(unclassified.length > 0 && { unclassifiedEntryPoints: unclassified }),
    ...(includeFlat && { entryPoints: entries })
  }, profile);
}

// ── find_implementations ──────────────────────────────────────────────────────

export function handleFindImplementations(
  args: { repoId: string; interfaceName: string; limit: number; excludeTests: boolean; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  const rowsRaw = ctx.store.findImplementations(args.repoId, args.interfaceName, args.limit);
  // MCP-ISSUE-049: on a C# repo the test doubles are usually the MAJORITY of implementations
  // (2 of 3 in the filed case), so without this the caller had to eyeball the paths every time.
  const rows = args.excludeTests ? rowsRaw.filter((x) => !isTestPath(x.filePath)) : rowsRaw;

  // When no implementations resolve, surface similar indexed interface names as hints.
  // Covers typos and C#-only gating (e.g. querying a TS type, or "IUserRepo" vs "IUserRepository").
  const didYouMean: string[] =
    rows.length === 0 ? ctx.store.findSimilarInterfaceNames(args.repoId, args.interfaceName, 10) : [];
  const emptyHint =
    rows.length === 0
      ? {
          hint: "no implementations found — IMPLEMENTS edges are emitted by the C# extractor only, so a TypeScript `class X implements Y` is not yet recorded; verify the interface name (see didYouMean) or that the repo contains C# implementations.",
          didYouMean
        }
      : {};

  // MCP-ISSUE-074: a Vue component implements nothing — say so rather than return an empty list that
  // reads like a missing IMPLEMENTS edge, and name the relation that does answer "who uses it".
  const components =
    rows.length === 0
      ? ctx.store
          .getSymbolCandidates(args.repoId, args.interfaceName.replace(/\.vue$/i, ""), 5, "name", { kind: "component" })
          .filter((c) => c.kind === "component")
      : [];
  if (components.length > 0) {
    return ctx.asText(
      {
        repoId: args.repoId,
        interfaceName: args.interfaceName,
        count: 0,
        notApplicable:
          `'${args.interfaceName}' is a Vue component, not an interface: find_implementations is not applicable for a Vue component (components have no IMPLEMENTS relation). ` +
          `Who renders it is a USES_COMPONENT edge — use find_impact_files(filePath) or get_call_chain(symbolId, direction: "callers") on the component symbol.`,
        components: components.map((c) => ({ symbolId: c.symbolId, name: c.name, kind: c.kind, filePath: c.filePath, line: c.line }))
      },
      profile
    );
  }

  const coverage = buildCoverageBlock({
    resultCount: rows.length,
    expectedNonZero: true,
    kind: "implementations",
    query: args.interfaceName
  });

  if (profile === "nano") {
    const top = rows.slice(0, 10).map((x) => ({ name: x.name, kind: x.kind, filePath: x.filePath, line: x.line }));
    return ctx.asText(
      { repoId: args.repoId, interfaceName: args.interfaceName, count: rows.length, top, hasMore: rows.length > top.length, coverage: coverage.confidence, ...emptyHint },
      profile
    );
  }
  return ctx.asText(
    { repoId: args.repoId, interfaceName: args.interfaceName, count: rows.length, implementations: rows, coverage, ...emptyHint },
    profile
  );
}

// ── link_tests_to_source ──────────────────────────────────────────────────────

export function handleLinkTestsToSource(
  args: {
    repoId: string;
    filePath?: string;
    limit: number;
    maxCandidates: number;
    minScore?: number;
    excludeTests: boolean;
    forWorkingTreeDiff?: boolean;
    maxDepth?: number;
    maxFiles?: number;
    profile: string;
  },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  if (args.forWorkingTreeDiff === true) return handleTestsForWorkingTreeDiff(args, profile, ctx);
  const allLinks = store.linkTestsToSource(args.repoId, args.filePath ?? null, args.limit, args.maxCandidates, args.minScore ?? 0.4);
  // MCP-ISSUE-056: filter the SOURCE side only — the test side is the point of this tool. Defensive
  // rather than load-bearing: the candidate `sourceFiles` set inside the analyzer is already built as
  // `!isTestPath(x) && !isNonCodePath(x)`, so this drops nothing today. Kept so the parameter cannot
  // become a lie if that selection ever widens. It is also the one `excludeTests` site with no
  // post-LIMIT hazard, because it can never remove a row.
  const links = dropTestRows(allLinks, args.excludeTests, (x) => x.sourceFile);

  const emptyHint =
    links.length === 0
      ? { hint: "no test→source links found — the repo may have no indexed test files, tests may use a naming/folder convention the heuristics miss, or scores fell below minScore; try lowering minScore or passing an explicit test filePath." }
      : {};

  if (profile === "nano") {
    const topLinks = links.slice(0, 10).map((x) => ({ testFile: x.testFile, sourceFile: x.sourceFile, score: x.score }));
    return ctx.asText({ repoId: args.repoId, count: links.length, topLinks, hasMore: links.length > topLinks.length, ...emptyHint }, profile);
  }
  if (profile === "compact") {
    return ctx.asText({ repoId: args.repoId, count: links.length, links: links.map((x) => ({ testFile: x.testFile, sourceFile: x.sourceFile, score: x.score, reasons: x.reasons })), ...emptyHint }, profile);
  }
  return ctx.asText({ repoId: args.repoId, count: links.length, links, ...emptyHint }, profile);
}

// ── link_tests_to_source(forWorkingTreeDiff: true) — R11, MCP-ISSUE-080 ─────────────────────────

/** Name/score links probed per changed source file; the floor (minScore) is applied by the service. */
const DIFF_NAME_LINK_LIMIT = 50;

function handleTestsForWorkingTreeDiff(
  args: { repoId: string; filePath?: string; limit: number; maxCandidates: number; minScore?: number; maxDepth?: number; maxFiles?: number },
  profile: ReturnType<typeof resolveResponseProfile>,
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  if (args.filePath) {
    throw new McpError(ErrorCode.InvalidParams, "link_tests_to_source: filePath and forWorkingTreeDiff are exclusive — the diff names the files.");
  }
  const repo = store.getRepository(args.repoId);
  if (!repo) {
    throw new McpError(ErrorCode.InvalidParams, `link_tests_to_source: unknown repoId '${args.repoId}'. Run index_repository first.`);
  }
  let dirty: string[];
  let head: string | null;
  try {
    const tree = readWorkingTreeState(repo.repoPath);
    head = tree.head;
    // Already repoPath-relative: readWorkingTreeState strips the git root prefix (MCP-ISSUE-107).
    dirty = tree.dirty;
  } catch {
    throw new McpError(ErrorCode.InvalidParams, `link_tests_to_source: forWorkingTreeDiff needs a git working tree, and '${repo.repoPath}' is not one.`);
  }

  const minScore = args.minScore ?? 0.7;
  const sourceTokensCache = new Map<string, Set<string>>();
  const result = store.testsForWorkingTreeDiff({
    repoId: args.repoId,
    repoPath: repo.repoPath,
    dirty,
    maxDepth: args.maxDepth ?? 6,
    maxFiles: args.maxFiles ?? 2000,
    minScore,
    limit: args.limit,
    linkTests: (sourceFile) => store.linkTestsToSource(args.repoId, sourceFile, DIFF_NAME_LINK_LIMIT, args.maxCandidates, 0, sourceTokensCache)
  });
  const hint =
    dirty.length === 0
      ? { hint: "the working tree is clean: there is no diff to find tests for. Use change_impact(baseRef) for a committed range." }
      : result.testCount === 0
        ? { hint: "no test reaches the changed files through imports, components or workspace packages, and no name link clears minScore — see coverage.knownGaps before concluding they are untested." }
        : {};

  if (profile === "nano") {
    return ctx.asText(
      {
        repoId: args.repoId,
        mode: "forWorkingTreeDiff",
        changedFileCount: result.changedFiles.count,
        testCount: result.testCount,
        commands: result.runPlan.commands.map((c) => c.command),
        excludedCount: result.excluded.length,
        belowMinScore: result.belowMinScore,
        coverage: result.coverage.confidence,
        ...hint
      },
      profile
    );
  }
  return ctx.asText({ repoId: args.repoId, mode: "forWorkingTreeDiff", head, ...result, ...hint }, profile);
}
