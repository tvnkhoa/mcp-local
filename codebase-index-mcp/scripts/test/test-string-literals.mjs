/**
 * ISSUE-023 — string-literal lane. Index string literals as a searchable lane
 * ({ value, file, line, enclosingSymbolId }) so "list every notification title /
 * error message this repo emits" is one MCP call instead of grep + full Reads.
 *
 * Asserts: extraction (C# regular/verbatim/interpolated with {…} holes; TS string +
 * template), min-length filter, per-file dedup, per-file cap, attribute-literal skip
 * (JSONKEY lane already covers those), import-specifier skip, enclosing-symbol
 * resolution, store round-trip + FTS search with LIKE fallback, and per-file pruning.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GraphStore } from "../../dist/graphStore.js";
import { extractGraphData } from "../../dist/treeSitterExtractor.js";

function createTempDbPath(tag) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `cbi-${tag}-`));
  return path.join(tempDir, "test.db");
}

const csharpSource = `
namespace App.Notifications;

public class NotificationTextProvider
{
    [JsonPropertyName("assigned_title")]
    public string AssignedTitle { get; set; }

    public string ConversationAssignedTitle() => "Conversation assigned";

    public string NewMessageBody(string customer) => $"New message from {customer} waiting";

    public string Duplicate1() => "Message delivery failed";
    public string Duplicate2() => "Message delivery failed";

    public string TooShort() => "ok";
}
`;

const tsSource = `
import { something } from "some-imported-module-name";

export function deliveryError(code: number) {
  const title = "Message delivery failed";
  return \`Delivery failed with code \${code}, retrying\`;
}
`;

function runExtraction() {
  const cs = extractGraphData({ repoId: "r", filePath: "src/NotificationTextProvider.cs", language: "csharp", source: csharpSource });
  const csValues = (cs.literals ?? []).map((l) => l.value);

  assert(csValues.includes("Conversation assigned"), `expected plain literal (got: ${JSON.stringify(csValues)})`);
  assert(
    csValues.includes("New message from {…} waiting"),
    `expected interpolated literal with {…} hole (got: ${JSON.stringify(csValues)})`
  );
  assert(
    csValues.filter((v) => v === "Message delivery failed").length === 1,
    `expected per-file dedup of repeated literal (got: ${JSON.stringify(csValues)})`
  );
  assert(!csValues.includes("ok"), "min-length filter must drop short literals");
  assert(!csValues.includes("assigned_title"), "attribute literals are the JSONKEY lane's job — must be skipped here");

  const interpolated = (cs.literals ?? []).find((l) => l.value.includes("{…}"));
  assert.equal(interpolated?.kind, "interpolated", "interpolated literal must carry kind=interpolated");
  assert(
    (cs.literals ?? []).every((l) => l.enclosingSymbolId),
    "every C# literal here is inside a method — enclosingSymbolId must resolve"
  );

  const ts = extractGraphData({ repoId: "r", filePath: "src/deliveryError.ts", language: "typescript", source: tsSource });
  const tsValues = (ts.literals ?? []).map((l) => l.value);
  assert(tsValues.includes("Message delivery failed"), `expected TS string literal (got: ${JSON.stringify(tsValues)})`);
  assert(
    tsValues.includes("Delivery failed with code {…}, retrying"),
    `expected template literal with {…} hole (got: ${JSON.stringify(tsValues)})`
  );
  assert(
    !tsValues.includes("some-imported-module-name"),
    "import specifiers must be skipped"
  );

  console.log("[ok] extraction: C# + TS literals, {…} holes, dedup, min-length, attribute/import skip, enclosing symbol");
}

function runCap() {
  const many = Array.from({ length: 250 }, (_, i) => `    public string M${i}() => "unique literal value number ${i}";`).join("\n");
  const source = `namespace A;\npublic class Big\n{\n${many}\n}\n`;
  const out = extractGraphData({ repoId: "r", filePath: "src/Big.cs", language: "csharp", source });
  assert(
    (out.literals ?? []).length === 200,
    `standard-profile cap must hold at 200/file (got: ${(out.literals ?? []).length})`
  );
  console.log("[ok] per-file cap (standard profile: 200)");
}

function runStoreAndSearch() {
  const dbPath = createTempDbPath("lit");
  const store = new GraphStore(dbPath);
  const repoId = "lit-test";
  store.ensureRepository(repoId, path.dirname(dbPath));

  const cs = extractGraphData({ repoId, filePath: "src/NotificationTextProvider.cs", language: "csharp", source: csharpSource });
  store.replaceSymbolsForFile(repoId, "src/NotificationTextProvider.cs", cs.symbols);
  store.replaceLiteralsForFile(repoId, "src/NotificationTextProvider.cs", cs.literals ?? []);
  store.rebuildLiteralsFts();

  // FTS search: multi-word query over literal content, enclosing symbol joined back.
  const hits = store.searchLiterals(repoId, "conversation assigned", 20, null);
  assert(hits.length >= 1, `expected FTS hit for 'conversation assigned' (got: ${JSON.stringify(hits)})`);
  const top = hits.find((h) => h.value === "Conversation assigned");
  assert(top, `expected exact literal among hits (got: ${JSON.stringify(hits.map((h) => h.value))})`);
  assert.equal(top.enclosingSymbol?.name, "ConversationAssignedTitle", `enclosing symbol must resolve (got: ${JSON.stringify(top.enclosingSymbol)})`);

  // filePath filter narrows results.
  const filtered = store.searchLiterals(repoId, "delivery", 20, "NotificationTextProvider");
  assert(filtered.length >= 1 && filtered.every((h) => h.filePath.includes("NotificationTextProvider")), "filePath filter must apply");

  // Pruning: pruneFiles removes the file's literals.
  store.pruneFiles(repoId, ["src/NotificationTextProvider.cs"]);
  const afterPrune = store.searchLiterals(repoId, "delivery", 20, null);
  assert.equal(afterPrune.length, 0, `pruned file must drop its literals (got: ${JSON.stringify(afterPrune)})`);

  store.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true });
  console.log("[ok] store round-trip: FTS search, enclosing-symbol join, filePath filter, prune");
}

try {
  runExtraction();
  runCap();
  runStoreAndSearch();
  console.log("[ok] test-string-literals passed");
} catch (err) {
  console.error("test-string-literals: FAILED:", err.message);
  process.exit(1);
}
