/**
 * ISSUE-024 — ranked search quality in CQRS/MediatR repos where every method is `Handle`:
 * 1. qualifiedName ("EnclosingType.Member") must be emitted for class members (parent_symbol_id join);
 * 2. the enclosing-type name must participate in intent-token matching (domain tokens hit the
 *    class name, not just the member name);
 * 3. test-path rows get a rank penalty so a production handler beats an equal-coverage test stub;
 * 4. excludeTests=true drops test-path rows entirely;
 * 5. parameter-type tokens already match via the signature haystack (regression guard).
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GraphStore } from "../../dist/store/graphStore.js";
import { extractGraphData } from "../../dist/extractors/treeSitterExtractor.js";

function createTempDbPath(tag) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `cbi-${tag}-`));
  return path.join(tempDir, "test.db");
}

function indexFile(store, repoId, filePath, source) {
  const extracted = extractGraphData({ repoId, filePath, language: "csharp", source });
  store.replaceSymbolsForFile(repoId, filePath, extracted.symbols);
  store.replaceEdgesForFile(repoId, filePath, extracted.edges);
  return extracted;
}

const productionSource = `
namespace App.Handlers;

public record ConversationAssignedEvent(string ConversationId);

public class ConversationAssignedEventHandler
{
    public Task Handle(ConversationAssignedEvent evt) => Task.CompletedTask;
}
`;

// Equal token coverage to the production handler on purpose — only the test-path
// penalty separates them, which is exactly what this test pins down.
const testStubSource = `
namespace App.Tests;

public class ConversationAssignedEventHandlerTests
{
    public Task Handle(ConversationAssignedEvent evt) => Task.CompletedTask;
}
`;

function run() {
  const dbPath = createTempDbPath("rank");
  const store = new GraphStore(dbPath);
  const repoId = "rank-test";
  store.ensureRepository(repoId, path.dirname(dbPath));

  indexFile(store, repoId, "src/Handlers/ConversationAssignedEventHandler.cs", productionSource);
  indexFile(store, repoId, "tests/Handlers/ConversationAssignedEventHandlerTests.cs", testStubSource);

  // 1+2+3 — intent query with domain tokens: both Handle methods have full coverage
  // (class name carries the domain tokens), production must outrank the test stub.
  const ranked = store.getSymbolCandidates(repoId, "conversation assigned handle", 10, "intent");
  const handles = ranked.filter((c) => c.name === "Handle");
  assert(handles.length >= 2, `expected both Handle methods in ranked results (got: ${JSON.stringify(ranked.map((c) => `${c.filePath}:${c.name}`))})`);

  const prodHandle = handles.find((c) => c.filePath.startsWith("src/"));
  const testHandle = handles.find((c) => c.filePath.startsWith("tests/"));
  assert(prodHandle && testHandle, "expected one production and one test Handle");
  assert(
    handles.indexOf(prodHandle) < handles.indexOf(testHandle),
    `production Handle must outrank the equal-coverage test stub (prod conf=${prodHandle.confidence}, test conf=${testHandle.confidence})`
  );
  assert(
    prodHandle.confidence > testHandle.confidence,
    `test-path penalty must lower the stub's confidence (prod=${prodHandle.confidence}, test=${testHandle.confidence})`
  );

  // qualifiedName disambiguates the 20-identical-Handles symptom.
  assert.equal(
    prodHandle.qualifiedName,
    "ConversationAssignedEventHandler.Handle",
    `expected qualifiedName from parent join (got: ${prodHandle.qualifiedName})`
  );

  // Enclosing-type token matching: a pure domain query (no member-name token) must still
  // surface the production handler's members/class via the parent-name haystack.
  const domainOnly = store.getSymbolCandidates(repoId, "conversation assigned", 10, "intent");
  assert(
    domainOnly.some((c) => c.name === "Handle" && c.filePath.startsWith("src/")),
    `domain-only intent query should reach Handle via its enclosing type name (got: ${JSON.stringify(domainOnly.map((c) => c.qualifiedName ?? c.name))})`
  );

  // 4 — excludeTests drops the tests/ row on both strategies.
  const noTests = store.getSymbolCandidates(repoId, "conversation assigned handle", 10, "intent", { excludeTests: true });
  assert(
    noTests.length > 0 && noTests.every((c) => !c.filePath.startsWith("tests/")),
    `excludeTests must drop test-path rows (got: ${JSON.stringify(noTests.map((c) => c.filePath))})`
  );
  const noTestsByName = store.getSymbolCandidates(repoId, "Handle", 10, "name", { excludeTests: true });
  assert(
    noTestsByName.length > 0 && noTestsByName.every((c) => !c.filePath.startsWith("tests/")),
    `excludeTests must apply on the name strategy too (got: ${JSON.stringify(noTestsByName.map((c) => c.filePath))})`
  );

  // 5 — parameter-type matching via signature (registry item 3): the param type token alone
  // must reach the Handle method through its stored signature.
  const byParamType = store.getSymbolCandidates(repoId, "ConversationAssignedEvent", 10, "intent", { excludeTests: true });
  assert(
    byParamType.some((c) => c.name === "Handle"),
    `param-type intent query should match Handle via signature (got: ${JSON.stringify(byParamType.map((c) => `${c.name}:${c.signature}`))})`
  );

  store.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true });
  console.log("[ok] ranked search: qualifiedName, parent-token matching, test penalty, excludeTests, signature param-type match");
}

try {
  run();
  console.log("[ok] test-search-ranking passed");
} catch (err) {
  console.error("test-search-ranking: FAILED:", err.message);
  process.exit(1);
}
