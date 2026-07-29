import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveResponseProfile } from "../response/responseFormatter.js";
import { buildCoverageBlock } from "../response/coverage.js";
import type { HandlerContext } from "./handlerContext.js";

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
  // `entryPoints` is just runtime+graph concatenated; drop the duplicate in token-lean profiles
  // (nano/compact) and keep it only in standard/verbose for backward compatibility.
  const includeFlat = profile === "standard" || profile === "verbose";
  return ctx.asText({
    repoId: args.repoId,
    total: entries.length,
    runtimeEntryPoints,
    graphEntryPoints,
    ...(includeFlat && { entryPoints: entries })
  }, profile);
}

// ── find_implementations ──────────────────────────────────────────────────────

export function handleFindImplementations(
  args: { repoId: string; interfaceName: string; limit: number; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  const rows = ctx.store.findImplementations(args.repoId, args.interfaceName, args.limit);

  // When no implementations resolve, surface similar indexed interface names as hints.
  // Covers typos and C#-only gating (e.g. querying a TS type, or "IUserRepo" vs "IUserRepository").
  const didYouMean: string[] =
    rows.length === 0 ? ctx.store.findSimilarInterfaceNames(args.repoId, args.interfaceName, 10) : [];
  const emptyHint =
    rows.length === 0
      ? {
          hint: "no implementations found — IMPLEMENTS edges require C# indexing; verify the interface name (see didYouMean) or that the repo contains C# implementations.",
          didYouMean
        }
      : {};

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
  args: { repoId: string; filePath?: string; limit: number; maxCandidates: number; minScore: number; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  const links = store.linkTestsToSource(args.repoId, args.filePath ?? null, args.limit, args.maxCandidates, args.minScore);

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
