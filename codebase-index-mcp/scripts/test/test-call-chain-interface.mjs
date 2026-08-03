/**
 * MCP-ISSUE-022, query layer — `get_call_chain(direction:"callers")` must see through DI.
 *
 * Why this harness exists. ISSUE-022 has two independent defences:
 *   (a) resolution-time `interface-dispatch` CALLS edges — covered by test-interface-dispatch.mjs;
 *   (b) query-time interface-sibling frontier seeding — covered ONLY here.
 *
 * (b) regressed silently. It lived in `services/graph/graphTraversal.ts`; S-41 (a1d992c) re-homed
 * the loose `src/` files, inlined the traversal into `tools/handlers/impactHandler.ts` WITHOUT the
 * seeding, and left the fixed module orphaned and unimported. `verify:all` stayed green for four
 * commits because no harness drove `get_call_chain` across an interface — test-interface-dispatch
 * asserts (a) and reaches the query layer only through `getChangeContext`.
 *
 * The fixture deliberately reproduces a graph where ONLY (b) can succeed: the CALLS edge lands on
 * the INTERFACE method and no dispatch edges exist, which is the shape a stale or partially
 * resolved index has. If the seeding is dropped again, scenario 1 returns zero callers.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GraphStore } from "../../dist/repositories/graphStore.js";
import { extractGraphData } from "../../dist/services/extractors/treeSitterExtractor.js";
import { handleGetCallChain } from "../../dist/tools/handlers/impactHandler.js";

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

/** Minimal HandlerContext — handleGetCallChain touches only `store` and `asText`. */
function makeCtx(store) {
  return {
    store,
    asText: (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] })
  };
}

function callChain(store, repoId, symbolId, direction, { depth = 3, limit = 50 } = {}) {
  const res = handleGetCallChain(
    { repoId, symbolId, direction, depth, limit, profile: "compact" },
    makeCtx(store)
  );
  return JSON.parse(res.content[0].text);
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

const callerSource = `
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

function buildInterfaceRoutedGraph(tag) {
  const dbPath = createTempDbPath(tag);
  const store = new GraphStore(dbPath);
  const repoId = `${tag}-repo`;
  store.ensureRepository(repoId, path.dirname(dbPath));

  const iface = indexFile(store, repoId, "src/Abstractions/INotificationPublisher.cs", interfaceSource);
  const impl = indexFile(store, repoId, "src/Infrastructure/NotificationPublisher.cs", implementationSource);
  const caller = indexFile(store, repoId, "src/Handlers/ConversationAssignedEventHandler.cs", callerSource);

  const ifaceMethod = iface.symbols.find((s) => s.kind === "method" && s.name === "PublishConversationNotificationAsync");
  const implMethod = impl.symbols.find((s) => s.kind === "method" && s.name === "PublishConversationNotificationAsync");
  const handle = caller.symbols.find((s) => s.kind === "method" && s.name === "Handle");
  assert(ifaceMethod && implMethod && handle, "fixture symbols missing");

  // The whole point: the ONLY CALLS edge lands on the interface method. No dispatch fan-out,
  // so nothing links the handler to the implementation except sibling expansion at query time.
  store.replaceEdgesForFile(repoId, "src/Handlers/ConversationAssignedEventHandler.cs", [
    { repoId, fromId: handle.symbolId, toId: ifaceMethod.symbolId, type: "CALLS", confidence: 0.8, reason: "resolved interface method" }
  ]);
  store.resolveImplementsEdges(repoId);

  return { store, repoId, dbPath, ifaceMethod, implMethod, handle };
}

// ── 1. the regression guard ───────────────────────────────────────────────────

function runCallersSeeThroughInterface() {
  const { store, repoId, dbPath, implMethod, handle } = buildInterfaceRoutedGraph("cc-iface");

  const result = callChain(store, repoId, implMethod.symbolId, "callers");
  const fromIds = result.edges.map((e) => e.fromId);

  assert(
    fromIds.includes(handle.symbolId),
    "get_call_chain(callers) on the impl method must reach the DI caller through interface-sibling " +
      `seeding (got ${result.edges.length} edge(s): ${JSON.stringify(result.edges.map((e) => e.fromName ?? e.fromId))}). ` +
      "If this is empty, the seeding was dropped from traverseCallGraph again — see the file header."
  );

  store.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true });
  console.log("[ok] callers direction sees through DI: impl method -> interface sibling -> production caller");
}

// ── 2. negative control — seeding must not leak into the callees direction ────

function runCalleesUnaffected() {
  const { store, repoId, dbPath, implMethod, handle } = buildInterfaceRoutedGraph("cc-iface-neg");

  // Callees of the handler: the interface method it actually calls, and nothing invented.
  const outgoing = callChain(store, repoId, handle.symbolId, "callees");
  assert(
    outgoing.edges.length > 0,
    `callees direction must still traverse normally (got: ${JSON.stringify(outgoing.edges)})`
  );

  // Callees of the impl method: it calls nothing, and sibling seeding must not fabricate an edge.
  const implCallees = callChain(store, repoId, implMethod.symbolId, "callees");
  assert.equal(
    implCallees.edges.length,
    0,
    `sibling seeding must not apply to the callees direction (got: ${JSON.stringify(implCallees.edges)})`
  );

  store.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true });
  console.log("[ok] callees direction unaffected: no fabricated edges from sibling seeding");
}

try {
  runCallersSeeThroughInterface();
  runCalleesUnaffected();
  console.log("[ok] test-call-chain-interface passed");
} catch (err) {
  console.error("test-call-chain-interface: FAILED:", err.message);
  process.exit(1);
}
