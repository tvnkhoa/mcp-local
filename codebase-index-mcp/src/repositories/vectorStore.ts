/**
 * vectorStore.ts — Trigram-based deterministic vector store for symbol search.
 *
 * No LLM invocations. Uses character 3-gram hashing to build Float32Array(512)
 * embeddings. Supports sqlite-vec (vec0 virtual table) with in-memory Map fallback.
 *
 * Policy: CODEBASE_INDEX_LLM_ENABLED must remain false. This file must not import
 * any LLM client library.
 */

import type Database from "better-sqlite3";
import { indexLog, indexWarn } from "../services/indexing/indexProgress.js";
import { booleanFromEnv, optionalStringFromEnv } from "../config/envConfig.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const VECTOR_DIMS = 512;

// Only index these kinds — avoids false positives from property/variable noise
const VECTOR_SYMBOL_KINDS = new Set(["function", "method", "class", "interface", "struct"]);

// BCL / framework namespaces — never resolvable within the repo
const KNOWN_EXTERNAL_NAMESPACES = new Set([
  "System",
  "Microsoft",
  "Amazon",
  "Google",
  "Grpc",
  "Elsa",
  "AutoMapper",
  "Serilog",
  "MassTransit",
  "FluentValidation",
  "Swashbuckle",
  "Quartz",
  "CsvHelper",
  "SixLabors",
  "StackExchange",
  "Renci",
  "Ardalis",
]);

// Cross-repo internal namespaces — may be resolvable if those repos are indexed in the same DB.
// Configurable via CODEBASE_INDEX_CROSS_REPO_NAMESPACES (comma-separated top-level namespaces).
// Default: ["SSNet", "CRM"]. These are NOT treated as external; the cross-repo resolver handles them.
function buildCrossRepoNamespaces(): Set<string> {
  const raw = optionalStringFromEnv("CODEBASE_INDEX_CROSS_REPO_NAMESPACES");
  if (raw && raw.trim()) {
    return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  }
  return new Set(["SSNet", "CRM"]);
}
const KNOWN_CROSS_REPO_NAMESPACES = buildCrossRepoNamespaces();

// LINQ extension methods
const KNOWN_LINQ_METHODS = new Set([
  "Select", "Where", "FirstOrDefault", "First", "LastOrDefault", "Last",
  "Any", "All", "Count", "Sum", "Min", "Max", "Average",
  "GroupBy", "OrderBy", "OrderByDescending", "ThenBy", "ThenByDescending",
  "Include", "ThenInclude", "Skip", "Take", "Distinct", "Union",
  "ToList", "ToArray", "ToDictionary", "ToHashSet",
  "ToListAsync", "FirstOrDefaultAsync", "FirstAsync", "AnyAsync",
  "CountAsync", "SingleOrDefaultAsync", "SingleAsync", "SaveChangesAsync",
]);

// BCL string / reflection methods
const KNOWN_BCL_METHODS = new Set([
  "IsNullOrEmpty", "IsNullOrWhiteSpace", "ToLower", "ToUpper",
  "Trim", "TrimStart", "TrimEnd", "Split", "Join", "Replace",
  "Contains", "StartsWith", "EndsWith", "Substring", "IndexOf",
  "Format", "Concat", "Compare", "Equals",
  "CreateInstance", "GetType", "GetMethod", "GetProperty",
  "Parse", "TryParse", "ToString", "GetValue", "SetValue",
]);

// Serilog static logger methods
const KNOWN_LOGGER_METHODS = new Set([
  "Information", "Warning", "Error", "Debug", "Verbose", "Fatal",
  "Log.Information", "Log.Warning", "Log.Error", "Log.Debug",
]);

// FluentMigrator DSL methods
const KNOWN_MIGRATION_METHODS = new Set([
  "DropColumn", "AddColumn", "AlterColumn", "CreateTable", "DropTable",
  "RenameTable", "RenameColumn", "CreateIndex", "DropIndex",
  "Insert", "Delete", "Execute", "IfDatabase", "Column",
]);

// ── Fallback in-memory store ───────────────────────────────────────────────────

// symbolId → Float32Array(512)
const inMemoryVectors = new Map<string, Float32Array>();
// repoId → Set<symbolId>
const inMemoryRepoIndex = new Map<string, Set<string>>();

