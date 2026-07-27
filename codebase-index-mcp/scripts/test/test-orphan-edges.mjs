import { readFileSync } from "node:fs";
import { extractGraphData } from "../../dist/treeSitterExtractor.js";

const filePath = "D:/1.SourceCode/crm/wec.commnunication-hub/backend/CommunicationHub/tests/Application.UnitTests/Conversations/Commands/ConversationNotesCommandHandlerTests.cs";
const src = readFileSync(filePath, "utf8");

const result = extractGraphData({
  repoId: "wec.commnunication-hub",
  filePath: filePath.replace("D:/1.SourceCode/crm/wec.commnunication-hub/", ""),
  language: "csharp",
  source: src
});

// Build symbol map
const symbolIds = new Set(result.symbols.map(s => s.symbolId));

// Check which edges have from_id not in symbols
const orphaned = result.edges.filter(e => !symbolIds.has(e.fromId));
const nonOrphaned = result.edges.filter(e => symbolIds.has(e.fromId));

console.log(`Total edges: ${result.edges.length}`);
console.log(`Edges with valid from_id: ${nonOrphaned.length}`);
console.log(`Orphaned edges (from_id not in symbols): ${orphaned.length}`);

// Show breakdown by type
const orphanedByType = {};
for (const e of orphaned) {
  orphanedByType[e.type] = (orphanedByType[e.type] ?? 0) + 1;
}
console.log("Orphaned by type:", orphanedByType);

// Show sample orphaned edges
console.log("\nSample orphaned edges:");
for (const e of orphaned.slice(0, 5)) {
  console.log(`  [${e.type}] from=${e.fromId} to=${e.toId}`);
}

// Show all symbol IDs
console.log("\nSymbol IDs in file:");
for (const s of result.symbols) {
  console.log(`  ${s.kind} ${s.name} line=${s.line} id=${s.symbolId}`);
}
