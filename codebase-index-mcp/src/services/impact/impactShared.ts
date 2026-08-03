/**
 * Shared query fragments and the wiring heuristics: the trivial-callee filter, the edge→symbol CTE, path canonicalisation, wiring-shape detection, and the reliability summary every impact answer carries.
 *
 * Split out of `impactAnalyzer.ts` in S-41 (it was 1458 lines, past the
 * 600-line hard cap). Bodies are unchanged; what moved is which file they live in.
 */

import type Database from "better-sqlite3";
import type { EdgeRecord, GraphHealth, ReliabilitySummary, ResolvedEdge, SymbolRecord } from "../../types/index.js";
import { CALL_TRAVERSAL_EDGE_SQL_LIST, CALL_TRAVERSAL_EDGE_TYPES } from "../../types/index.js";
import { expandInterfaceSiblingsImpl } from "../graph/interfaceSiblings.js";

export const TRIVIAL_CALLEE_TOKENS = new Set([
  "map", "filter", "find", "findIndex", "findLast", "forEach", "reduce", "reduceRight",
  "some", "every", "flat", "flatMap", "includes", "indexOf", "lastIndexOf", "join",
  "sort", "reverse", "slice", "splice", "pop", "push", "shift", "unshift", "fill",
  "entries", "keys", "values", "at", "concat", "copyWithin",
  "trim", "trimStart", "trimEnd", "split", "replace", "replaceAll", "startsWith", "endsWith",
  "padStart", "padEnd", "substring", "toUpperCase", "toLowerCase", "charAt", "charCodeAt",
  "then", "catch", "finally", "resolve", "reject", "all", "allSettled", "race", "any",
  "get", "set", "has", "delete", "clear", "add", "size",
  "call", "apply", "bind", "toString", "valueOf", "hasOwnProperty",
  "next", "done", "return", "throw",
  "on", "off", "once", "emit", "pipe", "removeListener", "removeAllListeners",
  "write", "end", "close", "destroy",
  "log", "warn", "error", "info", "debug",
  "prepare", "run", "exec", "iterate",
  "from", "assign", "freeze", "create", "hasOwn", "fromEntries", "is", "keys",
  "now", "parse", "stringify",
  "randomUUID", "createHash", "createHmac", "update", "digest",
  "glob", "stat", "readFile", "writeFile", "mkdir", "rmdir", "unlink",
  "relative", "basename", "dirname", "extname", "resolve", "normalize",
  "execSync", "execFileSync", "spawnSync",
]);

export const TRIVIAL_CALLEE_IN_CLAUSE = [...TRIVIAL_CALLEE_TOKENS]
  .map((t) => `'callee:${t}'`)
  .join(", ");

/**
 * The token grammar for "this edge points at this symbol", as a `pairs` CTE.
 *
 * An edge's `to_id` is either a resolved `symbol_id` or an unresolved token — `callee:Name`,
 * `type:Name`, `property:Name`, `property:Owner.Name` — so matching an edge to a symbol takes
 * six alternatives. They live here so the grammar has exactly one definition, shared by
 * `getImpactSurfaceImpl`, `getImpactFilesImpl` and `GraphStore.getFieldAccesses`.
 *
 * This used to be one `(a or b or c …)` join predicate. A disjunction over concatenated
 * expressions is not indexable, so SQLite could only constrain `e.repo_id` and then test every
 * edge in the repo against every candidate symbol — and it chose the *caller* symbol as the
 * outermost loop, making the join effectively
 * `|symbols in repo| × |symbols in file| × |edges in repo|`. `find_impact_files` on a
 * 107-symbol file measured 14.9 s against a 5.1 k-edge index and 216 s against a larger one.
 *
 * Splitting the disjunction into a `union` of one branch per alternative lets SQLite pick an
 * index per branch (`idx_edges_repo_to` for the resolved case, `idx_edges_repo_type_to` for the
 * token cases) and drive from the small `symbols` side. Measured 448× faster across all 229
 * files of a workspace index, with byte-identical results — see `test:impact-join-parity`.
 *
 * `union` (not `union all`) dedupes on the `(symbol, edge)` pair, which is what the single
 * predicate produced: one join tuple per pair, however many alternatives matched it.
 *
 * @param symbolFilter SQL selecting the target symbols, e.g.
 *   `s.repo_id = @repoId and s.file_path = @filePath`. Referenced once per branch, so any
 *   bound parameters in it must be named (`@x`), not positional.
 */
