/**
 * ISSUE-022 — interface-aware caller resolution. Production callers invoke services through
 * DI-injected interfaces (`_publisher.PublishAsync(...)` where `_publisher: INotificationPublisher`),
 * so CALLS edges land on the interface method, never the implementation. The context pack for
 * the concrete class showed only test callers (which `new` it directly).
 *
 * Asserts the full chain:
 *  1. extraction — classic ctor-DI field AND C# 12 primary-ctor param both emit a qualified
 *     `callee:INotificationPublisher.Method` token (Bug A: field_declaration type lives on the
 *     nested variable_declaration; Bug B: primary-ctor parameter_list was invisible);
 *  2. resolution — interface-dispatch fan-out inserts CALLS edges to the implementation method
 *     (reason="interface-dispatch", confidence 0.7), including from a BARE-name token whose
 *     match lands on the interface's own method (Bug D);
 *  3. query — getChangeContext on the impl method/class and getContextByName on the class
 *     surface both production callers, tagged via:"interface" (Bug E: class context now
 *     aggregates member callers);
 *  4. stale-index safety net — with IMPLEMENTS left as `iface:` placeholders and NO dispatch
 *     edges, the query-layer sibling expansion still finds the production callers.
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

const interfaceSource = `
namespace App.Abstractions;

public interface INotificationPublisher
{
    Task PublishConversationNotificationAsync(string conversationId);
}
`;

const implementationSource = `
namespace App.Infrastructure;

public class NotificationPublisher : INotificationPublisher
{
    public Task PublishConversationNotificationAsync(string conversationId) => Task.CompletedTask;
}
`;

// Classic constructor DI: interface-typed readonly field + ctor assignment.
const classicDiCallerSource = `
namespace App.Handlers;

public class ConversationAssignedEventHandler
{
    private readonly INotificationPublisher _publisher;

    public ConversationAssignedEventHandler(INotificationPublisher publisher)
    {
        _publisher = publisher;
    }

    public async Task Handle(string conversationId)
    {
        await _publisher.PublishConversationNotificationAsync(conversationId);
    }
}
`;

// C# 12 primary constructor: parameter doubles as the DI field.
const primaryCtorCallerSource = `
namespace App.Handlers;

public class ConversationReopenedEventHandler(INotificationPublisher publisher)
{
    public async Task Handle(string conversationId)
    {
        await publisher.PublishConversationNotificationAsync(conversationId);
    }
}
`;

// Integration test constructs the concrete class directly — the only caller MCP used to see.
const integrationTestSource = `
namespace App.Tests;

public class NotificationPublisherIntegrationTests
{
    public Task Publishes()
    {
        var sut = new NotificationPublisher();
        return sut.PublishConversationNotificationAsync("c1");
    }
}
`;

const QUALIFIED_TOKEN = "callee:INotificationPublisher.PublishConversationNotificationAsync";

// ── 1. extraction ─────────────────────────────────────────────────────────────

function runExtraction() {
  const classic = extractGraphData({
    repoId: "r", filePath: "src/Handlers/ConversationAssignedEventHandler.cs",
    language: "csharp", source: classicDiCallerSource
  });
  const classicTokens = classic.edges.filter((e) => e.type === "CALLS").map((e) => e.toId);
  assert(
    classicTokens.includes(QUALIFIED_TOKEN),
    `classic ctor-DI field call must emit ${QUALIFIED_TOKEN} (got: ${JSON.stringify(classicTokens)})`
  );

  const primary = extractGraphData({
    repoId: "r", filePath: "src/Handlers/ConversationReopenedEventHandler.cs",
    language: "csharp", source: primaryCtorCallerSource
  });
  const primaryTokens = primary.edges.filter((e) => e.type === "CALLS").map((e) => e.toId);
  assert(
    primaryTokens.includes(QUALIFIED_TOKEN),
    `primary-ctor param call must emit ${QUALIFIED_TOKEN} (got: ${JSON.stringify(primaryTokens)})`
  );

  console.log("[ok] extraction: qualified interface token from classic-DI field + primary-ctor param");
}

// ── 2+3. resolution + query surfaces ──────────────────────────────────────────

function runResolutionAndQuery() {
  const dbPath = createTempDbPath("ifd");
  const store = new GraphStore(dbPath);
  const repoId = "ifd-test";
  store.ensureRepository(repoId, path.dirname(dbPath));

  indexFile(store, repoId, "src/Abstractions/INotificationPublisher.cs", interfaceSource);
  const impl = indexFile(store, repoId, "src/Infrastructure/NotificationPublisher.cs", implementationSource);
  const classic = indexFile(store, repoId, "src/Handlers/ConversationAssignedEventHandler.cs", classicDiCallerSource);
  const primary = indexFile(store, repoId, "src/Handlers/ConversationReopenedEventHandler.cs", primaryCtorCallerSource);
  indexFile(store, repoId, "tests/NotificationPublisherIntegrationTests.cs", integrationTestSource);

  store.rebuildFts(); // getContextByName resolves candidates through symbols_fts
  store.resolveImplementsEdges(repoId);
  const ctx = store.buildCallResolutionContext(repoId);
  while (store.resolveCallEdgesBatch(repoId, ctx, 5000) > 0) { /* drain */ }

  const implMethod = impl.symbols.find((s) => s.kind === "method" && s.name === "PublishConversationNotificationAsync");
  const implClass = impl.symbols.find((s) => s.kind === "class" && s.name === "NotificationPublisher");
  const classicHandle = classic.symbols.find((s) => s.kind === "method" && s.name === "Handle");
  const primaryHandle = primary.symbols.find((s) => s.kind === "method" && s.name === "Handle");
  assert(implMethod && implClass && classicHandle && primaryHandle, "fixture symbols missing");

  // 2 — interface-dispatch edges land on the IMPLEMENTATION method from both callers.
  const incoming = store.getCallEdges(repoId, implMethod.symbolId, "callers", 50);
  const dispatchRows = incoming.filter((e) => e.reason === "interface-dispatch");
  const dispatchFroms = dispatchRows.map((e) => e.fromId);
  assert(
    dispatchFroms.includes(classicHandle.symbolId) && dispatchFroms.includes(primaryHandle.symbolId),
    `interface-dispatch edges must reach the impl method from both handlers (got froms: ${JSON.stringify(incoming.map((e) => `${e.fromId}:${e.reason}`))})`
  );
  assert(
    dispatchRows.every((e) => e.confidence === 0.7),
    `interface-dispatch confidence must be 0.7 (got: ${JSON.stringify(dispatchRows.map((e) => e.confidence))})`
  );

  // 3a — getChangeContext on the impl METHOD lists both production callers.
  const methodChange = store.getChangeContext(repoId, implMethod.symbolId, 2, 1, 50);
  const methodCallerIds = methodChange.callers.map((c) => c.fromId);
  assert(
    methodCallerIds.includes(classicHandle.symbolId) && methodCallerIds.includes(primaryHandle.symbolId),
    `impl-method change context must include both handlers (got: ${JSON.stringify(methodChange.callers.map((c) => c.fromName))})`
  );

  // 3b — getChangeContext on the impl CLASS aggregates member callers (Bug E), tagged via.
  const classChange = store.getChangeContext(repoId, implClass.symbolId, 2, 1, 50);
  const classCallerNames = classChange.callers.map((c) => c.fromName);
  assert(
    classChange.callers.some((c) => c.fromId === classicHandle.symbolId) &&
      classChange.callers.some((c) => c.fromId === primaryHandle.symbolId),
    `class change context must aggregate member callers (got: ${JSON.stringify(classCallerNames)})`
  );
  assert(
    classChange.callers.filter((c) => c.fromId === classicHandle.symbolId || c.fromId === primaryHandle.symbolId).every((c) => c.via),
    `merged class-level callers must carry a via tag (got: ${JSON.stringify(classChange.callers.map((c) => ({ n: c.fromName, via: c.via ?? null })))})`
  );

  // 3c — getContextByName("NotificationPublisher") (the ISSUE-022 repro query) sees production callers.
  const pack = store.getContextByName(repoId, "NotificationPublisher", 50);
  const packCallers = pack.callers.map((c) => c.callerName);
  assert(
    packCallers.includes("Handle"),
    `getContextByName(NotificationPublisher) must surface production Handle callers, not just tests (got: ${JSON.stringify(packCallers)})`
  );

  store.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true });
  console.log("[ok] resolution + query: dispatch edges (conf 0.7), method/class change context, context pack by name");
}

