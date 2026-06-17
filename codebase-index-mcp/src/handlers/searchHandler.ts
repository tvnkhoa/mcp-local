import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  parseGitBlamePorcelain,
  redactEmail,
  getRepoStaleness,
  buildStaleWarning
} from "../gitHelpers.js";
import { runGit } from "../gitHelpers.js";
import { resolveResponseProfile } from "../responseFormatter.js";
import { formatChangeContextPayload, buildIndexMeta } from "./impactHandler.js";
import { readSymbolSourceSpan } from "../refactorUtils.js";
import { buildCoverageBlock } from "../coverage.js";
import { isTestPath } from "../fileFilter.js";
import { RegexSearchError } from "../regexSearch.js";
import type { HandlerContext } from "./handlerContext.js";

/**
 * ISSUE-019 — A multi-word / natural-language query under strategy='name' returns 0
 * (name-search matches the whole string, not tokens). Auto-route such queries to
 * 'intent' so the agent doesn't waste a call rediscovering the right strategy.
 * Single-token identifier searches (no whitespace) keep strategy='name' exactly.
 */
function isMultiWordQuery(query: string): boolean {
  return query.trim().split(/\s+/).filter(Boolean).length > 1;
}

// ── search_symbols ────────────────────────────────────────────────────────────

export function handleSearchSymbols(
  args: {
    query: string;
    repoId?: string;
    language?: string;
    kind?: string;
    filePath?: string;
    strategy: "name" | "intent";
    limit: number;
    compact: boolean;
    profile: string;
    ranked: boolean;
    excludeTests: boolean;
  },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0], args.compact);

  // ISSUE-019: auto-route a multi-word query issued under strategy='name' to 'intent'.
  const autoRouted = args.strategy === "name" && isMultiWordQuery(args.query);
  const strategyUsed: "name" | "intent" = autoRouted ? "intent" : args.strategy;

  if (args.ranked) {
    const candidates = store.getSymbolCandidates(args.repoId ?? "", args.query, args.limit, strategyUsed, {
      kind: args.kind ?? null,
      language: args.language ?? null,
      filePath: args.filePath ?? null,
      excludeTests: args.excludeTests
    });
    const coverage = buildCoverageBlock({ resultCount: candidates.length, kind: "search", query: args.query });
    const base = { query: args.query, strategy: strategyUsed, autoRouted: autoRouted || undefined, count: candidates.length, candidates };
    return ctx.asText(profile === "nano" ? { ...base, coverage: coverage.confidence } : { ...base, coverage }, profile);
  }

  const resultsRaw = store.searchSymbols(
    args.query,
    args.repoId ?? null,
    args.language ?? null,
    args.kind ?? null,
    args.filePath ?? null,
    args.limit,
    strategyUsed
  );
  const results = args.excludeTests ? resultsRaw.filter((s) => !isTestPath(s.filePath)) : resultsRaw;
  const suggestions = results.length === 0 ? store.getSearchSuggestions(args.query, args.repoId ?? null, 5) : [];
  // When name-search still comes back empty, point the agent at the intent path explicitly.
  const suggestion =
    results.length === 0 && strategyUsed === "name"
      ? "no results under strategy='name'; retry with strategy='intent' (multi-word/natural-language queries) or check filters."
      : undefined;
  const staleness = args.repoId ? getRepoStaleness(args.repoId, store) : null;
  const coverage = buildCoverageBlock({ resultCount: results.length, kind: "search", query: args.query });

  if (profile === "nano") {
    const topSymbols = results.slice(0, 10).map((s) => ({ name: s.name, kind: s.kind, filePath: s.filePath, line: s.line }));
    return ctx.asText({ query: args.query, strategy: strategyUsed, autoRouted: autoRouted || undefined, count: results.length, topSymbols, hasMore: results.length > topSymbols.length, suggestions: suggestions.slice(0, 3), suggestion, isStale: staleness?.isStale ?? null, coverage: coverage.confidence }, profile);
  }

  if (profile === "compact") {
    return ctx.asText({ query: args.query, strategy: strategyUsed, autoRouted: autoRouted || undefined, count: results.length, symbols: results.map((s) => ({ name: s.name, kind: s.kind, filePath: s.filePath, line: s.line })), suggestions, suggestion, staleness, coverage }, profile);
  }

  if (profile === "verbose") {
    return ctx.asText({ query: args.query, strategy: strategyUsed, autoRouted: autoRouted || undefined, count: results.length, symbols: results, suggestions, suggestion, staleness, coverage, summary: { repoFilter: args.repoId ?? null, languageFilter: args.language ?? null, kindFilter: args.kind ?? null, filePathFilter: args.filePath ?? null } }, profile);
  }

  return ctx.asText({ query: args.query, strategy: strategyUsed, autoRouted: autoRouted || undefined, count: results.length, symbols: results, suggestions, suggestion, staleness, coverage }, profile);
}

