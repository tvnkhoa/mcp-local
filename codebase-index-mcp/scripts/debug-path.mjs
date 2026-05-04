import Database from "better-sqlite3";
const db = new Database("mcp-local-index.db");

// Check what file_path actually looks like
const gs = db.prepare("select file_path from symbols where name='GraphStore'").get();
console.log("raw file_path:", gs);

// Check if replace works with backslash
const r1 = db.prepare("select replace(file_path, char(92), '/') as norm from symbols where name='GraphStore'").get();
console.log("normalized:", r1);

// Try query with replace using char(92) for backslash
const r2 = db.prepare("select count(*) as n from symbols where replace(file_path, char(92), '/') = ?").get("codebase-index-mcp/src/graphStore.ts");
console.log("count with replace char(92):", r2);

// Try char(92) in both sides
const r3 = db.prepare("select count(*) as n from symbols where replace(file_path, char(92), '/') = replace(?, char(92), '/')").get("codebase-index-mcp/src/graphStore.ts");
console.log("count replace both:", r3);
