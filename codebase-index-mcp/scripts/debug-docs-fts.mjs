import Database from "better-sqlite3";
import path from "node:path";

const dbPath = process.env.CODEBASE_INDEX_DB_PATH
  ?? process.env.DB_PATH
  ?? path.resolve(process.cwd(), "..", "mcp-local-index-central.db");
const repoId = process.env.REPO_ID ?? "mcp-local";

const db = new Database(dbPath);

const docCount = db.prepare("SELECT COUNT(*) as cnt FROM docs WHERE repo_id = ?").get(repoId);
const ftsCount = db.prepare("SELECT COUNT(*) as cnt FROM docs_fts").get();
console.log("dbPath:", dbPath);
console.log("repoId:", repoId);
console.log("docs count:", docCount.cnt, "| docs_fts count:", ftsCount.cnt);

const ftsMatch = db.prepare(`
  SELECT docs_fts.doc_id, docs_fts.repo_id FROM docs_fts
  INNER JOIN docs ON docs.doc_id = docs_fts.doc_id AND docs.repo_id = ?
  WHERE docs_fts MATCH 'incremental' LIMIT 5
`).all(repoId);
console.log("fts MATCH 'incremental':", JSON.stringify(ftsMatch));

const likeMatch = db.prepare(
  "SELECT doc_id FROM docs WHERE repo_id=? AND text LIKE '%incremental%' LIMIT 5"
).all(repoId);
console.log("LIKE '%incremental%':", JSON.stringify(likeMatch));

const sample = db.prepare(
  "SELECT file_path, length(text) as tlen, substr(text,1,80) as preview FROM docs WHERE repo_id=? ORDER BY length(text) DESC LIMIT 5"
).all(repoId);
console.log("top docs by length:", JSON.stringify(sample, null, 2));

db.close();