// ── search_literals ───────────────────────────────────────────────────────────
// ISSUE-023 — search string-literal content ({ value, file, line, enclosingSymbol })
// so user-facing-text audits (notification titles, error messages, log templates,
// i18n sweeps) are one MCP call instead of grep + full-file reads.

export function handleSearchLiterals(
  args: { repoId: string; query: string; filePath?: string; limit: number; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  const results = store.searchLiterals(args.repoId, args.query, args.limit, args.filePath ?? null);
  const staleWarning = buildStaleWarning(args.repoId, store, "literal lines may be off vs current HEAD — re-index for exact positions.");
  const coverage = buildCoverageBlock({ resultCount: results.length, kind: "search", query: args.query });

  if (profile === "nano") {
    const top = results.slice(0, 10).map((r) => ({ value: r.value, filePath: r.filePath, line: r.line }));
    return ctx.asText({ query: args.query, count: results.length, literals: top, hasMore: results.length > top.length, coverage: coverage.confidence }, profile);
  }

  return ctx.asText(
    {
      query: args.query,
      count: results.length,
      literals: results.map((r) => ({
        value: r.value,
        filePath: r.filePath,
        line: r.line,
        kind: r.kind,
        enclosingSymbol: r.enclosingSymbol
      })),
      coverage,
      ...(staleWarning && { staleWarning })
    },
    profile
  );
}

// ── search_regex ──────────────────────────────────────────────────────────────
// Run a regex over repo source (read from disk) and return matches with context lines +
// the enclosing symbol. A first-class grep-by-pattern lane so agents stay MCP-first
// instead of falling back to baseline grep/read for arbitrary text searches.

export function handleSearchRegex(
  args: {
    repoId: string;
    pattern: string;
    regexFlags?: string;
    filePathPrefix?: string | string[];
    pathExclude?: string | string[];
    language?: string;
    excludeTests: boolean;
    scanAll: boolean;
    contextLines: number;
    limit: number;
    profile: string;
  },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);

  let result;
  try {
    result = store.searchRegex(args.repoId, {
      pattern: args.pattern,
      regexFlags: args.regexFlags,
      filePathPrefix: args.filePathPrefix,
      pathExclude: args.pathExclude,
      language: args.language,
      excludeTests: args.excludeTests,
      scanAll: args.scanAll,
      contextLines: args.contextLines,
      limit: args.limit
    });
  } catch (err) {
    const e = err as RegexSearchError;
    if (e?.code === "INVALID_PATTERN" || e?.code === "UNKNOWN_REPO") {
      throw new McpError(ErrorCode.InvalidParams, `search_regex: ${e.message}`);
    }
    throw err;
  }

  const { matches, filesScanned, truncated, truncationReason } = result;
  const staleWarning = buildStaleWarning(args.repoId, store, "match lines/text are read live from disk and are current; only enclosingSymbol is resolved from the index and may be off — re-index for accurate enclosing symbols.");
  const coverage = buildCoverageBlock({ resultCount: matches.length, kind: "search", query: args.pattern });
  const truncation = truncated ? { truncated, truncationReason } : {};

  if (profile === "nano") {
    const top = matches.slice(0, 10).map((m) => ({ filePath: m.filePath, line: m.line, matchText: m.matchText }));
    return ctx.asText(
      { pattern: args.pattern, count: matches.length, filesScanned, matches: top, hasMore: matches.length > top.length, ...truncation, coverage: coverage.confidence },
      profile
    );
  }

  if (profile === "compact") {
    return ctx.asText(
      {
        pattern: args.pattern,
        count: matches.length,
        filesScanned,
        matches: matches.map((m) => ({
          filePath: m.filePath,
          line: m.line,
          matchText: m.matchText,
          // ISSUE-027: honor contextLines in compact too — the window is already computed,
          // so triage no longer needs a follow-up get_symbol_source per hit.
          ...(args.contextLines > 0 && { beforeContext: m.beforeContext, afterContext: m.afterContext }),
          enclosingSymbol: m.enclosingSymbol
        })),
        ...truncation,
        coverage,
        ...(staleWarning && { staleWarning })
      },
      profile
    );
  }

  // standard / verbose: full context lines, column, language
  return ctx.asText(
    {
      pattern: args.pattern,
      count: matches.length,
      filesScanned,
      matches,
      ...truncation,
      coverage,
      ...(staleWarning && { staleWarning })
    },
    profile
  );
}

