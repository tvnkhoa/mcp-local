import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { applyResultBudget, resolveResponseProfile, DEFAULT_RESULT_BUDGET_TOKENS } from "../../middleware/responseFormatter.js";
import { listHeadings, matchHeadings, nearestHeadings, extractSection } from "../../services/analysis/docSection.js";
import { assertSafeRepoFilePath } from "../../services/refactor/refactorUtils.js";
import { CITATIONS_CONFIG_PATH, loadCitationConfig } from "../../services/docs/citationConfig.js";
import { findCitations } from "../../services/docs/annotationScanner.js";
import { CitationResolver } from "../../services/docs/citationResolver.js";
import { ownerMatchesSection, registryEntries, reverseReport, schemaKeys, type SchemaKey } from "../../services/docs/termLookup.js";
import type { CitationRow } from "../../repositories/annotationsStore.js";
import { notFound } from "@mcp/core";
import fs from "node:fs";
import { fileIndexedNote } from "../../middleware/inputGuards.js";
import { validateReadOnlyGraphSql, validateAllowedTables, QUERY_GRAPH_TABLE_SCOPES, QueryGraphScopeError } from "../../middleware/sqliteGuardrails.js";
import { buildStaleWarning, getRepoStaleness, collectDirtyFiles, countCommitsBehind } from "../../services/git/gitHelpers.js";
import type { StaleWarning } from "../../services/git/gitHelpers.js";
import { buildCoverageBlock, summarizeEdgeProvenance } from "../../middleware/coverage.js";
import { isTestPath } from "../../services/indexing/fileFilter.js";
import { buildCallableHint } from "../../services/analysis/callableHint.js";
import { findDocsBehindCode } from "../../services/analysis/docFreshness.js";
import { GraphStore } from "../../repositories/graphStore.js";
import type { HandlerContext } from "./handlerContext.js";

// ── Staleness Gate ────────────────────────────────────────────────────────────
// Stale index is a warning, not a fatal — every other read tool (search_symbols,
// route_map, ...) returns data with a staleness note. Impact tools follow suit:
// return the warning so callers degrade gracefully instead of getting nothing.

function staleWarningFor(repoId: string, store: GraphStore): StaleWarning | null {
  return buildStaleWarning(
    repoId,
    store,
    `results reflect the indexed commit, not current HEAD — run index_repository(repoId='${repoId}', mode='incremental') for accurate impact.`
  );
}

// ── graph-health collapse ─────────────────────────────────────────────────────
// When the graph is fully resolved, a single flag replaces the all-zero detail object.

function collapseGraphHealth(gh: {
  unresolvedCalls: number;
  unresolvedImports: number;
  unresolvedTypeRefs: number;
  unresolvedProperties?: number;
  importClassificationRatio?: number;
}): unknown {
  const healthy =
    gh.unresolvedCalls === 0 &&
    gh.unresolvedImports === 0 &&
    gh.unresolvedTypeRefs === 0 &&
    (gh.unresolvedProperties ?? 0) === 0 &&
    (gh.importClassificationRatio ?? 1) === 1;
  return healthy ? { complete: true } : gh;
}

// ── formatChangeContextPayload ────────────────────────────────────────────────
// Shared by impactHandler and searchHandler (get_symbol_context_pack)

export function formatChangeContextPayload(
  result: ReturnType<GraphStore["getChangeContext"]>,
  profile: ReturnType<typeof resolveResponseProfile>
): unknown {
  if (profile === "nano") {
    // ISSUE-022: `via` ("interface"/"bus"/"member") chỉ spread khi có — nano/compact giữ lean.
    const topCallers = result.callers.slice(0, 10).map((x) => ({ fromName: x.fromName, fromFilePath: x.fromFilePath, distance: x.distance, ...(x.via ? { via: x.via } : {}), confidence: x.confidence ?? null }));
    const topCallees = result.callees.slice(0, 10).map((x) => ({ toName: x.toName, toFilePath: x.toFilePath, confidence: x.confidence ?? null }));
    const topTypeDeps = result.typeDeps.slice(0, 10).map((x) => ({ toName: x.toName, toFilePath: x.toFilePath, confidence: x.confidence ?? null }));
    return {
      symbol: result.symbol ? { symbolId: result.symbol.symbolId, name: result.symbol.name, kind: result.symbol.kind, filePath: result.symbol.filePath, line: result.symbol.line } : null,
      callerCount: result.callers.length, calleeCount: result.callees.length, typeDepCount: result.typeDeps.length,
      topCallers, topCallees, topTypeDeps,
      hasMoreCallers: result.callers.length > topCallers.length, hasMoreCallees: result.callees.length > topCallees.length, hasMoreTypeDeps: result.typeDeps.length > topTypeDeps.length,
      unresolved: { calls: result.graphHealth.unresolvedCalls, imports: result.graphHealth.unresolvedImports, typeRefs: result.graphHealth.unresolvedTypeRefs },
      reliability: { medianConfidence: result.reliabilitySummary.medianConfidence, unresolvedRatio: result.reliabilitySummary.unresolvedRatio, warning: result.reliabilitySummary.warning }
    };
  }
  if (profile === "compact") {
    // Drop opaque edge ids (fromId/toId) and free-text `reason` — not needed for discovery.
    return {
      symbol: result.symbol ? { symbolId: result.symbol.symbolId, name: result.symbol.name, kind: result.symbol.kind, filePath: result.symbol.filePath, line: result.symbol.line } : null,
      callers: result.callers.map((x) => ({ fromName: x.fromName, fromFilePath: x.fromFilePath, distance: x.distance, ...(x.via ? { via: x.via } : {}), confidence: x.confidence ?? null })),
      callees: result.callees.map((x) => ({ toName: x.toName, toFilePath: x.toFilePath, confidence: x.confidence ?? null })),
      typeDeps: result.typeDeps.map((x) => ({ toName: x.toName, toFilePath: x.toFilePath, confidence: x.confidence ?? null })),
      graphHealth: collapseGraphHealth(result.graphHealth), reliabilitySummary: result.reliabilitySummary
    };
  }
  if (profile === "verbose") {
    return { ...result, summary: { callerCount: result.callers.length, calleeCount: result.callees.length, typeDepCount: result.typeDeps.length } };
  }
  return result;
}

// ── get_dependency_graph ──────────────────────────────────────────────────────