export function buildEdgeToSymbolPairsCte(symbolFilter: string): string {
  // `cross join` is SQLite's join-order pin, not a cartesian product: it means the same thing
  // as `inner join` but stops the planner reordering. Needed because there are no ANALYZE
  // stats, so the planner cannot tell that `symbolFilter` selects few rows — left to guess it
  // drove the resolved-id branch from `edges`, scanning every edge in the repo once per query.
  // Driving from `symbols` turns each branch into one index seek per target symbol.
  const branch = (edgeOn: string): string =>
    `select s.symbol_id as sid, e.rowid as eid
       from symbols s
       cross join edges e on e.repo_id = s.repo_id and ${edgeOn}
       where ${symbolFilter}`;

  return `pairs as (
    ${branch(`e.to_id = s.symbol_id`)}
    union
    ${branch(`e.type = 'CALLS' and e.to_id = ('callee:' || s.name)`)}
    union
    ${branch(`e.type = 'TYPE_REF' and e.to_id = ('type:' || s.name)`)}
    union
    ${branch(`e.type in ('PROPERTY_REF', 'PROPERTY_WRITE') and e.to_id = ('property:' || s.name)`)}
    union
    -- Qualified 'property:Owner.Member'. The join to the parent stays a LEFT join: a symbol
    -- with no parent yields '' from the coalesce, which is the bare-token branch above.
    select s.symbol_id as sid, e.rowid as eid
      from symbols s
      left join symbols st on st.repo_id = s.repo_id and st.symbol_id = s.parent_symbol_id
      cross join edges e on e.repo_id = s.repo_id
        and e.type in ('PROPERTY_REF', 'PROPERTY_WRITE')
        and e.to_id = ('property:' || coalesce(st.name || '.', '') || s.name)
      where ${symbolFilter}
    union
    -- Any-owner 'property:%.Member'. The only branch a LIKE keeps unindexable on the edge
    -- side, so it is gated on s.kind = 'property' — usually no rows, and never more than
    -- the property symbols the filter selects.
    ${branch(`e.type in ('PROPERTY_REF', 'PROPERTY_WRITE') and s.kind = 'property' and e.to_id like ('property:%.' || s.name)`)}
  )`;
}

// ── Helpers ────────────────────────────────────────────────────────────

export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

// ── DI / reflection wiring detection (ENH-D / ISSUE-014) ────────────────
// MediatR pipeline behaviours, request/notification handlers, and endpoint groups
// are never called statically — they are resolved and invoked via DI/reflection at
// request time, so there is no CALLS edge into them and find_impact_files returns a
// false-empty blast radius. We detect these shapes from IMPLEMENTS edges (record-aware
// after ISSUE-013) so impact responses can explain the empty result instead of implying
// "no dependents". Matched by interface-name PREFIX (generics are already stripped in
// the IMPLEMENTS token, e.g. `iface:IPipelineBehavior`).

const WIRING_INTERFACES: { prefix: string; kind: "mediatr_pipeline" | "mediatr_handler" | "endpoint_group" }[] = [
  { prefix: "IPipelineBehavior", kind: "mediatr_pipeline" },
  { prefix: "IRequestHandler", kind: "mediatr_handler" },
  { prefix: "INotificationHandler", kind: "mediatr_handler" },
  { prefix: "IEndpointGroup", kind: "endpoint_group" }
];

const WIRING_NAME_SUFFIXES = ["Behaviour", "Behavior", "Endpoints", "EndpointGroup"];

export type WiringShape = {
  wired: boolean;
  kind: "mediatr_pipeline" | "mediatr_handler" | "endpoint_group" | null;
  matchedInterface: string | null;
  /** Distinct MediatR request types in the repo (impl of IRequest), for the pipeline note. */
  requestCount: number;
};

/** Strip a possible `iface:` prefix and generic args from an IMPLEMENTS target token. */
function ifaceNameFromToken(token: string): string {
  return token.replace(/^iface:/, "").replace(/<.*>$/, "").trim();
}

