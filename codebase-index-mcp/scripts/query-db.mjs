import Database from "better-sqlite3";

const db = new Database("./codebase-index.db");

console.log("\n=== Files with 'src' in path ===");
const srcFiles = db.prepare(`
  SELECT path, language
  FROM files 
  WHERE repo_id = 'communication-hub' AND path LIKE '%src%'
  ORDER BY path
  LIMIT 20
`).all();

srcFiles.forEach(row => console.log(`${row.path} (${row.language})`));

console.log("\n=== All indexed files ===");
const allFiles = db.prepare(`
  SELECT path, language
  FROM files 
  WHERE repo_id = 'communication-hub'
  ORDER BY path
`).all();

allFiles.forEach(row => console.log(`${row.path} (${row.language})`));

console.log("\n=== Symbols from src files ===");
const symbols = db.prepare(`
  SELECT file_path, name, kind
  FROM symbols 
  WHERE repo_id = 'communication-hub' AND file_path LIKE '%src%'
  LIMIT 20
`).all();

symbols.forEach(s => console.log(`${s.file_path} :: ${s.name} (${s.kind})`));

console.log("\n=== Edges ===");
const edges = db.prepare(`
  SELECT from_id, to_id, type
  FROM edges 
  WHERE repo_id = 'communication-hub'
  LIMIT 10
`).all();

edges.forEach(e => console.log(`${e.from_id} -> ${e.to_id} [${e.type}]`));

db.close();
