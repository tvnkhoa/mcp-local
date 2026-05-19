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
  const raw = process.env["CODEBASE_INDEX_CROSS_REPO_NAMESPACES"];
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

let _vectorEnabled = false;

export function isVectorEnabled(): boolean {
  return _vectorEnabled;
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
export function normalizeSymbolText(name: string, signature?: string): string {
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
export function trigramVector(text: string, dims = VECTOR_DIMS): Float32Array {
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
    process.stderr.write("[vector] sqlite-vec loaded OK\n");
    return true;
  } catch (e) {
    process.stderr.write(`[vector] sqlite-vec unavailable, using in-memory fallback: ${e}\n`);
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
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_symbols USING vec0(
          embedding float[${VECTOR_DIMS}]
        )
      `);
    } catch (e) {
      process.stderr.write(`[vector] vec0 table creation failed, disabling: ${e}\n`);
      _vectorEnabled = false;
    }
  }
}

// ── Upsert helpers ─────────────────────────────────────────────────────────────

export function upsertSymbolVector(
  db: Database.Database,
  repoId: string,
  symbolId: string,
  name: string,
  signature?: string
): void {
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

    // Insert into vec0 without explicit rowid — vec0 auto-assigns
    const info = db.prepare(`INSERT INTO vec_symbols (embedding) VALUES (?)`).run(Buffer.from(vec.buffer));
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

  let count = 0;
  const BATCH = 500;

  const selectExisting = db.prepare(`
    SELECT vec_rowid FROM vec_symbol_map WHERE repo_id = ? AND symbol_id = ?
  `);
  const deleteVec = _vectorEnabled ? db.prepare(`DELETE FROM vec_symbols WHERE rowid = ?`) : null;
  const insertVec = _vectorEnabled ? db.prepare(`INSERT INTO vec_symbols (embedding) VALUES (?)`) : null;
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
          // Insert new vec row — vec0 auto-assigns rowid
          const info = insertVec.run(Buffer.from(vec.buffer));
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

export function vectorSearchSymbols(
  db: Database.Database,
  repoId: string,
  queryText: string,
  k: number
): { symbolId: string; distance: number }[] {
  const text = normalizeSymbolText(queryText);
  const queryVec = trigramVector(text);

  if (_vectorEnabled) {
    try {
      // vec0 KNN query syntax — join via vec_rowid
      const rows = db.prepare(`
        SELECT m.symbol_id as symbolId, v.distance
        FROM vec_symbols v
        INNER JOIN vec_symbol_map m ON m.vec_rowid = v.rowid
        WHERE m.repo_id = ?
          AND v.embedding MATCH ?
          AND k = ?
        ORDER BY v.distance
      `).all(repoId, Buffer.from(queryVec.buffer), k) as { symbolId: string; distance: number }[];
      return rows;
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

  results.sort((a, b) => a.distance - b.distance);
  return results.slice(0, k);
}

// ── Rebuild ────────────────────────────────────────────────────────────────────

export function rebuildVectorIndexForRepo(db: Database.Database, repoId: string): number {
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
  if (_vectorEnabled) {
    try {
      // Delete from vec_symbols via vec_rowid join
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