function detectWiringShapeImpl(
  db: Database.Database,
  repoId: string,
  filePath: string
): WiringShape {
  const canonicalFilePath = resolveCanonicalFilePath(db, repoId, filePath);

  // Interfaces implemented by any type declared in this file (resolved name OR iface: placeholder).
  const rows = db
    .prepare(
      `
      select e.to_id as toId, si.name as ifaceName, s.name as symName, s.kind as symKind
      from symbols s
      inner join edges e
        on e.repo_id = s.repo_id and e.from_id = s.symbol_id and e.type = 'IMPLEMENTS'
      left join symbols si on si.repo_id = e.repo_id and si.symbol_id = e.to_id
      where s.repo_id = ? and s.file_path = ?
      `
    )
    .all(repoId, canonicalFilePath) as { toId: string; ifaceName: string | null; symName: string; symKind: string }[];

  let matched: { kind: WiringShape["kind"]; matchedInterface: string } | null = null;
  for (const r of rows) {
    const name = r.ifaceName ?? ifaceNameFromToken(r.toId);
    const hit = WIRING_INTERFACES.find((w) => name === w.prefix || name.startsWith(w.prefix));
    if (hit) {
      matched = { kind: hit.kind, matchedInterface: name };
      break;
    }
  }

  // Fallback: name-suffix heuristic over the file's own type symbols.
  if (!matched) {
    const suffixHit = rows.find(
      (r) =>
        (r.symKind === "class" || r.symKind === "struct" || r.symKind === "interface" || r.symKind === "record" || r.symKind === "record struct") &&
        WIRING_NAME_SUFFIXES.some((suf) => r.symName.endsWith(suf))
    );
    if (suffixHit) {
      const kind = /Endpoint/.test(suffixHit.symName) ? "endpoint_group" : "mediatr_pipeline";
      matched = { kind, matchedInterface: suffixHit.symName };
    }
  }

  if (!matched) {
    return { wired: false, kind: null, matchedInterface: null, requestCount: 0 };
  }

  // For pipeline behaviours, count distinct request types (impl of IRequest) for the note.
  let requestCount = 0;
  if (matched.kind === "mediatr_pipeline") {
    const countRow = db
      .prepare(
        `
        select count(distinct e.from_id) as n
        from edges e
        left join symbols si on si.repo_id = e.repo_id and si.symbol_id = e.to_id
        where e.repo_id = ? and e.type = 'IMPLEMENTS'
          and (e.to_id like 'iface:IRequest%' or si.name like 'IRequest%')
        `
      )
      .get(repoId) as { n: number } | undefined;
    requestCount = countRow?.n ?? 0;
  }

  return { wired: true, kind: matched.kind, matchedInterface: matched.matchedInterface, requestCount };
}

/** Human-readable note explaining why a wired type has an empty static blast radius. */
function buildWiringNote(shape: WiringShape): string {
  const label = shape.matchedInterface ?? shape.kind ?? "DI-wired type";
  if (shape.kind === "mediatr_pipeline") {
    const flow = shape.requestCount > 0 ? ` — ${String(shape.requestCount)} requests flow through the MediatR pipeline` : " — requests are dispatched through the MediatR pipeline at runtime";
    return `type is DI/reflection-wired (${label}); static impact graph is incomplete${flow}. Run the full test suite to scope shared-infra changes.`;
  }
  if (shape.kind === "endpoint_group") {
    return `type is reflection-registered (${label}); endpoints are auto-discovered, so static callers are empty. Use route_map for the endpoint surface.`;
  }
  return `type is DI/reflection-wired (${label}); callers are resolved at runtime via the DI container, so the static impact graph is incomplete.`;
}

/** Wiring note for a file, or undefined if it isn't a recognized DI/reflection-wired shape. */
export function wiringNoteFor(db: Database.Database, repoId: string, canonicalFilePath: string): string | undefined {
  const shape = detectWiringShapeImpl(db, repoId, canonicalFilePath);
  return shape.wired ? buildWiringNote(shape) : undefined;
}

export function resolveCanonicalFilePath(db: Database.Database, repoId: string, filePath: string): string {
  const normalized = normalizePath(filePath);

  const fileRow = db
    .prepare(
      `
      select path as filePath
      from files
      where repo_id = ? and lower(replace(path, char(92), '/')) = lower(?)
      order by case when lower(path) = lower(?) then 0 else 1 end
      limit 1
      `
    )
    .get(repoId, normalized, filePath) as { filePath: string } | undefined;

  if (fileRow?.filePath) {
    return fileRow.filePath;
  }

  const symbolRow = db
    .prepare(
      `
      select file_path as filePath
      from symbols
      where repo_id = ? and lower(replace(file_path, char(92), '/')) = lower(?)
      order by case when lower(file_path) = lower(?) then 0 else 1 end
      limit 1
      `
    )
    .get(repoId, normalized, filePath) as { filePath: string } | undefined;

  if (symbolRow?.filePath) {
    return symbolRow.filePath;
  }

  return normalized;
}

export function findModuleSymbolId(db: Database.Database, repoId: string, filePath: string): string | null {
  const row = db
    .prepare(`select symbol_id as symbolId from symbols where repo_id = ? and file_path = ? and kind = 'module' limit 1`)
    .get(repoId, filePath) as { symbolId: string } | undefined;
  return row?.symbolId ?? null;
}