// ── State ──────────────────────────────────────────────────────────────────────

/** vec0 is loaded and usable. Says nothing about whether we are ALLOWED to use vectors. */
let _vectorEnabled = false;

export function isVectorEnabled(): boolean {
  return _vectorEnabled && vectorsAllowed();
}

/**
 * `CODEBASE_INDEX_VECTOR_ENABLED=false` turns vector search off entirely — not "fall back to the
 * in-memory index", genuinely off: `vectorSearchSymbols` returns nothing and no vectors are built.
 *
 * The distinction matters because this exists to be a CONTROL. Edge counts for the resolved types
 * (CALLS, TYPE_REF, IMPLEMENTS, CONSUMES, PUBLISHES) varied between identical full re-index runs, and
 * attributing that to the vector fallback was guesswork until it could be switched off and the run
 * repeated. A switch that quietly re-routed to a different vector implementation would have answered
 * a different question.
 *
 * Read per call rather than cached at module load so a test can flip it between runs in one process.
 */
function vectorsAllowed(): boolean {
  return booleanFromEnv("CODEBASE_INDEX_VECTOR_ENABLED", true);
}

// ── Text normalization ─────────────────────────────────────────────────────────

/**
 * Strip generic type arguments: "AddColumn<string>" → "AddColumn"
 */
export function stripGenerics(name: string): string {
  return name.replace(/<[^>]*>/g, "").trim();
}

/**
 * Normalize symbol name + optional signature into a single text for trigram encoding.
 * - lowercase
 * - strip generics
 * - strip known prefixes (callee:, property:, import:, type:)
 * - split PascalCase tokens
 */
function normalizeSymbolText(name: string, signature?: string): string {
  // Strip known edge prefixes
  let text = name
    .replace(/^(callee:|property:|import:|type:)/, "")
    .replace(/<[^>]*>/g, " ");

  // Split PascalCase / camelCase into tokens
  text = text
    .replace(/([A-Z][a-z]+|[A-Z]{2,}(?=[A-Z][a-z]|$)|[A-Z]{2,})/g, " $1")
    .replace(/[._\-/\\]+/g, " ")
    .toLowerCase()
    .trim();

  if (signature) {
    const sigNorm = signature
      .replace(/<[^>]*>/g, " ")
      .replace(/[^a-z0-9 ]/gi, " ")
      .toLowerCase()
      .trim();
    text = `${text} ${sigNorm}`;
  }

  return text;
}

// ── Trigram vector ─────────────────────────────────────────────────────────────

/**
 * Build a deterministic trigram-based Float32Array vector.
 * Uses djb2-style hash to map each trigram to a dimension index.
 */
function trigramVector(text: string, dims = VECTOR_DIMS): Float32Array {
  const vec = new Float32Array(dims);
  const tokens = text.split(/\s+/).filter((t) => t.length >= 2);

  for (const token of tokens) {
    if (token.length < 3) {
      // For short tokens, use the whole token as a "trigram"
      const h = djb2Hash(token) % dims;
      vec[h] += 1;
      continue;
    }
    for (let i = 0; i <= token.length - 3; i++) {
      const trigram = token.slice(i, i + 3);
      const h = djb2Hash(trigram) % dims;
      vec[h] += 1;
    }
  }

  // L2-normalize
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
  if (norm > 0) {
    norm = Math.sqrt(norm);
    for (let i = 0; i < dims; i++) vec[i] /= norm;
  }

  return vec;
}

function djb2Hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

// ── External token checks ──────────────────────────────────────────────────────

export function isKnownExternalNamespace(ns: string): boolean {
  // Only pure external (BCL/framework) namespaces. Cross-repo namespaces are intentionally
  // excluded — they are handled by the cross-repo import resolver, not tagged as external.
  return KNOWN_EXTERNAL_NAMESPACES.has(ns);
}

export function isKnownCrossRepoNamespace(ns: string): boolean {
  return KNOWN_CROSS_REPO_NAMESPACES.has(ns);
}

