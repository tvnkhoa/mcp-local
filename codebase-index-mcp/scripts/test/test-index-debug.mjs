import { readFileSync } from "node:fs";
import { extractGraphData } from "../../dist/treeSitterExtractor.js";

const files = [
  "D:/1.SourceCode/crm/wec.commnunication-hub/backend/CommunicationHub/tests/Application.UnitTests/Conversations/Commands/ConversationNotesCommandHandlerTests.cs",
  "D:/1.SourceCode/crm/wec.commnunication-hub/backend/CommunicationHub/src/Application/Conversations/Commands/StartConversation/StartConversation.cs"
];

for (const filePath of files) {
  const src = readFileSync(filePath, "utf8");
  const result = extractGraphData({
    repoId: "wec.commnunication-hub",
    filePath: filePath.replace("D:/1.SourceCode/crm/wec.commnunication-hub/", ""),
    language: "csharp",
    source: src
  });

  const byType = {};
  for (const e of result.edges) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
  }

  console.log(`\n=== ${filePath.split("/").pop()} ===`);
  console.log(`Symbols: ${result.symbols.length}, Edges: ${result.edges.length}`);
  console.log("Edge types:", byType);

  const propEdges = result.edges.filter(e => e.type === "PROPERTY_REF" || e.type === "PROPERTY_WRITE");
  const crmEdges = propEdges.filter(e => e.toId.includes("CrmCustomerId"));
  console.log(`Property edges: ${propEdges.length}, CrmCustomerId: ${crmEdges.length}`);

  const withParent = result.symbols.filter(s => s.parentSymbolId);
  console.log(`Symbols with parentSymbolId: ${withParent.length}`);
}