export function getEdgeDefaults(edge: EdgeRecord): { confidence: number; reason: string } {
  if (edge.toId.startsWith("callee:")) {
    return { confidence: 0.4, reason: "unresolved callee token" };
  }
  if (edge.toId.startsWith("import:")) {
    return { confidence: 0.5, reason: "unresolved import token" };
  }
  if (edge.toId.startsWith("type:")) {
    return { confidence: 0.45, reason: "unresolved type token" };
  }
  if (edge.toId.startsWith("property:")) {
    return { confidence: 0.5, reason: "unresolved property token" };
  }
  if (edge.type === "CALLS") {
    return { confidence: 1.0, reason: "resolved call edge" };
  }
  if (edge.type === "IMPORTS") {
    return { confidence: 0.95, reason: "resolved import edge" };
  }
  if (edge.type === "TYPE_REF") {
    return { confidence: 0.9, reason: "resolved type reference" };
  }
  if (edge.type === "PROPERTY_REF") {
    return { confidence: 0.85, reason: "resolved property read" };
  }
  if (edge.type === "PROPERTY_WRITE") {
    return { confidence: 0.82, reason: "resolved property write" };
  }
  return { confidence: 1.0, reason: "direct edge" };
}

export function buildReliabilitySummaryImpl(confidences: number[], graphHealth: GraphHealth): ReliabilitySummary {
  // Filter out external/builtin edges (confidence = 0.8) for internal reliability calculation
  const internalConf = confidences.filter((c) => c !== 0.8);
  const sorted = [...internalConf].sort((a, b) => a - b);
  const edgeCount = sorted.length;
  const medianConfidence = edgeCount === 0
    ? 1
    : (edgeCount % 2 === 0
        ? (sorted[edgeCount / 2 - 1] + sorted[edgeCount / 2]) / 2
        : sorted[Math.floor(edgeCount / 2)]);

  const lowConfidenceEdgeCount = sorted.filter((c) => c < 0.75).length;
  
  // Calculate unresolved edges with better categorization
  const unresolvedCalls = graphHealth.unresolvedCalls || 0;
  const unresolvedImports = graphHealth.unresolvedImports || 0;
  const unresolvedTypeRefs = graphHealth.unresolvedTypeRefs || 0;
  const unresolvedProperties = graphHealth.unresolvedProperties || 0;
  
  // Total unresolved (excluding external/builtin imports which are expected)
  const internalUnresolved = unresolvedCalls + unresolvedImports + unresolvedTypeRefs + unresolvedProperties;
  const unresolvedTotal = internalUnresolved;
  
  // Calculate unresolved ratio: unresolved / (resolved + unresolved)
  const unresolvedRatio = edgeCount + unresolvedTotal > 0
    ? unresolvedTotal / (edgeCount + unresolvedTotal)
    : 0;

  // Improved warning logic with more granular thresholds
  let warning: string | null = null;
  if (unresolvedRatio > 0.3) {
    // High unresolved ratio - results likely incomplete
    const breakdown: string[] = [];
    if (unresolvedCalls > 0) breakdown.push(`${unresolvedCalls} call${unresolvedCalls > 1 ? "s" : ""}`);
    if (unresolvedProperties > 0) breakdown.push(`${unresolvedProperties} property ref${unresolvedProperties > 1 ? "s" : ""}`);
    if (unresolvedTypeRefs > 0) breakdown.push(`${unresolvedTypeRefs} type ref${unresolvedTypeRefs > 1 ? "s" : ""}`);
    if (unresolvedImports > 0) breakdown.push(`${unresolvedImports} import${unresolvedImports > 1 ? "s" : ""}`);
    
    warning = `High unresolved ratio (${Math.round(unresolvedRatio * 100)}%): ${breakdown.join(", ")} unresolved — results may be incomplete. Consider re-indexing.`;
  } else if (unresolvedRatio > 0.15) {
    // Medium unresolved ratio - results partially incomplete
    warning = `${internalUnresolved} edge${internalUnresolved > 1 ? "s" : ""} unresolved (${Math.round(unresolvedRatio * 100)}%) — results may be partially incomplete`;
  } else if (medianConfidence < 0.75 && lowConfidenceEdgeCount > 5) {
    // Low confidence edges
    warning = `${lowConfidenceEdgeCount} low-confidence edge${lowConfidenceEdgeCount > 1 ? "s" : ""} — verify critical results`;
  } else if (unresolvedRatio > 0.05 && internalUnresolved > 0) {
    // Low unresolved ratio - acceptable but worth noting
    warning = `${internalUnresolved} edge${internalUnresolved > 1 ? "s" : ""} unresolved (${Math.round(unresolvedRatio * 100)}%) — impact coverage is good`;
  }

  return {
    edgeCount,
    medianConfidence,
    lowConfidenceEdgeCount,
    unresolvedRatio,
    warning
  };
}