// ── find_symbol_at_line ───────────────────────────────────────────────────────

export function handleFindSymbolAtLine(
  args: { repoId: string; filePath: string; line: number; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  const symbol = ctx.store.findSymbolAtLine(args.repoId, args.filePath, args.line);
  return ctx.asText({ repoId: args.repoId, filePath: args.filePath, line: args.line, symbol }, profile);
}

// ── get_symbol_detail ─────────────────────────────────────────────────────────

export function handleGetSymbolDetail(
  args: { repoId: string; symbolId: string; limit: number; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  return ctx.asText(ctx.store.getSymbolDetail(args.repoId, args.symbolId, args.limit), profile);
}

// ── get_symbol_context_pack ───────────────────────────────────────────────────

export function handleGetSymbolContextPack(
  args: {
    repoId: string;
    name: string;
    callerDepth: number;
    calleeDepth: number;
    limit: number;
    profile: string;
  },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);

  const candidates = store.getSymbolCandidates(args.repoId, args.name, args.limit);
  const context = store.getContextByName(args.repoId, args.name, args.limit);
  const selectedSymbolId = context.symbol?.symbolId ?? candidates[0]?.symbolId ?? null;
  const change = selectedSymbolId ? store.getChangeContext(args.repoId, selectedSymbolId, args.callerDepth, args.calleeDepth, args.limit) : null;

  // ISSUE-021: uniform coverage signal so the CLAUDE.md fallback gate applies here too.
  const coverage = buildCoverageBlock({
    resultCount: candidates.length,
    expectedNonZero: true,
    kind: "context_pack",
    query: args.name,
    graphHealth: change?.graphHealth,
    reliabilitySummary: change?.reliabilitySummary
  });

  if (profile === "nano") {
    const topCandidates = candidates.slice(0, 5).map((x) => ({ name: x.name, kind: x.kind, filePath: x.filePath, score: x.score }));
    return ctx.asText({ queryName: args.name, selectedSymbol: context.symbol ? { name: context.symbol.name, kind: context.symbol.kind, filePath: context.symbol.filePath } : null, candidateCount: candidates.length, topCandidates, callerCount: context.callers.length, calleeCount: context.callees.length, importerCount: context.importedByFiles.length, change: change ? formatChangeContextPayload(change, "nano") : null, coverage: coverage.confidence }, profile);
  }

  if (profile === "compact") {
    return ctx.asText({ queryName: args.name, selectedSymbol: context.symbol ? { symbolId: context.symbol.symbolId, name: context.symbol.name, kind: context.symbol.kind, filePath: context.symbol.filePath, line: context.symbol.line } : null, candidates: candidates.map((x) => ({ symbolId: x.symbolId, name: x.name, kind: x.kind, filePath: x.filePath, line: x.line, score: x.score, confidence: x.confidence })), context: { callers: context.callers.map((x) => ({ callerName: x.callerName, callerFile: x.callerFile, callerLine: x.callerLine, ...(x.via ? { via: x.via } : {}) })), callees: context.callees.map((x) => ({ calleeName: x.calleeName, calleeFile: x.calleeFile, calleeLine: x.calleeLine })), importedByFiles: context.importedByFiles }, change: change ? formatChangeContextPayload(change, "compact") : null, coverage, indexMeta: buildIndexMeta(store, args.repoId) }, profile);
  }

  if (profile === "verbose") {
    return ctx.asText({ queryName: args.name, selectedSymbolId, candidates, context, change, coverage, summary: { candidateCount: candidates.length, contextMatchedCount: context.allMatchedSymbols.length, hasChangeContext: change != null }, indexMeta: buildIndexMeta(store, args.repoId) }, profile);
  }

  return ctx.asText({ queryName: args.name, selectedSymbolId, candidates, context, change, coverage, indexMeta: buildIndexMeta(store, args.repoId) }, profile);
}

// ── get_symbol_blame ──────────────────────────────────────────────────────────

export function handleGetSymbolBlame(
  args: { repoId: string; symbolId?: string; name?: string; redactEmail: boolean; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);

  let symbolId = args.symbolId;
  if (!symbolId && args.name) {
    const candidates = store.searchSymbols(args.name, args.repoId, null, null, null, 1, "name");
    symbolId = candidates[0]?.symbolId;
  }
  if (!symbolId) throw new McpError(ErrorCode.InvalidParams, "get_symbol_blame: symbol not found. Provide symbolId or a resolvable name.");

  const symbol = store.getSymbolDetail(args.repoId, symbolId, 1).symbol;
  if (!symbol) throw new McpError(ErrorCode.InvalidParams, `get_symbol_blame: symbol '${symbolId}' not found in repo '${args.repoId}'.`);

  const repo = store.getRepository(args.repoId);
  if (!repo) throw new McpError(ErrorCode.InvalidParams, `get_symbol_blame: unknown repoId '${args.repoId}'. Run index_repository first.`);

  let blameRaw: string;
  try {
    blameRaw = runGit(repo.repoPath, ["blame", "-L", `${symbol.line},${symbol.line}`, "--porcelain", "--", symbol.filePath.replace(/\\/g, "/")]);
  } catch {
    throw new McpError(ErrorCode.InvalidRequest, `get_symbol_blame: unable to run git blame for ${symbol.filePath}:${symbol.line}`);
  }

  const parsed = parseGitBlamePorcelain(blameRaw);
  const authorMail = args.redactEmail ? redactEmail(parsed.authorMail) : parsed.authorMail;

  if (profile === "nano") {
    return ctx.asText({ repoId: args.repoId, symbol: { symbolId: symbol.symbolId, name: symbol.name, filePath: symbol.filePath, line: symbol.line }, commit: parsed.commit, author: parsed.author, summary: parsed.summary }, profile);
  }

  return ctx.asText({ repoId: args.repoId, symbol, blame: { commit: parsed.commit, author: parsed.author, authorMail, authorTime: parsed.authorTime, summary: parsed.summary } }, profile);
}

// ── get_symbol_source ───────────────────────────────────────────────────────────

export function handleGetSymbolSource(
  args: { repoId: string; symbolId?: string; name?: string; contextLines: number; maxLines: number; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);

  let symbolId = args.symbolId;
  if (!symbolId && args.name) {
    symbolId = store.getSymbolCandidates(args.repoId, args.name, 1)[0]?.symbolId;
  }
  if (!symbolId) throw new McpError(ErrorCode.InvalidParams, "get_symbol_source: provide symbolId or a resolvable name.");

  const symbol = store.getSymbolDetail(args.repoId, symbolId, 1).symbol;
  if (!symbol) throw new McpError(ErrorCode.InvalidParams, `get_symbol_source: symbol '${symbolId}' not found in repo '${args.repoId}'.`);

  const repo = store.getRepository(args.repoId);
  if (!repo) throw new McpError(ErrorCode.InvalidParams, `get_symbol_source: unknown repoId '${args.repoId}'. Run index_repository first.`);

  const fallbackNextStartLine =
    symbol.endLine && symbol.endLine >= symbol.line
      ? null
      : store.getNextSymbolStartLine(args.repoId, symbol.filePath, symbol.line);
  const span = readSymbolSourceSpan(repo.repoPath, symbol.filePath, symbol.line, symbol.endLine ?? null, {
    contextLines: args.contextLines,
    maxLines: args.maxLines,
    fallbackNextStartLine
  });
  if (!span) throw new McpError(ErrorCode.InvalidRequest, `get_symbol_source: unable to read ${symbol.filePath} (file missing or empty on disk).`);

  const staleWarning = buildStaleWarning(args.repoId, store, "line numbers may be off vs current HEAD — re-index for an exact span.");

  return ctx.asText(
    {
      symbolId: symbol.symbolId,
      name: symbol.name,
      kind: symbol.kind,
      filePath: symbol.filePath,
      symbolStartLine: span.symbolStartLine,
      symbolEndLine: span.symbolEndLine,
      endLineEstimated: span.endLineEstimated,
      startLine: span.startLine,
      endLine: span.endLine,
      lineCount: span.lineCount,
      truncated: span.truncated,
      source: span.source,
      ...(staleWarning && { staleWarning })
    },
    profile
  );
}
