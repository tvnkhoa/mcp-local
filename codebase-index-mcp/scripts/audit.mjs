import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.resolve(__dirname, "../mcp-local-index.db"));

// 1. Check if graphStore.ts is in files table
console.log("=== Files containing 'graphStore' ===");
const gsFiles = db.prepare("SELECT path, language FROM files WHERE path LIKE '%graphStore%'").all();
for (const f of gsFiles) console.log("  ", f.path, f.language, f.size_bytes, "bytes");

// 2. Check all TS source files and their symbol counts
console.log("\n=== TypeScript source files & symbol counts ===");
const tsSymbols = db.prepare(`
  SELECT f.path, count(s.symbol_id) as sym_count
  FROM files f
  LEFT JOIN symbols s ON s.repo_id = f.repo_id AND s.file_path = f.path
  WHERE f.path LIKE '%/src/%' AND f.language = 'typescript'
  GROUP BY f.path
  ORDER BY sym_count DESC
`).all();
for (const r of tsSymbols) console.log("  ", r.sym_count, "symbols |", r.path);

// 3. Stale files (in DB but debug files that were deleted)
console.log("\n=== Stale/extra files ===");
const allFiles = db.prepare("SELECT path FROM files ORDER BY path").all();
console.log("All", allFiles.length, "files:");
for (const f of allFiles) console.log("  ", f.path);

db.close();