export function countUnresolvedEdgesForFileImpl(db: Database.Database, repoId: string, filePath: string, symbolId?: string): GraphHealth {
  const canonicalFilePath = resolveCanonicalFilePath(db, repoId, filePath);

  const symbolFilter = symbolId ? "AND e.from_id = ?" : "";
  const row = db
    .prepare(
      `
      select
        count(case when e.to_id like 'callee:%'
          and e.to_id not in (${TRIVIAL_CALLEE_IN_CLAUSE}) then 1 end) as unresolvedCalls,
        count(case when e.to_id like 'import:%'
          and coalesce(e.reason, '') not in ('node_builtin', 'npm_package') then 1 end) as unresolvedImports,
        count(case when e.type = 'IMPORTS' then 1 end) as importsTotal,
        count(case when e.type = 'IMPORTS' and coalesce(e.reason, '') != 'unresolved import token' then 1 end) as importsClassified,
        count(case when e.to_id like 'type:%' then 1 end) as unresolvedTypeRefs,
        count(case when e.to_id like 'property:%' then 1 end) as unresolvedProperties
      from edges e
      inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
      where e.repo_id = ? and replace(s.file_path, char(92), '/') = replace(?, char(92), '/')
      ${symbolFilter}
      `
    )
    .get(...([repoId, canonicalFilePath, ...(symbolId ? [symbolId] : [])] as [string, string, ...string[]])) as { 
      unresolvedCalls: number; 
      unresolvedImports: number; 
      importsTotal: number;
      importsClassified: number;
      unresolvedTypeRefs: number;
      unresolvedProperties: number;
    };

  const bridgeRow = db
    .prepare(
      `
      select count(case when e.reason = 'namespace package contract bridge' then 1 end) as packageBridgeImports
      from edges e
      inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
      where e.repo_id = ? and e.type = 'DEPENDS_ON'
        and replace(s.file_path, char(92), '/') = replace(?, char(92), '/')
      ${symbolFilter}
      `
    )
    .get(...([repoId, canonicalFilePath, ...(symbolId ? [symbolId] : [])] as [string, string, ...string[]])) as { packageBridgeImports: number } | undefined;

  const { unresolvedCalls, unresolvedImports, importsTotal, importsClassified, unresolvedTypeRefs, unresolvedProperties } = row ?? { 
    unresolvedCalls: 0, 
    unresolvedImports: 0, 
    importsTotal: 0,
    importsClassified: 0,
    unresolvedTypeRefs: 0,
    unresolvedProperties: 0
  };

  const classifiedImports = importsClassified + (bridgeRow?.packageBridgeImports ?? 0);
  const importClassificationRatio = importsTotal > 0 ? Math.min(1, classifiedImports / importsTotal) : 1;
  
  let note: string;
  if (unresolvedCalls === 0 && unresolvedImports === 0 && unresolvedTypeRefs === 0 && unresolvedProperties === 0) {
    note = importsTotal > 0
      ? `graph data complete; imports classified ${classifiedImports}/${importsTotal} (${Math.round(importClassificationRatio * 100)}%)`
      : "graph data complete";
  } else {
    const parts: string[] = [];
    if (unresolvedCalls > 0) parts.push(`${unresolvedCalls} call edge${unresolvedCalls > 1 ? "s" : ""} unresolved`);
    if (unresolvedProperties > 0) parts.push(`${unresolvedProperties} property ref${unresolvedProperties > 1 ? "s" : ""} unresolved`);
    if (unresolvedImports > 0) parts.push(`${unresolvedImports} import edge${unresolvedImports > 1 ? "s" : ""} unresolved`);
    if (unresolvedTypeRefs > 0) parts.push(`${unresolvedTypeRefs} type reference${unresolvedTypeRefs > 1 ? "s" : ""} unresolved`);
    const importNote = importsTotal > 0
      ? ` imports classified ${classifiedImports}/${importsTotal} (${Math.round(importClassificationRatio * 100)}%)`
      : "";
    note = `${parts.join(", ")} — results may be incomplete${importNote}`;
  }

  return { unresolvedCalls, unresolvedImports, unresolvedTypeRefs, unresolvedProperties, importsTotal, importsClassified: classifiedImports, importClassificationRatio, note };
}
// ── getImpactSurface ───────────────────────────────────────────────────