// ── 4. stale-index safety net ─────────────────────────────────────────────────

function runStaleIndexSafetyNet() {
  const dbPath = createTempDbPath("ifd-stale");
  const store = new GraphStore(dbPath);
  const repoId = "ifd-stale-test";
  store.ensureRepository(repoId, path.dirname(dbPath));

  indexFile(store, repoId, "src/Abstractions/INotificationPublisher.cs", interfaceSource);
  const impl = indexFile(store, repoId, "src/Infrastructure/NotificationPublisher.cs", implementationSource);
  const classic = indexFile(store, repoId, "src/Handlers/ConversationAssignedEventHandler.cs", classicDiCallerSource);

  // Simulate a stale/partial index: NO resolveImplementsEdges (IMPLEMENTS stays `iface:` token),
  // NO call-edge resolution batch for dispatch fan-out. Resolve ONLY the qualified token to the
  // interface method by hand so a CALLS edge exists on the interface side (as old indexes have).
  const iface = extractGraphData({ repoId, filePath: "src/Abstractions/INotificationPublisher.cs", language: "csharp", source: interfaceSource });
  const ifaceMethod = iface.symbols.find((s) => s.kind === "method" && s.name === "PublishConversationNotificationAsync");
  const classicHandle = classic.symbols.find((s) => s.kind === "method" && s.name === "Handle");
  const implMethod = impl.symbols.find((s) => s.kind === "method" && s.name === "PublishConversationNotificationAsync");
  assert(ifaceMethod && classicHandle && implMethod, "stale fixture symbols missing");

  // Emulate what a pre-fix index that DID resolve the interface side would hold: a single
  // CALLS edge from the handler to the INTERFACE method, no dispatch edges.
  store.replaceEdgesForFile(repoId, "src/Handlers/ConversationAssignedEventHandler.cs", [
    { repoId, fromId: classicHandle.symbolId, toId: ifaceMethod.symbolId, type: "CALLS", confidence: 0.8, reason: "resolved interface method" }
  ]);

  // Safety net: change context on the IMPL method must still find the handler through the
  // interface sibling expansion (no dispatch edge exists in this DB).
  const change = store.getChangeContext(repoId, implMethod.symbolId, 2, 1, 50);
  const callerIds = change.callers.map((c) => c.fromId);
  assert(
    callerIds.includes(classicHandle.symbolId),
    `stale-index safety net: impl-method context must reach the handler via interface sibling expansion (got: ${JSON.stringify(change.callers.map((c) => c.fromName))})`
  );
  const merged = change.callers.find((c) => c.fromId === classicHandle.symbolId);
  assert.equal(merged?.via, "interface", `merged caller must be tagged via:"interface" (got: ${merged?.via})`);
  assert(
    (merged?.confidence ?? 1) <= 0.7,
    `merged caller confidence must be capped at 0.7 (got: ${merged?.confidence})`
  );

  store.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true });
  console.log("[ok] stale-index safety net: sibling expansion finds interface-routed callers without dispatch edges");
}

try {
  runExtraction();
  runResolutionAndQuery();
  runStaleIndexSafetyNet();
  console.log("[ok] test-interface-dispatch passed");
} catch (err) {
  console.error("test-interface-dispatch: FAILED:", err.message);
  process.exit(1);
}
