import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  parseGitBlamePorcelain,
  redactEmail,
  getRepoStaleness,
  buildStaleWarning
} from "../../services/git/gitHelpers.js";
import { runGit } from "../../services/git/gitHelpers.js";
import { resolveResponseProfile } from "../../middleware/responseFormatter.js";
import { formatChangeContextPayload, buildIndexMeta } from "./impactHandler.js";
import { readSymbolSourceSpan } from "../../services/refactor/refactorUtils.js";
import { buildCoverageBlock } from "../../middleware/coverage.js";
import { isTestPath } from "../../services/indexing/fileFilter.js";
import { RegexSearchError } from "../../services/search/regexSearch.js";
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

  // MCP-ISSUE-058(b): a result set that is ENTIRELY vector near-neighbours is not an answer to a name
  // query — it is a list of things that sound similar. The filed case returned 50 such rows for a
  // symbol that does not exist in the repo, at confidence "high" with no gap noted. Say it plainly,
  // and never claim "high" for a set with no index match in it.
  const fuzzyCount = results.filter((r) => r.matchType === "fuzzy").length;
  if (fuzzyCount > 0) {
    const allFuzzy = fuzzyCount === results.length;
    if (allFuzzy) {
      coverage.confidence = "low";
      coverage.knownGaps = [
        `no symbol matched '${args.query}' by name — all ${String(fuzzyCount)} result(s) are vector near-neighbours (matchType:"fuzzy") and may share no name token with the query. Treat this as "not found, here is what is nearby".`,
        ...coverage.knownGaps
      ];
      coverage.suggestFallback ??= `confirm with search_regex(pattern:"${args.query}") before concluding the symbol exists.`;
    } else {
      if (coverage.confidence === "high") coverage.confidence = "medium";
      coverage.knownGaps = [
        `${String(fuzzyCount)} of ${String(results.length)} result(s) are vector near-neighbours (matchType:"fuzzy"), not name matches.`,
        ...coverage.knownGaps
      ];
    }
  }

  if (profile === "nano") {
    const topSymbols = results.slice(0, 10).map((s) => ({ name: s.name, kind: s.kind, filePath: s.filePath, line: s.line, ...(s.matchType ? { matchType: s.matchType } : {}) }));
    return ctx.asText({ query: args.query, strategy: strategyUsed, autoRouted: autoRouted || undefined, count: results.length, topSymbols, hasMore: results.length > topSymbols.length, suggestions: suggestions.slice(0, 3), suggestion, isStale: staleness?.isStale ?? null, coverage: coverage.knownGaps.length > 0 ? coverage : coverage.confidence }, profile);
  }

  if (profile === "compact") {
    return ctx.asText({ query: args.query, strategy: strategyUsed, autoRouted: autoRouted || undefined, count: results.length, symbols: results.map((s) => ({ name: s.name, kind: s.kind, filePath: s.filePath, line: s.line, ...(s.matchType ? { matchType: s.matchType } : {}) })), suggestions, suggestion, staleness, coverage }, profile);
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
  args: { repoId: string; query: string; filePath?: string; limit: number; excludeTests: boolean; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  const resultsRaw = store.searchLiterals(args.repoId, args.query, args.limit, args.filePath ?? null);
  // MCP-ISSUE-049: post-filter, matching how search_symbols/search_regex apply the same flag.
  const results = args.excludeTests ? resultsRaw.filter((r) => !isTestPath(r.filePath)) : resultsRaw;
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

  const { matches, filesScanned, filesEligible, truncated, truncationReason } = result;
  const staleWarning = buildStaleWarning(args.repoId, store, "match lines/text are read live from disk and are current; only enclosingSymbol is resolved from the index and may be off — re-index for accurate enclosing symbols.");
  const coverage = buildCoverageBlock({ resultCount: matches.length, kind: "search", query: args.pattern });
  // MCP-ISSUE-058(a): a capped scan that found nothing is NOT "absent" — say so, in words, naming the
  // number of files never opened. The generic 0-results gap ("wrong strategy, too-narrow filter, or a
  // stale index") actively misled here, because none of those was the cause.
  const unscanned = Math.max(0, filesEligible - filesScanned);
  if (truncationReason === "files_cap_reached" && unscanned > 0) {
    coverage.knownGaps = [
      `scan cap reached: ${String(filesScanned)} of ${String(filesEligible)} in-scope file(s) were read, ${String(unscanned)} were NOT searched. ` +
        (matches.length === 0
          ? "A count of 0 here does not mean the pattern is absent from the repo."
          : "There may be further matches in the unscanned files."),
      ...coverage.knownGaps
    ];
    if (coverage.confidence === "high") coverage.confidence = "medium";
    coverage.suggestFallback ??= "narrow the scope with filePathPrefix / language / pathExclude so the whole candidate set fits under the cap.";
  }
  const truncation = truncated ? { truncated, truncationReason, filesEligible, filesUnscanned: unscanned } : {};

  if (profile === "nano") {
    const top = matches.slice(0, 10).map((m) => ({ filePath: m.filePath, line: m.line, matchText: m.matchText }));
    return ctx.asText(
      {
        pattern: args.pattern, count: matches.length, filesScanned, matches: top, hasMore: matches.length > top.length, ...truncation,
        // MCP-ISSUE-058(a): nano collapses coverage to a bare confidence string, which threw the gap
        // text away exactly when it mattered most. Keep the full block whenever there is a gap.
        coverage: coverage.knownGaps.length > 0 ? coverage : coverage.confidence
      },
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
  args: { repoId: string; symbolId: string; limit: number; excludeTests: boolean; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  // MCP-ISSUE-056: filter the FAR end of each edge — outgoing by target, incoming by source — and do
  // it in the query, so `limit` is not spent on rows that are about to be discarded.
  const detail = ctx.store.getSymbolDetail(args.repoId, args.symbolId, args.limit, args.excludeTests);
  return ctx.asText(detail, profile);
}

// ── get_symbol_context_pack ───────────────────────────────────────────────────

export function handleGetSymbolContextPack(
  args: {
    repoId: string;
    name: string;
    callerDepth: number;
    calleeDepth: number;
    limit: number;
    excludeTests: boolean;
    profile: string;
  },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);

  // MCP-ISSUE-049: 5 of 6 callers were test files in the filed case. `getSymbolCandidates` already
  // honours the flag; the caller/callee lists are graph reads that do not, so they are filtered here.
  const candidates = store.getSymbolCandidates(args.repoId, args.name, args.limit, "name", { excludeTests: args.excludeTests });
  const contextRaw = store.getContextByName(args.repoId, args.name, args.limit);
  const context = args.excludeTests
    ? {
        ...contextRaw,
        callers: contextRaw.callers.filter((x) => !isTestPath(x.callerFile)),
        callees: contextRaw.callees.filter((x) => !isTestPath(x.calleeFile ?? "")),
        importedByFiles: contextRaw.importedByFiles.filter((f) => !isTestPath(f))
      }
    : contextRaw;
  const selectedSymbolId = context.symbol?.symbolId ?? candidates[0]?.symbolId ?? null;
  const changeRaw = selectedSymbolId ? store.getChangeContext(args.repoId, selectedSymbolId, args.callerDepth, args.calleeDepth, args.limit) : null;
  const change =
    changeRaw && args.excludeTests
      ? {
          ...changeRaw,
          callers: changeRaw.callers.filter((x) => !isTestPath(x.fromFilePath ?? "")),
          callees: changeRaw.callees.filter((x) => !isTestPath(x.toFilePath ?? "")),
          typeDeps: changeRaw.typeDeps.filter((x) => !isTestPath(x.toFilePath ?? ""))
        }
      : changeRaw;

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
