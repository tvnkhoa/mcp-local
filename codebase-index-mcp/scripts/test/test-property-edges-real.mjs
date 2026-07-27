import { readFileSync } from "node:fs";
import { extractGraphData } from "../dist/treeSitterExtractor.js";

const filePath = "D:/1.SourceCode/crm/wec.commnunication-hub/backend/CommunicationHub/tests/Application.UnitTests/Conversations/Commands/ConversationNotesCommandHandlerTests.cs";

let src;
try {
  src = readFileSync(filePath, "utf8");
} catch {
  console.error("File not found:", filePath);
  process.exit(1);
}

const result = extractGraphData({
  repoId: "wec.commnunication-hub",
  filePath: "tests/ConversationNotesCommandHandlerTests.cs",
  language: "csharp",
  source: src
});

const propEdges = result.edges.filter(e => e.type === "PROPERTY_REF" || e.type === "PROPERTY_WRITE");
console.log(`\nPROPERTY edges (${propEdges.length}):`);
for (const e of propEdges) {
  console.log(`  [${e.type}] toId=${e.toId} confidence=${e.confidence ?? "?"} reason=${e.reason ?? "?"}`);
}

const crmEdges = propEdges.filter(e => e.toId.includes("CrmCustomerId") || e.toId.includes("crm"));
console.log(`\nCrmCustomerId edges: ${crmEdges.length}`);

const withParent = result.symbols.filter(s => s.parentSymbolId);
console.log(`\nSymbols with parentSymbolId: ${withParent.length}`);

const jsonKeys = result.symbols.filter(s => s.signature?.startsWith("json_key:"));
console.log(`json_key symbols: ${jsonKeys.length}`);

console.log(`\nTotal symbols: ${result.symbols.length}, Total edges: ${result.edges.length}`);
