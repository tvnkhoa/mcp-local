import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveResponseProfile } from "../responseFormatter.js";
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

  if (profile === "nano") {
    const topSymbols = rows.slice(0, 10).map((x) => ({ name: x.name, kind: x.kind, filePath: x.filePath, line: x.line }));
    return ctx.asText({ repoId: args.repoId, count: rows.length, topSymbols, hasMore: rows.length > topSymbols.length, suppressed: scan.suppressed, scanPolicy: scan.scanPolicy }, profile);
  }
  if (profile === "compact") {
    return ctx.asText({ repoId: args.repoId, count: rows.length, suppressed: scan.suppressed, scanPolicy: scan.scanPolicy, symbols: rows.map((x) => ({ symbolId: x.symbolId, name: x.name, kind: x.kind, filePath: x.filePath, line: x.line, deadReason: x.deadReason })) }, profile);
  }
  return ctx.asText({ repoId: args.repoId, count: rows.length, suppressed: scan.suppressed, scanPolicy: scan.scanPolicy, symbols: rows }, profile);
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
  args: { repoId: string; filePathPrefix?: string; kind?: string; limit: number },
  ctx: HandlerContext
): CallToolResult {
  const entries = ctx.store.findEntryPoints(args.repoId, args.filePathPrefix ?? null, args.kind ?? null, args.limit);
  return ctx.asText({
    repoId: args.repoId,
    total: entries.length,
    runtimeEntryPoints: entries.filter((e) => e.entryReason === "bootstrap_file"),
    graphEntryPoints: entries.filter((e) => e.entryReason === "uncalled_symbol"),
    entryPoints: entries
  });
}

// ── find_implementations ──────────────────────────────────────────────────────

export function handleFindImplementations(
  args: { repoId: string; interfaceName: string; limit: number },
  ctx: HandlerContext
): CallToolResult {
  return ctx.asText(ctx.store.findImplementations(args.repoId, args.interfaceName, args.limit));
}

// ── link_tests_to_source ──────────────────────────────────────────────────────

export function handleLinkTestsToSource(
  args: { repoId: string; filePath?: string; limit: number; maxCandidates: number; minScore: number; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  const links = store.linkTestsToSource(args.repoId, args.filePath ?? null, args.limit, args.maxCandidates, args.minScore);
  if (profile === "nano") {
    const topLinks = links.slice(0, 10).map((x) => ({ testFile: x.testFile, sourceFile: x.sourceFile, score: x.score }));
    return ctx.asText({ repoId: args.repoId, count: links.length, topLinks, hasMore: links.length > topLinks.length }, profile);
  }
  if (profile === "compact") {
    return ctx.asText({ repoId: args.repoId, count: links.length, links: links.map((x) => ({ testFile: x.testFile, sourceFile: x.sourceFile, score: x.score, reasons: x.reasons })) }, profile);
  }
  return ctx.asText({ repoId: args.repoId, count: links.length, links }, profile);
}