// Known BCL/framework type receivers — qualified calls like Guid.NewGuid, Task.FromResult
const KNOWN_EXTERNAL_TYPE_RECEIVERS = new Set([
  "Guid", "Task", "Path", "File", "Directory", "Environment", "Regex",
  "Convert", "Math", "Console", "Enum", "Activator", "Type", "Array",
  "String", "Int32", "Int64", "Double", "Decimal", "Boolean", "DateTime", "DateTimeOffset", "TimeSpan",
  "JsonConvert", "JsonSerializer", "JObject", "JArray", "JToken",
  "HttpUtility", "WebUtility", "Uri", "Encoding",
  "Assert", "Is", "Has", "Does", "Throws", // NUnit/xUnit assertion
  "Mock", "It", "Times", // Moq
  "Log", "LogContext", // Serilog statics
  "HostBuilder", "Host", "WebApplication",
  "ILogger", "IServiceProvider", "IConfiguration", "IHostEnvironment", "IHostApplicationLifetime",
  "IOptions", "IOptionsSnapshot", "IOptionsMonitor", "HttpClient", "IMemoryCache", "IDistributedCache",
  "IMediator", "IMapper", "IServiceCollection", "IApplicationBuilder", "IEndpointRouteBuilder",
  "CancellationToken", "CancellationTokenSource", "IAsyncEnumerable", "IQueryable",
]);

/**
 * Is this BARE token the name of a BCL/framework type?
 *
 * Deliberately separate from `isKnownExternalToken`, which only consults
 * `KNOWN_EXTERNAL_TYPE_RECEIVERS` for a qualified `Receiver.Method` token. That restriction is
 * load-bearing for the CALLS lane, which calls `isKnownExternalToken` on bare *method* names —
 * and this set contains `Log`, `Is`, `Has`, `Type`, `String` and `Mock`, so making the token check
 * accept bare names would silently suppress real call edges (MCP-ISSUE-045).
 *
 * The TYPE_REF lane needs the opposite question — "is bare `Task` a framework type?" — and asks it
 * only after same-repo resolution has already failed, so a false positive here costs a cross-repo
 * link to a framework type, which is never correct anyway.
 */
export function isKnownExternalTypeName(name: string): boolean {
  return KNOWN_EXTERNAL_TYPE_RECEIVERS.has(name);
}

export function isKnownExternalToken(token: string): boolean {
  // Check simple token first (terminal method name)
  if (
    KNOWN_LINQ_METHODS.has(token) ||
    KNOWN_BCL_METHODS.has(token) ||
    KNOWN_LOGGER_METHODS.has(token) ||
    KNOWN_MIGRATION_METHODS.has(token)
  ) {
    return true;
  }

  // Check qualified form: Receiver.Method — if receiver is a known external type
  if (token.includes(".")) {
    const receiver = token.split(".")[0];
    if (receiver && KNOWN_EXTERNAL_TYPE_RECEIVERS.has(receiver)) {
      return true;
    }
    // Check if top-level namespace is external (e.g. System.IO.Path.Combine)
    if (receiver && isKnownExternalNamespace(receiver)) {
      return true;
    }
  }

  return false;
}

// ── sqlite-vec initialization ──────────────────────────────────────────────────

/**
 * Attempt to load sqlite-vec extension into the given database.
 * Returns true if vec0 virtual tables are available.
 * Uses the provided require function (createRequire from node:module).
 */
export function initVectorStore(db: Database.Database, requireFn: NodeRequire): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sqliteVec = requireFn("sqlite-vec") as any;
    sqliteVec.load(db);
    _vectorEnabled = true;
    indexLog("[vector] sqlite-vec loaded OK");
    return true;
  } catch (e) {
    indexWarn(`[vector] sqlite-vec unavailable, using in-memory fallback: ${e}`);
    _vectorEnabled = false;
    return false;
  }
}

// ── Schema helpers ─────────────────────────────────────────────────────────────

