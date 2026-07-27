import { extractGraphData } from "../dist/treeSitterExtractor.js";

const src = `
using System;
namespace Test {
  public class Conversation {
    public int CrmCustomerId { get; set; }
    public string AssignedAgentUsername { get; set; }
  }
  public class Handler {
    public void Handle(Conversation conv) {
      var id = conv.CrmCustomerId;
      conv.CrmCustomerId = 99;
      conv.AssignedAgentUsername = "agent1";
    }
  }
  public class TestFixture {
    public void Setup() {
      var c = new Conversation { CrmCustomerId = 1001, AssignedAgentUsername = "test" };
    }
  }
}
`;

const result = extractGraphData({
  repoId: "test",
  filePath: "Test.cs",
  language: "csharp",
  source: src
});

const propEdges = result.edges.filter(e => e.type === "PROPERTY_REF" || e.type === "PROPERTY_WRITE");
console.log(`\nPROPERTY edges (${propEdges.length}):`);
for (const e of propEdges) {
  console.log(`  [${e.type}] ${e.toId} (confidence=${e.confidence ?? "?"}, reason=${e.reason ?? "?"})`);
}

const withParent = result.symbols.filter(s => s.parentSymbolId);
console.log(`\nSymbols with parentSymbolId (${withParent.length}):`);
for (const s of withParent) {
  console.log(`  ${s.kind} ${s.name} -> parentSymbolId=${s.parentSymbolId}`);
}

const jsonKeys = result.symbols.filter(s => s.signature?.startsWith("json_key:"));
console.log(`\njson_key symbols (${jsonKeys.length}):`);
for (const s of jsonKeys) {
  console.log(`  ${s.name} signature=${s.signature}`);
}

console.log(`\nTotal symbols: ${result.symbols.length}, Total edges: ${result.edges.length}`);
