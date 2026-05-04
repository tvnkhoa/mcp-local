import Database from "better-sqlite3";

const db = new Database("mcp-local-index.db");

console.log("docs count:", db.prepare("select count(*) as n from docs").get());
const docSample = db.prepare("select repo_id, file_path, heading_path, text from docs limit 3").all();
console.log("docs sample:", JSON.stringify(docSample, null, 2));

console.log("\ndocs_fts count:", db.prepare("select count(*) as n from docs_fts").get());
console.log("doc_mentions count:", db.prepare("select count(*) as n from doc_mentions").get());
console.log("repo_ids in docs:", db.prepare("select distinct repo_id from docs").all());

// Try FTS directly
const ftsResult = db.prepare("select * from docs_fts where docs_fts match 'pipeline' limit 3").all();
console.log("\ndocs_fts match pipeline:", JSON.stringify(ftsResult, null, 2));

// Check symbols for graphStore.ts
const gsSym = db.prepare("select symbol_id, name, kind, file_path from symbols where file_path like '%graphStore%' limit 5").all();
console.log("\nsymbols in graphStore.ts:", JSON.stringify(gsSym, null, 2));
// Check doc_mentions for those
if (gsSym.length > 0) {
  const ids = gsSym.map(s => `'${s.symbol_id}'`).join(",");
  const mentions = db.prepare(`select * from doc_mentions where symbol_id in (${ids})`).all();
  console.log("mentions for graphStore symbols:", JSON.stringify(mentions, null, 2));
}