export function ensureVectorSchema(db: Database.Database, vectorEnabled: boolean): void {
  // Mapping table: repo_id + symbol_id → vec_rowid (auto-assigned by vec0)
  db.exec(`
    CREATE TABLE IF NOT EXISTS vec_symbol_map (
      repo_id   TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      vec_rowid INTEGER,
      PRIMARY KEY (repo_id, symbol_id)
    )
  `);

  if (vectorEnabled) {
    try {
      // `repo_id` is a PARTITION KEY, and that is the whole point of this table definition.
      //
      // Without it, `k` is evaluated against the entire table and `repo_id` is filtered afterwards, in
      // the outer query. This DB is shared by every indexed repo — 34709 vectors across 7 repos when
      // this was found — so a k=3 search asked for the 3 nearest symbols IN THE WORLD and then kept
      // whichever happened to belong to the repo being resolved. Measured on wec.communication-hub
      // (7.7% of the table): of 40 real type names, 34 got fewer than the 3 rows requested and 14 got
      // ZERO despite the repo holding candidates — one had 332. Resolution silently lost its fallback
      // in proportion to how many OTHER repos shared the database.
      //
      // It also made runs non-reproducible: vec0 assigns rowids on insert, `deleteVectorsByRepo`
      // re-inserts on every rebuild, and ties at the k cutoff (common — trigram vectors collide for
      // similar names) broke by rowid. 7 of those 40 queries were tie-affected.
      //
      // With the partition key, vec0 applies k WITHIN the repo and neither problem exists.
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_symbols USING vec0(
          repo_id TEXT partition key,
          embedding float[${VECTOR_DIMS}]
        )
      `);
      migrateUnpartitionedVectorTable(db);
    } catch (e) {
      indexWarn(`[vector] vec0 table creation failed, disabling: ${e}`);
      _vectorEnabled = false;
    }
  }
}

/**
 * A `vec_symbols` created before the partition key existed has no `repo_id` column, so every query
 * against it would fail with "no such column". Vectors are DERIVED data — trigram hashes of
 * `symbols.name` — so the table is dropped and recreated rather than copied, and `vec_symbol_map` is
 * emptied so the next index run rebuilds it.
 *
 * `pragma_table_info` works on vec0 virtual tables and reports the partition key as a column, which is
 * what makes this detectable at all.
 */
function migrateUnpartitionedVectorTable(db: Database.Database): void {
  const columns = db.prepare(`SELECT name FROM pragma_table_info('vec_symbols')`).all() as { name: string }[];
  if (columns.some((c) => c.name === "repo_id")) return;

  indexWarn(
    "[vector] vec_symbols predates the repo_id partition key; dropping and rebuilding. " +
      "Vector-assisted resolution is degraded until the next index run for each repo."
  );
  db.exec(`DROP TABLE vec_symbols`);
  db.exec(`
    CREATE VIRTUAL TABLE vec_symbols USING vec0(
      repo_id TEXT partition key,
      embedding float[${VECTOR_DIMS}]
    )
  `);
  // Leaving stale rows here would point at rowids in a table that no longer has them.
  db.prepare(`DELETE FROM vec_symbol_map`).run();
}

// ── Upsert helpers ─────────────────────────────────────────────────────────────

export function upsertSymbolVector(
  db: Database.Database,
  repoId: string,
  symbolId: string,
  name: string,
  signature?: string
): void {
  if (!vectorsAllowed()) return;

  const text = normalizeSymbolText(name, signature);
  const vec = trigramVector(text);

  if (_vectorEnabled) {
    // Check if already mapped
    const existing = db.prepare(`
      SELECT vec_rowid FROM vec_symbol_map WHERE repo_id = ? AND symbol_id = ?
    `).get(repoId, symbolId) as { vec_rowid: number | null } | undefined;

    if (existing?.vec_rowid != null) {
      // Delete old vec row, insert new one, update map
      db.prepare(`DELETE FROM vec_symbols WHERE rowid = ?`).run(existing.vec_rowid);
    }

    // repo_id is the partition key — omitting it would put the row in an unnamed partition that the
    // scoped search can never reach.
    const info = db
      .prepare(`INSERT INTO vec_symbols (repo_id, embedding) VALUES (?, ?)`)
      .run(repoId, Buffer.from(vec.buffer));
    const vecRowid = Number(info.lastInsertRowid);

    db.prepare(`
      INSERT INTO vec_symbol_map (repo_id, symbol_id, vec_rowid)
      VALUES (?, ?, ?)
      ON CONFLICT(repo_id, symbol_id) DO UPDATE SET vec_rowid = excluded.vec_rowid
    `).run(repoId, symbolId, vecRowid);
  } else {
    // In-memory fallback
    inMemoryVectors.set(`${repoId}:${symbolId}`, vec);
    const repoSet = inMemoryRepoIndex.get(repoId) ?? new Set<string>();
    repoSet.add(symbolId);
    inMemoryRepoIndex.set(repoId, repoSet);
  }
}

export function batchUpsertSymbolVectors(
  db: Database.Database,
  repoId: string,
  symbols: { symbolId: string; name: string; signature?: string }[]
): number {
  const eligible = symbols.filter((s) => {
    // Only index eligible kinds — caller should pre-filter, but guard here too
    return s.name.length > 0;
  });

  if (eligible.length === 0) return 0;
  if (!vectorsAllowed()) return 0;

  clearVectorSearchCache();

  let count = 0;
  const BATCH = 500;

  const selectExisting = db.prepare(`
    SELECT vec_rowid FROM vec_symbol_map WHERE repo_id = ? AND symbol_id = ?
  `);
  const deleteVec = _vectorEnabled ? db.prepare(`DELETE FROM vec_symbols WHERE rowid = ?`) : null;
  const insertVec = _vectorEnabled
    ? db.prepare(`INSERT INTO vec_symbols (repo_id, embedding) VALUES (?, ?)`)
    : null;
  const upsertMap = _vectorEnabled ? db.prepare(`
    INSERT INTO vec_symbol_map (repo_id, symbol_id, vec_rowid)
    VALUES (?, ?, ?)
    ON CONFLICT(repo_id, symbol_id) DO UPDATE SET vec_rowid = excluded.vec_rowid
  `) : null;

  for (let offset = 0; offset < eligible.length; offset += BATCH) {
    const chunk = eligible.slice(offset, offset + BATCH);
    const tx = db.transaction(() => {
      for (const sym of chunk) {
        const text = normalizeSymbolText(sym.name, sym.signature);
        const vec = trigramVector(text);

        if (_vectorEnabled && deleteVec && insertVec && upsertMap) {
          // Delete old vec row if exists
          const existing = selectExisting.get(repoId, sym.symbolId) as { vec_rowid: number | null } | undefined;
          if (existing?.vec_rowid != null) {
            deleteVec.run(existing.vec_rowid);
          }
          // Insert new vec row into this repo's partition — vec0 auto-assigns rowid
          const info = insertVec.run(repoId, Buffer.from(vec.buffer));
          const vecRowid = Number(info.lastInsertRowid);
          upsertMap.run(repoId, sym.symbolId, vecRowid);
          count++;
        } else {
          inMemoryVectors.set(`${repoId}:${sym.symbolId}`, vec);
          const repoSet = inMemoryRepoIndex.get(repoId) ?? new Set<string>();
          repoSet.add(sym.symbolId);
          inMemoryRepoIndex.set(repoId, repoSet);
          count++;
        }
      }
    });
    tx();
  }

  return count;
}

// ── Search ─────────────────────────────────────────────────────────────────────

function l2Distance(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** Total order on (distance, symbolId) — distance alone is not one, which is the entire problem. */
function byDistanceThenId(
  a: { symbolId: string; distance: number },
  b: { symbolId: string; distance: number }
): number {
  if (a.distance !== b.distance) return a.distance - b.distance;
  return a.symbolId < b.symbolId ? -1 : a.symbolId > b.symbolId ? 1 : 0;
}

/**
 * KNN whose result does not depend on vec0 rowids.
 *
 * `ORDER BY distance, symbol_id` is NOT sufficient, which cost a round of tests to notice: vec0 picks
 * its k rows first, breaking ties by rowid internally, and only then does SQL sort them. The ORDER BY
 * can reorder the k rows chosen — it cannot change WHICH k were chosen. With identical trigram vectors
 * (same normalized name => distance exactly equal) the choice was arbitrary, and rowids are reassigned
 * on every rebuild, so two identical full re-index runs resolved different edges.
 *
 * The distances themselves are deterministic even when the tied winners are not. So: over-fetch, then
 * cut with a real total order. The fetch widens until the farthest row returned is STRICTLY farther
 * than the k-th — at that point every row tied at the cutoff distance is provably in hand, and the
 * slice is exact rather than merely likely.
 */
function knnDeterministic(
  db: Database.Database,
  repoId: string,
  queryVec: Float32Array,
  k: number
): { symbolId: string; distance: number }[] | null {
  // `v.repo_id = ?` constrains the PARTITION, so vec0 evaluates k within this repo. The old query put
  // the same predicate on the joined map table instead — reads almost identically, behaves completely
  // differently. See the comment on the table definition in `ensureVectorSchema`.
  const stmt = db.prepare(`
    SELECT m.symbol_id as symbolId, v.distance
    FROM vec_symbols v
    INNER JOIN vec_symbol_map m ON m.vec_rowid = v.rowid
    WHERE v.repo_id = ?
      AND v.embedding MATCH ?
      AND k = ?
    ORDER BY v.distance
  `);
  const buf = Buffer.from(queryVec.buffer);

  // Starts at 4x because tie groups are small in practice (a handful of same-named overloads), and each
  // widening is a full extra KNN. Capped so a pathological repo cannot turn one lookup into many.
  let fetch = Math.max(k * 4, 16);
  for (let round = 0; round < 3; round++) {
    const rows = stmt.all(repoId, buf, fetch) as { symbolId: string; distance: number }[];
    rows.sort(byDistanceThenId);

    // Fewer candidates than requested: nothing was truncated, so nothing could be arbitrary.
    if (rows.length <= k) return rows;

    // vec0 returned fewer rows than asked for => the partition is exhausted and this is the COMPLETE
    // candidate set. Widening cannot add anything, so the ordered slice is already exact. Without this
    // an all-tied group (four identically-named overloads) burned every widening round to reach the
    // same answer.
    if (rows.length < fetch) return rows.slice(0, k);

    // The farthest row is strictly beyond the cutoff => the whole tie group at the cutoff is included.
    if (rows[rows.length - 1].distance > rows[k - 1].distance) return rows.slice(0, k);

    fetch *= 4;
  }

  // Cap reached: every row fetched is tied at one distance, so no widening can separate them. Ordering
  // by symbolId still yields the same answer run to run, which is what callers depend on.
  const rows = stmt.all(repoId, buf, fetch) as { symbolId: string; distance: number }[];
  rows.sort(byDistanceThenId);
  return rows.slice(0, k);
}

export function vectorSearchSymbols(
  db: Database.Database,
  repoId: string,
  queryText: string,
  k: number
): { symbolId: string; distance: number }[] {
  if (!vectorsAllowed()) return [];

  const text = normalizeSymbolText(queryText);

  // Memoized because the resolver asks the same question thousands of times. Every unresolved token whose
  // name repeats — `Task`, `ILogger`, `CancellationToken` — reaches the same lookup, and the answer depends
  // only on (repo, text, k).
  //
  // Measured, and the reason this exists: draining wec.communication-hub's 11331 unresolved call edges took
  // 27860ms with vectors on against 226ms with them off — 123x — while resolving the SAME 11331 edges
  // either way. The fix for MCP-ISSUE-035 is what surfaced the cost: before it, 35% of queries returned
  // zero rows because `k` was consumed by other repos, and finding nothing is fast. Making the lane
  // correct made it do real work, and the work was almost entirely repeated.
  const cacheKey = `${repoId} ${String(k)} ${text}`;
  const cached = searchCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const result = searchUncached(db, repoId, text, k);
  searchCache.set(cacheKey, result);
  return result;
}

/**
 * Cleared whenever a repo's vectors change, so a stale answer cannot outlive the index it came from.
 * Process-lifetime otherwise: the watcher re-indexes in-process, and a cache that survived a rebuild
 * would keep resolving against symbols that no longer exist.
 */
const searchCache = new Map<string, { symbolId: string; distance: number }[]>();

function clearVectorSearchCache(): void {
  searchCache.clear();
}

function searchUncached(
  db: Database.Database,
  repoId: string,
  text: string,
  k: number
): { symbolId: string; distance: number }[] {
  const queryVec = trigramVector(text);

  if (_vectorEnabled) {
    try {
      const rows = knnDeterministic(db, repoId, queryVec, k);
      if (rows !== null) return rows;
    } catch {
      // Fall through to in-memory fallback if vec0 query fails
    }
  }

  // In-memory fallback: brute-force L2
  const repoSet = inMemoryRepoIndex.get(repoId);
  if (!repoSet || repoSet.size === 0) return [];

  const results: { symbolId: string; distance: number }[] = [];
  for (const symbolId of repoSet) {
    const vec = inMemoryVectors.get(`${repoId}:${symbolId}`);
    if (!vec) continue;
    results.push({ symbolId, distance: l2Distance(queryVec, vec) });
  }

  // Same tie-break as the vec0 path. `Array.prototype.sort` is stable, but the input order here is Set
  // insertion order — i.e. whatever order symbols were indexed in — so stability alone guarantees
  // nothing across runs. Sorting by symbolId does.
  results.sort((a, b) => a.distance - b.distance || (a.symbolId < b.symbolId ? -1 : a.symbolId > b.symbolId ? 1 : 0));
  return results.slice(0, k);
}

// ── Rebuild ────────────────────────────────────────────────────────────────────

export function rebuildVectorIndexForRepo(db: Database.Database, repoId: string): number {
  // Nothing will read these, so do not spend the trigram hashing on them.
  if (!vectorsAllowed()) return 0;

  // Fetch all eligible symbols for this repo
  const symbols = db.prepare(`
    SELECT symbol_id as symbolId, name, kind, signature
    FROM symbols
    WHERE repo_id = ?
      AND kind IN ('function', 'method', 'class', 'interface', 'struct')
  `).all(repoId) as { symbolId: string; name: string; kind: string; signature: string | null }[];

  if (symbols.length === 0) return 0;

  // Clear existing vectors for this repo before rebuild
  deleteVectorsByRepo(db, repoId);

  return batchUpsertSymbolVectors(
    db,
    repoId,
    symbols.map((s) => ({ symbolId: s.symbolId, name: s.name, signature: s.signature ?? undefined }))
  );
}

export function deleteVectorsByRepo(db: Database.Database, repoId: string): void {
  // Any change to this repo's vectors invalidates every memoized answer for it. Cleared wholesale rather
  // than per-repo because the key encodes the repo and a full clear cannot leave a stale entry behind.
  clearVectorSearchCache();
  if (_vectorEnabled) {
    try {
      // One statement, because repo_id is a partition key: 20108 rows for wec.be used to mean 20108
      // prepared `DELETE ... WHERE rowid = ?` runs.
      db.prepare(`DELETE FROM vec_symbols WHERE repo_id = ?`).run(repoId);
    } catch {
      // Older table without the partition key (or no table yet). Fall back to the per-rowid delete so
      // vectors are never left orphaned — silently skipping would strand them in every future KNN.
      try {
        const vecRowids = db.prepare(`
          SELECT vec_rowid FROM vec_symbol_map WHERE repo_id = ? AND vec_rowid IS NOT NULL
        `).all(repoId) as { vec_rowid: number }[];
        const deleteVec = db.prepare(`DELETE FROM vec_symbols WHERE rowid = ?`);
        const tx = db.transaction(() => {
          for (const r of vecRowids) {
            deleteVec.run(r.vec_rowid);
          }
        });
        tx();
      } catch {
        // Ignore if vec_symbols doesn't exist yet
      }
    }
  }
  // Always clear map table and in-memory
  db.prepare(`DELETE FROM vec_symbol_map WHERE repo_id = ?`).run(repoId);
  const repoSet = inMemoryRepoIndex.get(repoId);
  if (repoSet) {
    for (const symbolId of repoSet) {
      inMemoryVectors.delete(`${repoId}:${symbolId}`);
    }
    inMemoryRepoIndex.delete(repoId);
  }
}

// ── Stats ──────────────────────────────────────────────────────────────────────

export function getVectorStats(
  db: Database.Database,
  repoId: string
): { symbolsIndexed: number; lastRebuildAt: string | null } {
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM vec_symbol_map WHERE repo_id = ?
  `).get(repoId) as { cnt: number } | undefined;

  const symbolsIndexed = row?.cnt ?? 0;

  // Use latest index_run finished_at as proxy for last rebuild time
  const runRow = db.prepare(`
    SELECT finished_at as finishedAt
    FROM index_runs
    WHERE repo_id = ?
    ORDER BY finished_at DESC
    LIMIT 1
  `).get(repoId) as { finishedAt: string } | undefined;

  return {
    symbolsIndexed,
    lastRebuildAt: runRow?.finishedAt ?? null,
  };
}

export { VECTOR_SYMBOL_KINDS };
