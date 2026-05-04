import Database from "better-sqlite3";

const db = new Database("./codebase-index.db");

console.log("\n=== Non-module symbols (classes, methods, etc.) ===");
const symbols = db.prepare(`
  SELECT file_path, name, kind
  FROM symbols 
  WHERE repo_id = 'smoke-test-repo' AND kind != 'module'
  LIMIT 30
`).all();

if (symbols.length === 0) {
  console.log("No symbols found! Only module symbols exist.");
} else {
  symbols.forEach(s => console.log(`${s.file_path} :: ${s.name} (${s.kind})`));
}

console.log(`\nTotal non-module symbols: ${symbols.length}`);

db.close();