export function handleGetDependencyGraph(
  args: { repoId: string; symbolId?: string; filePath?: string; depth: number; limit: number; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  if (args.filePath) {
    const result = store.getModuleFlow(args.repoId, args.filePath, args.limit);
    const collapsed = result.collapsed ? { collapsed: result.collapsed } : {};
    if (profile === "nano") {
      // MCP-ISSUE-049: names alone are not identity. Distinct edges that share a name pair — an
      // interface, its implementation and a test double — rendered as indistinguishable repeats,
      // which made the (working) duplicate collapse look broken. An unresolved target drops
      // `toName` entirely, leaving a row naming nothing at all.
      const topEdges = result.edges.slice(0, 10).map((e) => ({ fromId: e.fromId, fromName: e.fromName, toId: e.toId, toName: e.toName, type: e.type }));
      return ctx.asText({ repoId: args.repoId, filePath: args.filePath, edgeCount: result.edges.length, topEdges, hasMore: result.edges.length > topEdges.length, ...collapsed }, profile);
    }
    return ctx.asText({ repoId: args.repoId, filePath: args.filePath, edges: result.edges, unresolvedCalls: result.unresolvedCalls, ...collapsed }, profile);
  }
  let rows = traverseDependencyGraph(store, args.repoId, args.symbolId!, args.depth, args.limit);
  if (rows.length === 0) {
    const detail = store.getSymbolDetail(args.repoId, args.symbolId!, 1);
    if (detail.symbol) {
      const moduleSymbolId = store.findModuleSymbolId(args.repoId, detail.symbol.filePath);
      if (moduleSymbolId) {
        rows = traverseDependencyGraph(store, args.repoId, moduleSymbolId, args.depth, args.limit);
      }
    }
  }
  if (profile === "nano") {
    // MCP-ISSUE-049: same widening as the module-flow branch above.
    const topEdges = rows.slice(0, 10).map((e) => ({ fromId: e.fromId, fromName: e.fromName, toId: e.toId, toName: e.toName, type: e.type, confidence: e.confidence ?? null }));
    return ctx.asText({ repoId: args.repoId, symbolId: args.symbolId, edgeCount: rows.length, topEdges, hasMore: rows.length > topEdges.length }, profile);
  }
  return ctx.asText({ repoId: args.repoId, symbolId: args.symbolId, depth: args.depth, edges: rows }, profile);
}

// ── get_call_chain ────────────────────────────────────────────────────────────

export function handleGetCallChain(
  args: { repoId: string; symbolId: string; direction: "callers" | "callees"; depth: number; limit: number; excludeTests: boolean; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  type CallChainDirection = "callers" | "callees";
  const direction: CallChainDirection = args.direction;
  // MCP-ISSUE-056: `excludeTests` is applied on the FAR end of each hop, inside `getCallEdges`'s
  // SQL. It used to be a post-filter here, which had two consequences: the traversal spent its
  // `limit` on rows that were then discarded, and `truncated` below was computed on the shortened
  // array — so a genuinely truncated chain reported `truncated: false`.
  const rows = traverseCallGraph(store, args.repoId, args.symbolId, direction, args.depth, args.limit, args.excludeTests);
  const coverage = buildCoverageBlock({ resultCount: rows.length, truncated: rows.length >= args.limit, kind: "call_chain", query: args.symbolId, edgeProvenance: summarizeEdgeProvenance(rows) });

  // MCP-ISSUE-049: every profile must carry enough identity to act on. `getCallEdges` now resolves
  // both endpoints, so the far end of each hop has a name, a file and an id — before, nano emitted
  // `{confidence, via}` with the name/file nulled and stripped, and compact returned raw edge rows
  // whose only endpoint information was an opaque 24-hex id. `get_symbol_context_pack{nano}` keeps
  // full identity and is the model this follows.
  const farEnd = (e: (typeof rows)[number]) =>
    direction === "callees"
      ? { symbolId: e.toId, name: e.toName ?? null, filePath: e.toFilePath ?? null }
      : { symbolId: e.fromId, name: e.fromName ?? null, filePath: e.fromFilePath ?? null };
  // Mark bus hops (PUBLISHES) and interface-dispatch hops so output distinguishes
  // them from direct static calls, matching trace_execution_flow. (ISSUE-020/022)
  const via = (e: (typeof rows)[number]) =>
    e.type === "PUBLISHES" ? { via: "bus" } : e.reason === "interface-dispatch" ? { via: "interface" } : {};

  /**
   * MCP-ISSUE-060: truncation is reported at EVERY profile, not only at nano.
   *
   * Measured: `get_call_chain(direction:"callers", limit:5)` at `compact` returned 5 edges and no
   * truncation field of any kind, while the identical query at `nano` returned
   * `chainLength: 44, truncated: true`. An agent on the documented default profile reports "5
   * callers" for a symbol with 44. A profile may change how MUCH is returned; it must never change
   * whether the response is honest about being a page.
   *
   * `truncated` means the row limit bound the result — the same condition `coverage` is computed
   * from at the top of this function, now surfaced instead of only being folded into a word.
   */
  const chainTruncation = { chainLength: rows.length, truncated: rows.length >= args.limit };

  // MCP-ISSUE-061 Stage 2: an empty chain on a container symbol used to be documented in the rules
  // file instead of reported here. Computed only when the traversal found nothing.
  const containerHint = rows.length === 0 ? buildCallableHint(store, args.repoId, args.symbolId) : null;
  const hintBlock = containerHint ? { hint: containerHint } : {};

  if (profile === "nano") {
    const pathNodes = rows.slice(0, 10).map((e) => ({ ...farEnd(e), ...via(e), confidence: e.confidence ?? null }));
    return ctx.asText({ repoId: args.repoId, symbolId: args.symbolId, direction, ...chainTruncation, path: pathNodes, hasMore: rows.length > pathNodes.length, coverage: coverage.confidence, ...hintBlock }, profile);
  }
  if (profile === "compact") {
    const edges = rows.map((e) => ({
      fromId: e.fromId, fromName: e.fromName ?? null, fromFilePath: e.fromFilePath ?? null,
      toId: e.toId, toName: e.toName ?? null, toFilePath: e.toFilePath ?? null,
      type: e.type, ...via(e), confidence: e.confidence ?? null
    }));
    return ctx.asText({ repoId: args.repoId, symbolId: args.symbolId, direction, depth: args.depth, ...chainTruncation, edges, coverage, ...hintBlock }, profile);
  }
  return ctx.asText({ repoId: args.repoId, symbolId: args.symbolId, direction, depth: args.depth, ...chainTruncation, edges: rows, coverage, ...hintBlock }, profile);
}

// ── find_field_accesses ───────────────────────────────────────────────────────
// ISSUE-018 — semantic "who reads / writes this field" over the existing
// PROPERTY_REF/PROPERTY_WRITE edges, so wrong-level-resolution audits stay in MCP
// instead of falling back to grep. Accepts a property symbolId or a resolvable name.

export function handleFindFieldAccesses(
  args: { repoId: string; symbolId?: string; name?: string; mode: "read" | "write" | "all"; limit: number; excludeTests: boolean; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);

  let symbolId = args.symbolId;
  if (!symbolId && args.name) {
    // Only a property symbol answers "who reads/writes this field"; an exact name beats a substring.
    // A non-property match used to be taken silently (`candidates[0]`), so a field the graph has no
    // property for — a Zod `z.object` key — was answered by whatever shared its name, as `high`.
    const name = args.name;
    const candidates = store.getSymbolCandidates(args.repoId, name, 25);
    const properties = candidates.filter((c) => c.kind === "property");
    symbolId = (properties.find((c) => c.name === name) ?? properties[0])?.symbolId;
    if (!symbolId) return noPropertySymbolResult(args.repoId, name, candidates, store, ctx, profile);
  }
  if (!symbolId) throw new McpError(ErrorCode.InvalidParams, "find_field_accesses: provide symbolId or a resolvable name.");

  // MCP-ISSUE-056: `excludeTests` is applied in the query — the filed case returned 5 of 7 reads of
  // "HandledBy" from test files, and filtering after the `limit` spent the budget on the dropped rows.
  const rawFieldAccesses = store.getFieldAccesses(args.repoId, symbolId, args.mode, args.limit, args.excludeTests);
  const property = rawFieldAccesses.property;
  if (!property) throw new McpError(ErrorCode.InvalidParams, `find_field_accesses: symbol '${symbolId}' not found in repo '${args.repoId}'.`);
  const result = { ...rawFieldAccesses, property };

  const reads = result.accesses.filter((a) => a.mode === "read");
  const writes = result.accesses.filter((a) => a.mode === "write");
  const staleWarning = staleWarningFor(args.repoId, store);
  const coverage = buildCoverageBlock({
    resultCount: result.accesses.length,
    expectedNonZero: true,
    kind: "field_accesses",
    query: result.property.name,
    languageGaps: propertyEdgeGaps(result.property.filePath),
    staleness: staleWarning
  });

  // MCP-ISSUE-047: `getSymbolCandidates` matches by case-insensitive substring, so `name:"owner"`
  // resolves to `Owner`, `OwnerId` or `AssignedOwnerName` and the response reports only the winner.
  // Echo what was asked when it differs, so the caller can see a substitution happened.
  const nameResolution =
    args.name !== undefined && args.name !== result.property.name
      ? {
          queriedName: args.name,
          resolvedName: result.property.name,
          note: "resolved by case-insensitive substring match — pass symbolId to pin an exact symbol"
        }
      : null;

  if (profile === "nano") {
    const top = result.accesses.slice(0, 10).map((a) => ({ mode: a.mode, enclosingName: a.enclosingName, filePath: a.filePath, line: a.line }));
    return ctx.asText({ property: { name: result.property.name, filePath: result.property.filePath }, readCount: reads.length, writeCount: writes.length, top, hasMore: result.accesses.length > top.length, coverage: coverage.confidence, ...(nameResolution && { nameResolution }), ...(staleWarning && { staleWarning }) }, profile);
  }

  const compactAccess = (a: typeof result.accesses[number]) => ({ mode: a.mode, enclosingName: a.enclosingName, enclosingKind: a.enclosingKind, filePath: a.filePath, line: a.line, confidence: a.confidence, ...(a.assignedExpression ? { assignedExpression: a.assignedExpression } : {}) });
  if (profile === "compact") {
    return ctx.asText({ property: { symbolId: result.property.symbolId, name: result.property.name, kind: result.property.kind, filePath: result.property.filePath, line: result.property.line, declaringType: result.property.declaringType }, mode: args.mode, readCount: reads.length, writeCount: writes.length, reads: reads.map(compactAccess), writes: writes.map(compactAccess), coverage, indexMeta: buildIndexMeta(store, args.repoId), ...(nameResolution && { nameResolution }), ...(staleWarning && { staleWarning }) }, profile);
  }

  return ctx.asText({ property: result.property, mode: args.mode, readCount: reads.length, writeCount: writes.length, accesses: result.accesses, coverage, indexMeta: buildIndexMeta(store, args.repoId), ...(nameResolution && { nameResolution }), ...(staleWarning && { staleWarning }) }, profile);
}

/**
 * Accesses the property edges cannot see for the file's language. C# has receiver-typed property
 * edges (`csharpPropertyEdges.ts`); the TS/JS lane emits them only for `this.<member>`
 * (`jsTypeRefs.ts`), so `obj.field`, destructuring and `z.infer` types are invisible there.
 */
const JS_TS_FILE = /\.(?:[cm]?[jt]sx?|vue)$/i;
function propertyEdgeGaps(filePath: string): string[] {
  if (!JS_TS_FILE.test(filePath)) return [];
  return [
    "TS/JS property edges cover only `this.<member>` accesses; reads and writes through any other receiver " +
      "(`obj.field`, destructuring, spread, `z.infer` types) are not in the graph, so these counts are a lower bound."
  ];
}

/**
 * No property symbol carries this name. Answered as an honest empty result rather than an error, so
 * the caller sees why the graph cannot count it and which same-named symbols exist to pin instead.
 */
function noPropertySymbolResult(
  repoId: string,
  name: string,
  candidates: ReturnType<GraphStore["getSymbolCandidates"]>,
  store: GraphStore,
  ctx: HandlerContext,
  profile: ReturnType<typeof resolveResponseProfile>
): CallToolResult {
  const staleWarning = staleWarningFor(repoId, store);
  const coverage = buildCoverageBlock({
    resultCount: 0,
    expectedNonZero: true,
    kind: "field_accesses",
    query: name,
    languageGaps: [
      `no symbol of kind 'property' named '${name}' is indexed. TS/JS object-literal keys (e.g. Zod \`z.object({...})\` fields) ` +
        "are not indexed as properties, so their reads and writes cannot be counted from the graph."
    ],
    staleness: staleWarning
  });
  const otherMatches = candidates
    .slice(0, 5)
    .map((c) => ({ symbolId: c.symbolId, name: c.name, kind: c.kind, filePath: c.filePath, line: c.line }));
  return ctx.asText(
    {
      property: null,
      queriedName: name,
      readCount: 0,
      writeCount: 0,
      coverage: profile === "nano" ? coverage.confidence : coverage,
      ...(otherMatches.length > 0 && {
        otherMatches,
        hint: "none of these is a property; pass one as symbolId only if it really is the field you mean."
      }),
      ...(staleWarning && { staleWarning })
    },
    profile
  );
}

/**
 * query_docs{ mode:"section" }. The file is read from disk, so the section is current even when the
 * index is not; the index is only consulted for the repo's root.
 */
function readDocSection(store: GraphStore, repoId: string, filePath: string, headingPrefix: string, maxTokens: number): unknown {
  const repo = store.getRepository(repoId);
  if (!repo) throw notFound(`unknown repoId '${repoId}'.`, { repoId });
  const relative = filePath.replace(/\\/g, "/");
  let absolute: string;
  try {
    absolute = assertSafeRepoFilePath(repo.repoPath, relative);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, `query_docs: filePath '${relative}' is outside the repository.`);
  }
  if (!fs.existsSync(absolute)) throw notFound(`no file '${relative}' in repo '${repoId}'.`, { repoId, filePath: relative });

  const lines = fs.readFileSync(absolute, "utf8").split(/\r?\n/);
  const headings = listHeadings(lines);
  const matches = matchHeadings(headings, headingPrefix);
  if (matches.length === 0) {
    const nearest = nearestHeadings(headings, headingPrefix).map((h) => `${"#".repeat(h.level)} ${h.text} (line ${String(h.line)})`);
    throw notFound(
      `no heading in '${relative}' starts with '${headingPrefix}'. ` +
        (nearest.length > 0 ? `Closest headings: ${nearest.join("; ")}` : "The file has no headings."),
      { repoId, filePath: relative, headingPrefix }
    );
  }
  const [target, ...others] = matches;
  const section = extractSection(lines, headings, target!, maxTokens, others.slice(0, 10));
  return { repoId, mode: "section", filePath: relative, headingPrefix, ...section };
}

/**
 * query_docs{ mode:"search" } beside the doc rows: code comments that match, with the enclosing
 * symbol (release C). A separate list, because comment and doc relevance scores are not comparable.
 */
function codeCommentsFor(store: GraphStore, repoId: string, query: string): { codeComments?: unknown[] } {
  const hits = store.searchComments(repoId, query, 5);
  if (hits.length === 0) return {};
  return {
    codeComments: hits.map((h) => {
      const sym = store.findSymbolAtLine(repoId, h.filePath, h.startLine);
      return {
        filePath: h.filePath,
        startLine: h.startLine,
        endLine: h.endLine,
        text: h.text.length > 600 ? `${h.text.slice(0, 600)}…` : h.text,
        enclosingSymbol: sym ? { symbolId: sym.symbolId, name: sym.name, kind: sym.kind } : null
      };
    })
  };
}

/**
 * query_docs{ mode:"cites" } (R5/R6). With `target`: run the repo's citation patterns over it to get
 * the spec, resolve that to a file and anchor (row text for a table row), and list every citation of
 * it. With `filePath`: that file's citations, each resolved.
 */
function readCitations(store: GraphStore, repoId: string, target: string | undefined, filePath: string | undefined, limit: number): unknown {
  const repo = store.getRepository(repoId);
  if (!repo) throw notFound(`unknown repoId '${repoId}'.`, { repoId });
  const load = loadCitationConfig(repo.repoPath);
  const configNote = !load.present
    ? { note: `this repo has no ${CITATIONS_CONFIG_PATH}, so no citation patterns are configured; see codebase-index-mcp/docs/citations-config.md.` }
    : load.errors.length > 0
      ? { configErrors: load.errors }
      : {};
  const resolver = new CitationResolver(repo.repoPath);
  const withSymbol = (r: CitationRow) => {
    const sym = /\.mdx?$/i.test(r.filePath) ? null : store.findSymbolAtLine(repoId, r.filePath, r.line);
    return {
      filePath: r.filePath,
      line: r.line,
      patternId: r.patternId,
      raw: r.raw,
      ...(sym && { enclosingSymbol: { symbolId: sym.symbolId, name: sym.name, kind: sym.kind } })
    };
  };

  if (target) {
    const hits = load.config ? findCitations([{ line: 0, text: target }], load.config.citations) : [];
    const specs = hits.map((h) => ({ targetSpec: h.targetSpec, anchorValue: h.anchorValue }));
    const asPath = target.replace(/\\/g, "/");
    const byPath = hits.length === 0;
    const { rows, total } = store.citationsTo(repoId, byPath ? { filePath: asPath } : { specs }, limit);
    const resolved = hits.map((h) => ({ patternId: h.patternId, ...resolver.resolve(h) }));
    return {
      repoId,
      mode: "cites",
      target,
      ...(byPath ? { matchedAs: "filePath" } : { resolved }),
      // A path target also answers "which doc sections mention this file" — decision rows that name it.
      ...(byPath && (() => {
        const mentionedIn = store.docSectionsMentioning(repoId, asPath, limit);
        return mentionedIn.length > 0 ? { mentionedIn } : {};
      })()),
      citedByCount: total,
      returned: rows.length,
      ...(total > rows.length && { truncated: true }),
      citedBy: rows.map(withSymbol),
      ...configNote,
      ...(total === 0 && byPath && load.config && {
        hint: "no configured pattern matched the target, and no citation points at it as a file path. Use the repo's shorthand (see .codebase-index/citations.json) or an exact repo-relative path."
      })
    };
  }

  const rows = store.citationsFrom(repoId, filePath!, limit);
  return {
    repoId,
    mode: "cites",
    from: filePath,
    count: rows.length,
    // `line` is where the citation SITS in this file; where it points is `targetLine`. Spreading the
    // resolution over the row overwrote one with the other (wec.aria acceptance of release C).
    citations: rows.map((r) => {
      const res = resolver.resolve(r);
      return {
        ...withSymbol(r),
        status: res.status,
        targetSpec: res.targetSpec,
        anchorKind: res.anchorKind,
        anchorValue: res.anchorValue,
        ...(res.file !== undefined && { targetFile: res.file }),
        ...(res.line !== undefined && { targetLine: res.line }),
        ...(res.text !== undefined && { targetText: res.text }),
        ...(res.candidates !== undefined && { candidates: res.candidates })
      };
    }),
    ...configNote
  };
}

const TERM_SCAN_MAX_FILES = 5000;
const TERM_SCAN_MAX_BYTES = 512 * 1024;
/** Per-file keys by mtime+size: reading ~800 files is the whole cost of a term call (7 s cold on wec.aria). */
const schemaKeyCache = new Map<string, { mtimeMs: number; size: number; keys: SchemaKey[] }>();

/** Zod shape keys across the repo's non-test TS/JS files, read from disk (R4). */
function scanSchemaKeys(store: GraphStore, repoId: string, repoPath: string): { keys: SchemaKey[]; filesScanned: number; capped: boolean } {
  const files = store.listFilesByLanguage(repoId, ["typescript", "javascript"]).filter((f) => !isTestPath(f));
  const keys: SchemaKey[] = [];
  let filesScanned = 0;
  for (const file of files.slice(0, TERM_SCAN_MAX_FILES)) {
    try {
      const absolute = assertSafeRepoFilePath(repoPath, file);
      const st = fs.statSync(absolute);
      if (st.size > TERM_SCAN_MAX_BYTES) continue;
      const cached = schemaKeyCache.get(absolute);
      const fileKeys = cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size ? cached.keys : schemaKeys(fs.readFileSync(absolute, "utf8"), file);
      if (cached?.keys !== fileKeys) {
        if (schemaKeyCache.size >= TERM_SCAN_MAX_FILES * 2) schemaKeyCache.clear();
        schemaKeyCache.set(absolute, { mtimeMs: st.mtimeMs, size: st.size, keys: fileKeys });
      }
      filesScanned++;
      keys.push(...fileKeys);
    } catch {
      continue;
    }
  }
  return { keys, filesScanned, capped: files.length > TERM_SCAN_MAX_FILES };
}

/**
 * query_docs{ mode:"term" } (R4). With `query`: the registry rows that define the name, the lines
 * that mention it, and the Zod shapes that declare it. Without: the reverse report — snake_case
 * schema keys the registry has no row for. The registry is the `registryDoc` of citations.json.
 */
function readTerm(store: GraphStore, repoId: string, term: string | undefined, limit: number): unknown {
  const repo = store.getRepository(repoId);
  if (!repo) throw notFound(`unknown repoId '${repoId}'.`, { repoId });
  const load = loadCitationConfig(repo.repoPath);
  const registryDoc = load.config?.registryDoc ?? null;
  if (!registryDoc) {
    return {
      repoId,
      mode: "term",
      ...(term && { term }),
      registryDoc: null,
      note: load.present
        ? `${CITATIONS_CONFIG_PATH} names no registryDoc, so there is no canonical-name registry to read; add "registryDoc": "<path>" (codebase-index-mcp/docs/citations-config.md).`
        : `this repo has no ${CITATIONS_CONFIG_PATH}, so no canonical-name registry is configured; see codebase-index-mcp/docs/citations-config.md.`
    };
  }
  let registryLines: string[];
  try {
    registryLines = fs.readFileSync(assertSafeRepoFilePath(repo.repoPath, registryDoc), "utf8").split(/\r?\n/);
  } catch {
    throw notFound(`registryDoc '${registryDoc}' (from ${CITATIONS_CONFIG_PATH}) is not readable in repo '${repoId}'.`, { repoId, filePath: registryDoc });
  }
  const scan = scanSchemaKeys(store, repoId, repo.repoPath);
  const scanMeta = { schemaFilesScanned: scan.filesScanned, ...(scan.capped && { schemaScanCapped: TERM_SCAN_MAX_FILES }) };

  if (!term) {
    const report = reverseReport(scan.keys, registryLines);
    return {
      repoId,
      mode: "term",
      registryDoc,
      keysScanned: report.keysScanned,
      definedInRegistry: report.defined,
      missingCount: report.missing.length,
      returned: Math.min(limit, report.missing.length),
      ...(report.missing.length > limit && { truncated: true }),
      missing: report.missing.slice(0, limit),
      ...scanMeta,
      note: "a review queue, not a verdict: snake_case Zod shape keys (non-test files) with no registry table row whose first cell is the key. 'high' = the registry never names it; 'medium' = named, but no row defines it."
    };
  }

  const entries = registryEntries(registryLines, term, limit);
  const declared = scan.keys.filter((k) => k.key === term);
  return {
    repoId,
    mode: "term",
    term,
    registryDoc,
    definedIn: entries.definitions.map((d) => ({ line: d.line, section: d.section, sectionLine: d.sectionLine, text: d.text })),
    mentionCount: entries.mentionCount,
    mentions: entries.mentions,
    schemaKeys: declared.map((k) => {
      const section = entries.definitions.find((d) => ownerMatchesSection(k.owner, d.section))?.section;
      return { filePath: k.filePath, line: k.line, owner: k.owner, ...(section && { registrySection: section }) };
    }),
    ...scanMeta,
    ...(entries.definitions.length === 0 && {
      hint: declared.length > 0
        ? `the code declares '${term}' but ${registryDoc} has no table row defining it — a candidate for the registry.`
        : `'${term}' is neither defined in ${registryDoc} nor declared as a Zod shape key. The name is matched exactly (case-sensitive).`
    }),
    next: `find_field_accesses(name:"${term}") for its reads and writes.`
  };
}

// ── find_impact_files ─────────────────────────────────────────────────────────

export function handleFindImpactFiles(
  args: { repoId: string; filePath: string; limit: number; view: "files" | "surface"; groupBy: "file" | "module"; excludeTests: boolean; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);

  // Stale index → warn (embedded in payload), don't block.
  const staleWarning = staleWarningFor(args.repoId, store);
  // MCP-ISSUE-060: "this path is not in the index" and "this path has no dependents" are different
  // answers, and both used to render as `totalImpactedCount: 0` with `graph data complete` beside it.
  // A 29-file server added to this workspace after the last index run was in exactly that state, and
  // every file-scoped tool agreed it was nothing.
  const warn = { ...(staleWarning ? { staleWarning } : {}), ...fileIndexedNote(store, args.repoId, args.filePath) };

  if (args.view === "surface") {
    // MCP-ISSUE-056: the filed case returned 9 of 15 callers from a single test file. `excludeTests`
    // goes INTO the query — as a post-filter over an already-LIMIT-ed page it could return `[]` for a
    // symbol that has production callers, which reads as "nothing calls this".
    const result = store.getImpactSurface(args.repoId, args.filePath, args.limit, args.excludeTests);
    const surfaceWiring = result.wiringNote ? { wiringNote: result.wiringNote } : {};
    const callers = result.callers;
    if (profile === "nano") {
      const topItems = callers.slice(0, 10).map((x) => ({ callerName: x.callerName, callerFile: x.callerFile, edgeTypes: x.edgeTypes }));
      return ctx.asText({ repoId: args.repoId, filePath: args.filePath, totalCallers: callers.length, topItems, hasMore: callers.length > topItems.length, ...surfaceWiring, ...warn }, profile);
    }
    // MCP-ISSUE-049: `groupBy` used to be unreachable here — the surface branch returned before
    // `args.groupBy` was ever read, so `groupBy:"module"` produced an ungrouped list with no note
    // that the parameter had been ignored. Grouped through the same helper the files view uses.
    if (args.groupBy === "module") {
      const grouped = store.groupFilesByModule([...new Set(callers.map((x) => x.callerFile))]);
      const moduleGroups = Object.entries(grouped).map(([module, files]) => ({
        module,
        fileCount: files.length,
        callerCount: callers.filter((x) => files.includes(x.callerFile)).length,
        topFiles: files.slice(0, 5)
      }));
      return ctx.asText({ repoId: args.repoId, filePath: args.filePath, groupBy: "module", totalCallers: callers.length, moduleGroups, graphHealth: result.graphHealth, reliabilitySummary: result.reliabilitySummary, ...surfaceWiring, indexMeta: buildIndexMeta(store, args.repoId, true), ...warn }, profile);
    }
    return ctx.asText({ repoId: args.repoId, filePath: args.filePath, ...result, callers, indexMeta: buildIndexMeta(store, args.repoId, true), ...warn }, profile);
  }
  // MCP-ISSUE-056: same filter as the surface view, and likewise in-query so it applies before the cap.
  const result = store.getImpactFiles(args.repoId, args.filePath, args.limit, args.excludeTests);
  const filesWiring = result.wiringNote ? { wiringNote: result.wiringNote } : {};
  if (args.groupBy === "module") {
    const filePaths = result.impactedFiles.map((f) => f.filePath);
    const grouped = store.groupFilesByModule(filePaths);
    const moduleGroups = Object.entries(grouped).map(([module, files]) => ({ module, fileCount: files.length, topFiles: files.slice(0, 5) }));
    if (profile === "nano") {
      return ctx.asText({ repoId: args.repoId, filePath: args.filePath, totalModules: moduleGroups.length, topModules: moduleGroups.slice(0, 5), hasMore: moduleGroups.length > 5, ...filesWiring, ...warn }, profile);
    }
    return ctx.asText({ repoId: args.repoId, filePath: args.filePath, moduleGroups, graphHealth: result.graphHealth, reliabilitySummary: result.reliabilitySummary, ...filesWiring, indexMeta: buildIndexMeta(store, args.repoId, true), ...warn }, profile);
  }
  if (profile === "nano") {
    const topFiles = result.impactedFiles.slice(0, 10).map((f) => ({ filePath: f.filePath, symbolCount: (f as { symbolCount?: number }).symbolCount ?? null }));
    // `totalFiles` is the true dependent count (MCP-ISSUE-054), so `hasMore` compares against it —
    // otherwise a blast radius of 300 shown 10 at a time reported `totalFiles: 20`.
    return ctx.asText({ repoId: args.repoId, filePath: args.filePath, totalFiles: result.totalImpactedCount, topFiles, hasMore: result.totalImpactedCount > topFiles.length, ...filesWiring, ...warn }, profile);
  }
  return ctx.asText({ repoId: args.repoId, filePath: args.filePath, ...result, indexMeta: buildIndexMeta(store, args.repoId, true), ...warn }, profile);
}

// ── get_change_context ────────────────────────────────────────────────────────

export function handleGetChangeContext(
  args: { repoId: string; symbolId?: string; name?: string; callerDepth: number; calleeDepth: number; limit: number; excludeTests: boolean; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;

  // Stale index → warn (embedded in payload), don't block.
  const staleWarning = staleWarningFor(args.repoId, store);
  const warn = staleWarning ? { staleWarning } : {};

  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  let resolvedSymbolId = args.symbolId;
  if (!resolvedSymbolId && args.name) {
    const context = store.getContextByName(args.repoId, args.name, args.limit);
    if (!context.symbol) {
      // `found: false` is an explicit not-found signal that survives compact null-stripping
      // (the `symbol: null` sentinel is dropped under the now-default compact profile).
      return ctx.asText({ found: false, symbol: null, callers: [], callees: [], typeDeps: [], graphHealth: { unresolvedCalls: 0, unresolvedImports: 0, unresolvedTypeRefs: 0, note: "symbol not found" }, queryName: args.name, ...warn }, profile);
    }
    resolvedSymbolId = context.symbol.symbolId;
  }
  // MCP-ISSUE-056: filter both directions IN the query, so `limit` is spent on rows the caller
  // asked for. The counts in the payload are derived from these arrays, so `callerCount` /
  // `calleeCount` stay honest about what was returned.
  const result = store.getChangeContext(args.repoId, resolvedSymbolId!, args.callerDepth, args.calleeDepth, args.limit, args.excludeTests);
  return ctx.asText({ ...(formatChangeContextPayload(result, profile) as Record<string, unknown>), ...warn }, profile);
}

// ── get_file_summary ──────────────────────────────────────────────────────────

export function handleGetFileSummary(
  args: { repoId: string; filePath: string; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  const result = ctx.store.getFileSummary(args.repoId, args.filePath);
  if (profile === "nano") {
    const topSymbols = result.exports.slice(0, 5).map((s) => ({ name: s.name, kind: s.kind }));
    return ctx.asText({ filePath: result.file.filePath, language: result.file.language, symbolCount: result.exports.length, topSymbols }, profile);
  }
  if (profile === "verbose") {
    return ctx.asText({ ...result, indexMeta: buildIndexMeta(ctx.store, args.repoId) }, profile);
  }
  // compact/standard: drop redundant per-entry repoId+filePath from exports (constant = this file),
  // drop redundant import `from*` (always this file's own module), collapse healthy graphHealth.
  return ctx.asText({
    file: result.file,
    symbolCount: result.exports.length,
    exports: result.exports.map((s) => ({ symbolId: s.symbolId, name: s.name, kind: s.kind, line: s.line, signature: s.signature })),
    imports: result.imports.map((i) => ({ toName: i.toName, toFilePath: i.toFilePath, type: i.type })),
    importedBy: result.importedBy,
    graphHealth: collapseGraphHealth(result.graphHealth),
    indexMeta: buildIndexMeta(ctx.store, args.repoId)
  }, profile);
}

// ── list_repositories ─────────────────────────────────────────────────────────

export function handleListRepositories(args: { profile?: string }, ctx: HandlerContext): CallToolResult {
  // B-03: the fallback is `compact` because that is what `listRepositoriesSchema` declares, and
  // what CLAUDE.md states is the default for every read tool. It read `standard`, which is how the
  // tool came to answer at a profile it never advertised. Unreachable through the tool now that the
  // schema default applies; kept for direct callers (harnesses) and aligned so the two agree.
  const profile = resolveResponseProfile((args.profile ?? "compact") as Parameters<typeof resolveResponseProfile>[0]);
  const repos = ctx.store.listRepositories();
  if (profile === "nano") {
    return ctx.asText({
      count: repos.length,
      repos: repos.map((r) => {
        const repo = r as { repoId?: string; filesIndexed?: number; lastRunStatus?: string };
        return { repoId: repo.repoId, filesIndexed: repo.filesIndexed ?? null, lastRunStatus: repo.lastRunStatus ?? null };
      })
    }, profile);
  }
  return ctx.asText(repos, profile);
}

// ── get_file_context ──────────────────────────────────────────────────────────

export function handleGetFileContext(
  args: { repoId: string; filePath?: string; filePaths?: string[]; limit: number; compact: boolean; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0], args.compact);
  if (args.filePaths) {
    const result = store.getBatchContext(args.repoId, args.filePaths, args.limit, profile === "compact" || profile === "nano");
    if (profile === "nano") {
      const symbols = (result.symbols as { name: string; kind: string; filePath: string; line: number }[]).slice(0, 20);
      return ctx.asText({ fileCount: args.filePaths.length, symbolCount: result.symbols.length, topSymbols: symbols, hasMoreSymbols: result.symbols.length > symbols.length }, profile);
    }
    if (profile === "verbose") {
      return ctx.asText({ ...result, summary: { fileCount: args.filePaths.length, symbolCount: result.symbols.length, edgeCount: result.edges.length } }, profile);
    }
    return ctx.asText(result, profile);
  }
  const result = store.getFileContext(args.repoId, args.filePath!, args.limit, profile === "compact" || profile === "nano");
  if (profile === "nano") {
    const symbols = (result.symbols as { name: string; kind: string; line: number }[]).slice(0, 12);
    return ctx.asText({ filePath: args.filePath, symbolCount: result.symbols.length, topSymbols: symbols, hasMoreSymbols: result.symbols.length > symbols.length }, profile);
  }
  if (profile === "verbose") {
    return ctx.asText({ ...result, summary: { symbolCount: result.symbols.length, edgeCount: result.edges.length } }, profile);
  }
  return ctx.asText(result, profile);
}

// ── index meta helper ─────────────────────────────────────────────────────────

type IndexMeta = {
  branch: string | null;
  commitSha: string | null;
  indexedAt: string;
  indexLag?: { commitsBehind?: number; dirtyCount: number };
  dirtyFiles?: string[];
};

const DIRTY_FILES_CAP = 20;

/**
 * Index provenance for graph-read responses: branch/commitSha/indexedAt. Pure DB read —
 * deterministic, no git subprocess. `withFreshness:true` (ENH-A) additionally probes the
 * git working tree for `indexLag`/`dirtyFiles` so the agent knows which results to distrust
 * mid-edit; both are omitted when the tree is clean and HEAD matches the indexed commit.
 *
 * Freshness is git-derived and therefore NON-deterministic, so it is attached ONLY by
 * edit-verification tools (find_impact_files, change_impact) — never by the navigation
 * tools the token benchmark snapshots (file/folder summary, context pack), which must stay
 * deterministic and lean. Attach per-handler only — NOT in asText (cost; repo-less tools).
 */
export function buildIndexMeta(store: GraphStore, repoId: string, withFreshness = false): IndexMeta | null {
  const latestRun = store.getLatestRun(repoId);
  if (!latestRun) return null;

  const meta: IndexMeta = {
    branch: latestRun.branch,
    commitSha: latestRun.commitSha,
    indexedAt: latestRun.finishedAt
  };

  if (withFreshness) {
    const repo = store.getRepository(repoId);
    if (repo) {
      let dirtyCount = 0;
      try {
        const dirty = collectDirtyFiles(repo.repoPath);
        dirtyCount = dirty.size;
        if (dirtyCount > 0) {
          meta.dirtyFiles = [...dirty].slice(0, DIRTY_FILES_CAP);
        }
      } catch {
        // non-git repo / git error — leave dirty info off
      }
      const staleness = getRepoStaleness(repoId, store);
      const commitsBehind = staleness.isStale
        ? countCommitsBehind(repo.repoPath, latestRun.commitSha) ?? undefined
        : undefined;
      // Surface indexLag whenever the tree is dirty OR the index is stale — gate on isStale,
      // not on commitsBehind, which is falsy-zero for a diverged/rewound HEAD and would
      // otherwise drop the staleness signal on a clean tree.
      if (dirtyCount > 0 || staleness.isStale) {
        meta.indexLag = { dirtyCount, ...(commitsBehind !== undefined ? { commitsBehind } : {}) };
      }
    }
  }

  return meta;
}

// ── get_folder_summary ────────────────────────────────────────────────────────

export function handleGetFolderSummary(
  args: { repoId: string; folderPath: string; maxFiles: number; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  const result = ctx.store.getFolderSummary(args.repoId, args.folderPath, args.maxFiles);
  return ctx.asText({ ...result, indexMeta: buildIndexMeta(ctx.store, args.repoId) }, profile);
}

// ── route_map ────────────────────────────────────────────────────────────────

export function handleRouteMap(
  args: { repoId: string; filePathPrefix?: string; httpMethod?: string; limit: number; excludeTests: boolean; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  const routesRaw = store.getRouteMap(args.repoId, args.filePathPrefix ?? null, args.httpMethod ?? null, args.limit);
  // MCP-ISSUE-049: 6 of 34 routes in the filed case were test-only endpoints.
  const routes = args.excludeTests ? routesRaw.filter((r) => !isTestPath(r.filePath)) : routesRaw;

  /**
   * MCP-ISSUE-060: `hasMore` at every profile, not only nano.
   *
   * Measured on `wec.be`: `route_map` at `compact` — the documented default — returned
   * `{"count":100,"routes":[...]}` with no `hasMore`, no `total`, nothing. The SAME query at `nano`
   * returned `hasMore: true`. A monolith with hundreds of controllers reported 100 routes as if that
   * were all of them. `routesRaw.length >= args.limit` is the honest signal: the store's own LIMIT
   * bound the result, so more may exist. It is computed BEFORE `excludeTests` filters, because that
   * filter shrinks the page without changing whether the query hit its cap.
   */
  const routesTruncated = routesRaw.length >= args.limit;

  const emptyHint =
    routes.length === 0
      ? { hint: "no routes found — route_map reads C# attribute and minimal-API routing, plus JS/TS app|router|fastify.VERB('/path', handler). Not read yet: NestJS decorators, Next.js file routing, app.use(prefix, router) mounting, all/head/options. Try find_entry_points(kind='route_handler')." }
      : {};

  if (profile === "nano") {
    const topRoutes = routes.slice(0, 10).map((r) => ({ method: r.httpMethod, route: r.routeTemplate, handlerName: r.handlerName, filePath: r.filePath }));
    return ctx.asText({ repoId: args.repoId, count: routes.length, hasMore: routesTruncated || routes.length > topRoutes.length, topRoutes, ...emptyHint }, profile);
  }
  if (profile === "compact") {
    return ctx.asText({ repoId: args.repoId, count: routes.length, hasMore: routesTruncated, routes: routes.map((r) => ({ filePath: r.filePath, controllerName: r.controllerName, handlerName: r.handlerName, httpMethod: r.httpMethod, routeTemplate: r.routeTemplate, line: r.line })), ...emptyHint }, profile);
  }
  if (profile === "verbose") {
    const byMethod = routes.reduce<Record<string, number>>((acc, row) => { acc[row.httpMethod] = (acc[row.httpMethod] ?? 0) + 1; return acc; }, {});
    return ctx.asText({ repoId: args.repoId, count: routes.length, hasMore: routesTruncated, routes, summary: { byMethod }, ...emptyHint }, profile);
  }
  return ctx.asText({ repoId: args.repoId, count: routes.length, hasMore: routesTruncated, routes, ...emptyHint }, profile);
}

// ── query_graph ───────────────────────────────────────────────────────────────

// The allowlist is the scope table: a table is readable exactly when it has a repo filter.
const ALLOWED_QUERY_GRAPH_TABLES = new Set(Object.keys(QUERY_GRAPH_TABLE_SCOPES));

export function handleQueryGraph(
  args: { repoId: string; sql: string; params?: Record<string, unknown>; limit: number; timeoutMs: number; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);

  const readOnlyCheck = validateReadOnlyGraphSql(args.sql);
  if (!readOnlyCheck.ok) {
    throw new McpError(ErrorCode.InvalidParams, readOnlyCheck.message);
  }
  const allowlistCheck = validateAllowedTables(
    readOnlyCheck.sanitizedSql,
    ALLOWED_QUERY_GRAPH_TABLES
  );
  if (!allowlistCheck.ok) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${allowlistCheck.message} Allowed tables: ${[...ALLOWED_QUERY_GRAPH_TABLES].join(", ")}.`
    );
  }

  let result: ReturnType<typeof store.runReadOnlyGraphQuery>;
  try {
    result = store.runReadOnlyGraphQuery(allowlistCheck.sanitizedSql, { ...args.params, repoId: args.repoId }, args.limit, args.timeoutMs);
  } catch (err: unknown) {
    // A scope refusal is the caller's mistake, not a failed query, and its message is ours.
    if (err instanceof QueryGraphScopeError) {
      throw new McpError(ErrorCode.InvalidParams, err.message);
    }
    const raw = err instanceof Error ? err.message : String(err);
    const safe = raw.replace(/['"][^'"]{0,200}['"]/g, "'...'").slice(0, 300);
    throw new McpError(ErrorCode.InternalError, `query_graph: query failed — ${safe}. Check SQL syntax and allowed tables.`);
  }

  const { elapsedMs, timedOut: timeoutExceeded } = result;
  if (timeoutExceeded) {
    throw new McpError(ErrorCode.InvalidRequest, `query_graph: query exceeded timeout of ${args.timeoutMs}ms (took ${elapsedMs}ms). Simplify the query or increase timeoutMs.`);
  }

  if (profile === "nano") {
    return ctx.asText({ columns: result.columns, rowCount: result.rowCount, truncated: result.truncated, elapsedMs, timeoutExceeded }, profile);
  }
  if (profile === "compact") {
    return ctx.asText({ columns: result.columns, rowCount: result.rowCount, truncated: result.truncated, elapsedMs, timeoutExceeded, rows: result.rows }, profile);
  }
  return ctx.asText({ repoId: args.repoId, sql: allowlistCheck.sanitizedSql, params: { ...args.params, repoId: args.repoId }, limit: args.limit, elapsedMs, timeoutMs: args.timeoutMs, timeoutExceeded, columns: result.columns, rows: result.rows, rowCount: result.rowCount, truncated: result.truncated }, profile);
}

// ── query_docs ────────────────────────────────────────────────────────────────

/**
 * `query_docs` — one tool, one envelope.
 *
 * MCP-ISSUE-049: `mode:"search"` returned a keyed object while `stale` and `coverage` returned bare
 * arrays, so the same tool answered in three shapes and a caller had to branch on the mode it had
 * just requested. All three now return `{ repoId, mode, count, results, ...hint }` — the shape
 * `search` already had, which is also the convention every other read tool here follows.
 */
export function handleQueryDocs(
  args: { repoId: string; mode: "search" | "stale" | "coverage" | "drift" | "links" | "behind" | "language" | "section" | "cites" | "term"; query?: string; headingPrefix?: string; target?: string; includeCodeComments?: boolean; symbolIds?: string[]; filePath?: string; limit: number; maxTokens?: number; minSimilarity?: number; minDaysBehind?: number; minRatioPercent?: number; includeSymbols: boolean; includeCodeMentions: boolean; includeArchived?: boolean; matchMode?: "auto" | "strict" | "phrase"; maxPerFile?: number; contentTypes?: string[]; profile: string },
  ctx: HandlerContext
): CallToolResult {
  if (!ctx.constants.DOCS_TOOLS_ENABLED) {
    throw new McpError(ErrorCode.InvalidParams, "query_docs: docs lane is disabled. Set CODEBASE_INDEX_DOCS_TOOLS_ENABLED=true to enable docs tools.");
  }
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);

  if (args.mode === "search") {
    const matched = store.searchDocs(args.repoId, args.query!, args.limit, args.includeSymbols, args.contentTypes ?? null, args.includeArchived, args.matchMode, args.maxPerFile);
    // MCP-ISSUE-061(d): `results` carries whole doc sections and nothing bounded it. The budget is
    // applied after ranking, so what survives is the most relevant prefix.
    const { kept: results, dropped } = applyResultBudget(matched, args.maxTokens);
    return ctx.asText(
      {
        repoId: args.repoId,
        mode: "search",
        query: args.query,
        count: matched.length,
        returned: results.length,
        ...(dropped > 0 && { truncated: true, resultsDropped: dropped }),
        // A `fallback` row means docs_fts could not answer and this is an unranked LIKE substring
        // scan. Said out loud, because the previous behaviour was to label those rows `broad` and
        // report them exactly like ranked hits.
        ...(matched.some((m) => m.matchTier === "fallback") && {
          degraded: "docs_fts could not be queried, so these are unranked substring matches. Run index_repository with docsMode='on' to rebuild it."
        }),
        results,
        ...(args.includeCodeComments !== false && codeCommentsFor(store, args.repoId, args.query!)),
        ...(matched.length === 0 && { hint: "no documentation matched — ensure the docs lane was indexed for this repo (index_repository with docsMode='on') and try broader query terms." })
      },
      profile
    );
  }

  if (args.mode === "term") {
    return ctx.asText(readTerm(store, args.repoId, args.query, args.limit), profile);
  }

  if (args.mode === "cites") {
    return ctx.asText(readCitations(store, args.repoId, args.target, args.filePath, args.limit), profile);
  }

  if (args.mode === "section") {
    return ctx.asText(readDocSection(store, args.repoId, args.filePath!, args.headingPrefix!, args.maxTokens ?? DEFAULT_RESULT_BUDGET_TOKENS), profile);
  }

  if (args.mode === "language") {
    const report = store.findNonEnglishDocs(args.repoId, args.minRatioPercent, args.limit);
    return ctx.asText(
      {
        repoId: args.repoId,
        mode: "language",
        count: report.total,
        returned: report.rows.length,
        ...(report.total > report.rows.length && { droppedByLimit: report.total - report.rows.length }),
        filesScanned: report.filesScanned,
        cleanFiles: report.cleanFiles,
        results: report.rows,
        ...(report.total === 0 && {
          hint: report.filesScanned === 0
            ? "no indexed documents for this repo — the docs lane may not be indexed (index_repository with docsMode='on')."
            : "every indexed document is within the threshold. Non-ASCII typography (em-dashes, arrows, box-drawing) is deliberately not counted, so a clean result here means letters, not punctuation."
        })
      },
      profile
    );
  }

  if (args.mode === "behind") {
    const report = findDocsBehindCode(store, args.repoId, {
      minDaysBehind: args.minDaysBehind,
      limit: args.limit,
      includeArchived: args.includeArchived
    });
    return ctx.asText(
      {
        repoId: args.repoId,
        mode: "behind",
        count: report.total,
        returned: report.rows.length,
        ...(report.total > report.rows.length && { droppedByLimit: report.total - report.rows.length }),
        docsCompared: report.filesCompared,
        results: report.rows,
        ...(report.note && { note: report.note }),
        ...(report.total === 0 && !report.note && {
          hint: "no document is behind the code it mentions. A doc committed before its code is not proof of staleness either — a typo fix bumps a source file without invalidating prose — so this is a review queue, not a verdict."
        })
      },
      profile
    );
  }

  if (args.mode === "links") {
    // MCP-ISSUE-061 Stage 3: broken links, orphans and hubs — set operations over the doclink edges
    // the parser emits, which is the part of docs-first `search_regex` cannot reach.
    const report = store.findDocLinks(args.repoId, args.limit);
    return ctx.asText(
      {
        repoId: args.repoId,
        mode: "links",
        linkCount: report.linkCount,
        docFileCount: report.docFileCount,
        brokenCount: report.brokenTotal,
        // Separate from broken: the target is on disk, just not in the index — almost always a file
        // over CODEBASE_INDEX_MAX_FILE_SIZE_BYTES, which drops a whole file rather than truncating.
        unindexedTargetCount: report.unindexedTotal,
        orphanCount: report.orphanTotal,
        brokenReturned: report.broken.length,
        orphansReturned: report.orphans.length,
        ...(report.brokenTotal > report.broken.length && { brokenDroppedByLimit: report.brokenTotal - report.broken.length }),
        ...(report.orphanTotal > report.orphans.length && { orphansDroppedByLimit: report.orphanTotal - report.orphans.length }),
        broken: report.broken,
        ...(report.unindexedTotal > 0 && {
          unindexedTargets: report.unindexed,
          unindexedNote: "these link targets EXIST on disk but are absent from the index, so they are not broken links — check CODEBASE_INDEX_MAX_FILE_SIZE_BYTES (a file over the cap is skipped whole, not truncated). Until they are indexed, no docs mode can see them."
        }),
        orphans: report.orphans,
        hubs: report.hubs,
        ...(report.linkCount === 0 && {
          hint: "no doc-to-doc links found — re-index with docsMode='on' to populate them (doclink edges are written at index time, so an index built before this feature has none)."
        })
      },
      profile
    );
  }

  if (args.mode === "drift") {
    // MCP-ISSUE-061 Stage 3. Unresolved mentions were already stored (`symbol_id is null`) and never
    // read back; this reads them, but only where a near-miss symbol exists — see findDriftingDocsImpl
    // for why the raw list is dominated by tool names rather than renames.
    const { rows, total, scanned, suppressed } = store.findDriftingDocs(
      args.repoId,
      args.minSimilarity,
      args.limit,
      args.includeCodeMentions
    );
    return ctx.asText(
      {
        repoId: args.repoId,
        mode: "drift",
        count: total,
        returned: rows.length,
        ...(total > rows.length && { droppedByLimit: total - rows.length }),
        unresolvedMentionsScanned: scanned,
        // Near-misses that cleared the similarity bar and were then rejected as a known false-positive
        // class. Reported rather than dropped quietly, so the queue's size is never a mystery.
        ...(suppressed.plainWord + suppressed.nonProductionTarget + suppressed.liveLiteral > 0 && {
          suppressedAsNoise: suppressed
        }),
        minSimilarity: args.minSimilarity ?? 0.75,
        results: rows,
        ...(total === 0 && {
          hint: scanned === 0
            ? "no unresolved doc mentions for this repo — the docs lane may not be indexed (index_repository with docsMode='on')."
            : `${String(scanned)} unresolved mentions, none close enough to an indexed symbol to look like a rename. Lower minSimilarity to widen, but note most unresolved mentions are tool names, flags and ordinary words in backticks, not drift.`
        })
      },
      profile
    );
  }

  if (args.mode === "stale") {
    // MCP-ISSUE-061(c): `count` used to be `results.length` after an undisclosed 200-row cap, i.e. a
    // page length presented as a total. It is now the true row count, with `returned` and
    // `droppedByLimit` describing the page — the shape MCP-ISSUE-060 settled for `detect_changes`.
    const { rows: results, total } = store.findStaleDocs(
      args.repoId,
      args.symbolIds!,
      args.includeCodeMentions,
      args.limit
    );
    return ctx.asText(
      {
        repoId: args.repoId,
        mode: "stale",
        symbolIds: args.symbolIds,
        count: total,
        returned: results.length,
        ...(total > results.length && { droppedByLimit: total - results.length }),
        results,
        ...(total === 0 && {
          hint: args.includeCodeMentions
            ? "no doc mentions reference these symbols — the docs lane may not be indexed for this repo (index_repository with docsMode='on'), or nothing documents them."
            : "no PROSE doc mentions reference these symbols — the docs lane may not be indexed (index_repository with docsMode='on'), nothing documents them, or they are only named inside fenced code samples (retry with includeCodeMentions=true)."
        })
      },
      profile
    );
  }

  const { rows: results, total } = store.findDocCoverage(args.repoId, args.filePath!, args.limit);
  return ctx.asText(
    {
      repoId: args.repoId,
      mode: "coverage",
      filePath: args.filePath,
      count: total,
      returned: results.length,
      ...(total > results.length && { droppedByLimit: total - results.length }),
      // `documented` counts the RETURNED page, not the file — saying otherwise would repeat 061(c)
      // one field over. `documentedScope` makes that explicit rather than leaving it inferable.
      documented: results.filter((r) => r.hasDocs).length,
      ...(total > results.length && { documentedScope: "returned page only" }),
      results,
      ...(total === 0 && { hint: "no symbols found for this file — check the path against list_repositories/get_file_summary, and that the file was indexed." })
    },
    profile
  );
}

// ── internal graph traversal helpers ─────────────────────────────────────────

function traverseDependencyGraph(store: GraphStore, repoId: string, symbolId: string, depth: number, limit: number) {
  const all: ReturnType<GraphStore["getDependencies"]> = [];
  const visited = new Set<string>();
  let frontier = [symbolId];
  for (let level = 0; level < depth && all.length < limit && frontier.length > 0; level += 1) {
    const nextFrontier: string[] = [];
    for (const current of frontier) {
      if (all.length >= limit) break;
      const edges = store.getDependencies(repoId, current, limit - all.length);
      for (const edge of edges) {
        const key = `${edge.fromId}:${edge.toId}:${edge.type}`;
        if (visited.has(key)) continue;
        visited.add(key);
        all.push(edge);
        nextFrontier.push(edge.toId);
      }
    }
    frontier = nextFrontier;
  }
  return all;
}

function traverseCallGraph(store: GraphStore, repoId: string, symbolId: string, direction: "callers" | "callees", depth: number, limit: number, excludeTests = false) {
  const all: ReturnType<GraphStore["getCallEdges"]> = [];
  const visited = new Set<string>();
  // MCP-ISSUE-022: the callers direction must see through DI. Production code calls the
  // interface method; only tests `new` the concrete class. Seeding the frontier with the
  // symbol's interface siblings (interface method ↔ impl method, class → members) is the
  // query-layer half of that fix — the resolution-layer half is the interface-dispatch
  // CALLS edges written at resolve time. Both are needed: resolution cannot see a caller
  // whose edge lands on the sibling rather than on `symbolId` itself.
  //
  // This lived in services/graph/graphTraversal.ts until S-41 (a1d992c) re-homed the loose
  // src files, inlined the traversal here without it, and left the fixed module orphaned.
  // Covered by scripts/test/test-call-chain-interface.mjs — do not drop it again.
  let frontier =
    direction === "callers"
      ? [symbolId, ...store.expandInterfaceSiblings(repoId, [symbolId]).map((s) => s.symbolId)]
      : [symbolId];
  for (let level = 0; level < depth && all.length < limit && frontier.length > 0; level += 1) {
    const nextFrontier: string[] = [];
    for (const current of frontier) {
      if (all.length >= limit) break;
      // MCP-ISSUE-056: `limit` is spent during traversal, so ORDER decides what survives truncation —
      // `interface-dispatch` edges are a speculative fan-out and must be the ones dropped. That
      // ordering is now inside `getCallEdges`'s SQL (`order by … then 1 else 0 end`), because it has
      // to be applied BEFORE the `limit ?`. Sorting here, as this first shipped, reordered a page the
      // database had already truncated: a no-op for what survives.
      const edges = store.getCallEdges(repoId, current, direction, limit - all.length, excludeTests);
      for (const edge of edges) {
        const key = `${edge.fromId}:${edge.toId}:${edge.type}`;
        if (visited.has(key)) continue;
        visited.add(key);
        all.push(edge);
        nextFrontier.push(direction === "callees" ? edge.toId : edge.fromId);
      }
    }
    frontier = nextFrontier;
  }
  return all;
}
