import { GraphStore } from "../../dist/store/graphStore.js";
const store = new GraphStore("mcp-local-index.db");

// Test search_docs
console.log("=== search_docs(pipeline) ===");
const docs = store.searchDocs("mcp-local", "pipeline", 5);
console.log(`found: ${docs.length} docs`);
if (docs.length > 0) {
  const d = docs[0];
  console.log(`  [0] ${d.filePath} | ${d.headingPath} | mentions: ${d.resolvedMentions.length}`);
  console.log(`  text: ${d.text.slice(0, 120)}`);
}

// Test find_doc_coverage
console.log("\n=== find_doc_coverage(graphStore.ts) ===");
const cov = store.findDocCoverage("mcp-local", "codebase-index-mcp/src/graphStore.ts");
console.log(`total symbols: ${cov.length}, with docs: ${cov.filter(s => s.hasDocs).length}`);
if (cov.length > 0) {
  console.log("  sample (first 3):", JSON.stringify(cov.slice(0, 3), null, 2));
}

// Test find_stale_docs (need a real symbolId first)
console.log("\n=== find_stale_docs ===");
const syms = store.searchSymbols("GraphStore", "mcp-local", null, null, null, 1);
if (syms.length > 0) {
  const staleDocs = store.findStaleDocs("mcp-local", [syms[0].symbolId]);
  console.log(`symbolId: ${syms[0].symbolId}`);
  console.log(`stale docs found: ${staleDocs.length}`);
  if (staleDocs.length > 0) {
    console.log("  [0]:", JSON.stringify(staleDocs[0], null, 2));
  }
}

// Test search_symbols with filePath filter
console.log("\n=== search_symbols with filePath filter ===");
const filtered = store.searchSymbols("GraphStore", "mcp-local", null, null, "graphStore", 10);
console.log(`results: ${filtered.length}`);
filtered.forEach(s => console.log(`  ${s.name} (${s.kind}) @ ${s.filePath}:${s.line} | sig: ${s.signature?.slice(0, 60) ?? "null"}`));

// Test multi-token search
console.log("\n=== search_symbols multi-token 'index pipeline' ===");
const multi = store.searchSymbols("index pipeline", "mcp-local", null, null, null, 10);
console.log(`results: ${multi.length}`);
multi.forEach(s => console.log(`  ${s.name} (${s.kind}) @ ${s.filePath}:${s.line}`));

// Test intent strategy for natural-language-like prompt
console.log("\n=== search_symbols intent 'class handles assigned to ai conversation' ===");
const intent = store.searchSymbols("class handles assigned to ai conversation", "mcp-local", null, null, null, 10, "intent");
console.log(`results: ${intent.length}`);
intent.forEach(s => console.log(`  ${s.name} (${s.kind}) @ ${s.filePath}:${s.line}`));

// Test suggestions for empty/weak queries
console.log("\n=== search suggestions for weak query ===");
const suggestions = store.getSearchSuggestions("conversation ai assignment handler", "mcp-local", 5);
console.log(`suggestions: ${suggestions.length}`);
suggestions.forEach((name) => console.log(`  ${name}`));

store.close?.();
console.log("\n[DONE]");
