import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  parseGitBlamePorcelain,
  redactEmail,
  getRepoStaleness
} from "../gitHelpers.js";
import { runGit } from "../gitHelpers.js";
import { resolveResponseProfile } from "../responseFormatter.js";
import { formatChangeContextPayload } from "./impactHandler.js";
import type { HandlerContext } from "./handlerContext.js";

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
  },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0], args.compact);

  if (args.ranked) {
    const candidates = store.getSymbolCandidates(args.repoId ?? "", args.query, args.limit);
    return ctx.asText({ query: args.query, count: candidates.length, candidates }, profile);
  }

  const results = store.searchSymbols(
    args.query,
    args.repoId ?? null,
    args.language ?? null,
    args.kind ?? null,
    args.filePath ?? null,
    args.limit,
    args.strategy
  );
  const suggestions = results.length === 0 ? store.getSearchSuggestions(args.query, args.repoId ?? null, 5) : [];
  const staleness = args.repoId ? getRepoStaleness(args.repoId, store) : null;

  if (profile === "nano") {
    const topSymbols = results.slice(0, 10).map((s) => ({ name: s.name, kind: s.kind, filePath: s.filePath, line: s.line }));
    return ctx.asText({ query: args.query, strategy: args.strategy, count: results.length, topSymbols, hasMore: results.length > topSymbols.length, suggestions: suggestions.slice(0, 3), isStale: staleness?.isStale ?? null }, profile);
  }

  if (profile === "compact") {
    return ctx.asText({ query: args.query, strategy: args.strategy, count: results.length, symbols: results.map((s) => ({ name: s.name, kind: s.kind, filePath: s.filePath, line: s.line })), suggestions, staleness }, profile);
  }

  if (profile === "verbose") {
    return ctx.asText({ query: args.query, strategy: args.strategy, count: results.length, symbols: results, suggestions, staleness, summary: { repoFilter: args.repoId ?? null, languageFilter: args.language ?? null, kindFilter: args.kind ?? null, filePathFilter: args.filePath ?? null } }, profile);
  }

  return ctx.asText({ query: args.query, strategy: args.strategy, count: results.length, symbols: results, suggestions, staleness }, profile);
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

  if (profile === "nano") {
    const topCandidates = candidates.slice(0, 5).map((x) => ({ name: x.name, kind: x.kind, filePath: x.filePath, score: x.score }));
    return ctx.asText({ queryName: args.name, selectedSymbol: context.symbol ? { name: context.symbol.name, kind: context.symbol.kind, filePath: context.symbol.filePath } : null, candidateCount: candidates.length, topCandidates, callerCount: context.callers.length, calleeCount: context.callees.length, importerCount: context.importedByFiles.length, change: change ? formatChangeContextPayload(change, "nano") : null }, profile);
  }

  if (profile === "compact") {
    return ctx.asText({ queryName: args.name, selectedSymbol: context.symbol ? { symbolId: context.symbol.symbolId, name: context.symbol.name, kind: context.symbol.kind, filePath: context.symbol.filePath, line: context.symbol.line } : null, candidates: candidates.map((x) => ({ symbolId: x.symbolId, name: x.name, kind: x.kind, filePath: x.filePath, line: x.line, score: x.score, confidence: x.confidence })), context: { callers: context.callers.map((x) => ({ callerName: x.callerName, callerFile: x.callerFile, callerLine: x.callerLine })), callees: context.callees.map((x) => ({ calleeName: x.calleeName, calleeFile: x.calleeFile, calleeLine: x.calleeLine })), importedByFiles: context.importedByFiles }, change: change ? formatChangeContextPayload(change, "compact") : null }, profile);
  }

  if (profile === "verbose") {
    return ctx.asText({ queryName: args.name, selectedSymbolId, candidates, context, change, summary: { candidateCount: candidates.length, contextMatchedCount: context.allMatchedSymbols.length, hasChangeContext: change != null } }, profile);
  }

  return ctx.asText({ queryName: args.name, selectedSymbolId, candidates, context, change }, profile);
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
