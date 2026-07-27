/**
 * ISSUE-020 — message-bus PUBLISHES/CONSUMES edges must link a `Publish<T>`/`Send<T>` (or
 * `Publish(new T(...))`) callsite to the `IConsumer<T>`/handler of the same contract, so
 * trace_execution_flow / get_call_chain can cross the producer→consumer boundary that has no
 * static CALLS edge.
 *
 * ISSUE-018 — find_field_accesses must list read vs write callsites of a property from the
 * existing PROPERTY_REF/PROPERTY_WRITE edges.
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

function indexFile(store, repoId, filePath, source) {
  const extracted = extractGraphData({ repoId, filePath, language: "csharp", source });
  store.replaceSymbolsForFile(repoId, filePath, extracted.symbols);
  store.replaceEdgesForFile(repoId, filePath, extracted.edges);
  return extracted;
}

// ── ISSUE-020: bus edge extraction + resolution ───────────────────────────────

const contractSource = `
namespace App.Messages;

public record OrderPlaced(int OrderId);
`;

const publisherSource = `
namespace App.Producers;

public interface IPublishEndpoint { Task Publish<T>(T message); }

public class OrderService
{
    private readonly IPublishEndpoint _bus;
    public OrderService(IPublishEndpoint bus) { _bus = bus; }

    public async Task PlaceOrder(int id)
    {
        await _bus.Publish(new OrderPlaced(id));
    }
}
`;

const consumerSource = `
namespace App.Consumers;

public interface IConsumer<T> {}
public record OrderPlaced(int OrderId);

public class OrderPlacedConsumer : IConsumer<OrderPlaced>
{
    public Task Consume() => Task.CompletedTask;
}
`;

function runBusExtraction() {
  // Producer: Publish(new OrderPlaced(id)) → PUBLISHES contract:OrderPlaced (inferred from arg).
  const pub = extractGraphData({ repoId: "r", filePath: "src/OrderService.cs", language: "csharp", source: publisherSource });
  const pubEdges = pub.edges.filter((e) => e.type === "PUBLISHES").map((e) => e.toId);
  assert(
    pubEdges.includes("contract:OrderPlaced"),
    `expected PUBLISHES contract:OrderPlaced (got: ${JSON.stringify(pubEdges)})`
  );

  // Consumer: IConsumer<OrderPlaced> → CONSUMES contract:OrderPlaced.
  const con = extractGraphData({ repoId: "r", filePath: "src/OrderPlacedConsumer.cs", language: "csharp", source: consumerSource });
  const conEdges = con.edges.filter((e) => e.type === "CONSUMES").map((e) => e.toId);
  assert(
    conEdges.includes("contract:OrderPlaced"),
    `expected CONSUMES contract:OrderPlaced (got: ${JSON.stringify(conEdges)})`
  );

  // Explicit generic form Publish<T>() should also be captured.
  const explicitGeneric = extractGraphData({
    repoId: "r",
    filePath: "src/X.cs",
    language: "csharp",
    source: `namespace A; public class X { public async Task M(IBus b) { await b.Publish<OrderPlaced>(); } }`
  });
  assert(
    explicitGeneric.edges.some((e) => e.type === "PUBLISHES" && e.toId === "contract:OrderPlaced"),
    "expected explicit Publish<OrderPlaced>() to emit PUBLISHES contract:OrderPlaced"
  );

  console.log("[ok] bus edge extraction (producer + consumer + explicit generic)");
}

function runBusResolution() {
  const dbPath = createTempDbPath("bus");
  const store = new GraphStore(dbPath);
  const repoId = "bus-test";
  store.ensureRepository(repoId, path.dirname(dbPath));

  indexFile(store, repoId, "src/Messages.cs", contractSource);
  const publisher = indexFile(store, repoId, "src/OrderService.cs", publisherSource);
  const consumer = indexFile(store, repoId, "src/OrderPlacedConsumer.cs", consumerSource);

  store.resolveImplementsEdges(repoId);
  const resolved = store.resolvePublishesConsumesEdges(repoId);
  assert(resolved >= 1, `expected >=1 resolved PUBLISHES edge, got ${resolved}`);

  const consumerSymbol = consumer.symbols.find((s) => s.name === "OrderPlacedConsumer");
  assert(consumerSymbol, "expected OrderPlacedConsumer symbol");
  const placeOrder = publisher.symbols.find((s) => s.name === "PlaceOrder");
  assert(placeOrder, "expected PlaceOrder method symbol");

  // From the publisher method, a callee-direction edge should now reach the consumer symbol
  // via the resolved PUBLISHES edge (no leftover contract: token).
  const callees = store.getCallEdges(repoId, placeOrder.symbolId, "callees", 50);
  const targets = callees.map((e) => e.toId);
  assert(
    targets.includes(consumerSymbol.symbolId),
    `expected a PUBLISHES edge from PlaceOrder to consumer ${consumerSymbol.symbolId} (got: ${JSON.stringify(targets)})`
  );
  assert(
    !targets.some((t) => typeof t === "string" && t.startsWith("contract:")),
    `expected no leftover contract: PUBLISHES tokens from the publisher (got: ${JSON.stringify(targets)})`
  );

  // Consistency: get_change_context must cross the bus too (callees from publisher reach the
  // consumer; callers of the consumer include the publisher) — same surface as get_call_chain.
  const pubChange = store.getChangeContext(repoId, placeOrder.symbolId, 2, 1, 50);
  assert(
    pubChange.callees.some((c) => c.toId === consumerSymbol.symbolId),
    `get_change_context callees should cross the bus to the consumer (got: ${JSON.stringify(pubChange.callees.map((c) => c.toId))})`
  );
  const conChange = store.getChangeContext(repoId, consumerSymbol.symbolId, 2, 1, 50);
  assert(
    conChange.callers.some((c) => c.fromId === placeOrder.symbolId),
    `get_change_context callers of the consumer should include the publisher (got: ${JSON.stringify(conChange.callers.map((c) => c.fromId))})`
  );

  // ISSUE-018/#1: find_impact_files on the consumer file must surface the publisher's file
  // (resolved PUBLISHES edge matched by the type-agnostic to_id arm of the join clause).
  const impact = store.getImpactFiles(repoId, consumer.symbols[0].filePath, 50);
  assert(
    impact.impactedFiles.some((f) => f.filePath.includes("OrderService")),
    `find_impact_files(consumerFile) should list the publisher file (got: ${JSON.stringify(impact.impactedFiles.map((f) => f.filePath))})`
  );

  // #4: a bus-only consumer must NOT be reported as dead code (incoming PUBLISHES counts as live).
  const dead = store.getDeadCodeCandidates(repoId, null, null, null, true, 200);
  assert(
    !dead.candidates.some((d) => d.symbolId === consumerSymbol.symbolId),
    "bus consumer must not be flagged dead (incoming PUBLISHES edge proves it live)"
  );

  store.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true });
  console.log("[ok] bus edge resolution + cross-bus get_change_context/find_impact_files + dead-code liveness");
}

// ── ISSUE-018: find_field_accesses read/write partition ───────────────────────

const fieldSource = `
namespace App.Domain;

public class Conversation
{
    public string AssignedAgent { get; set; }
}

public class Reader
{
    public string Read(Conversation c) => c.AssignedAgent;
}

public class Writer
{
    public void Write(Conversation c) { c.AssignedAgent = "bob"; }
}
`;

function runFieldAccesses() {
  const dbPath = createTempDbPath("field");
  const store = new GraphStore(dbPath);
  const repoId = "field-test";
  store.ensureRepository(repoId, path.dirname(dbPath));

  const extracted = indexFile(store, repoId, "src/Conversation.cs", fieldSource);
  store.resolvePropertyEdges(repoId);

  const prop = extracted.symbols.find((s) => s.kind === "property" && s.name === "AssignedAgent");
  assert(prop, "expected AssignedAgent property symbol");

  const reads = store.getFieldAccesses(repoId, prop.symbolId, "read", 100);
  const writes = store.getFieldAccesses(repoId, prop.symbolId, "write", 100);
  const all = store.getFieldAccesses(repoId, prop.symbolId, "all", 100);

  const readEnclosing = reads.accesses.map((a) => a.enclosingName);
  const writeEnclosing = writes.accesses.map((a) => a.enclosingName);

  assert(
    reads.accesses.length >= 1 && reads.accesses.every((a) => a.mode === "read"),
    `expected only read accesses (got: ${JSON.stringify(reads.accesses)})`
  );
  assert(
    readEnclosing.includes("Read"),
    `expected the read site enclosed by Read() (got: ${JSON.stringify(readEnclosing)})`
  );
  assert(
    writes.accesses.length >= 1 && writes.accesses.every((a) => a.mode === "write"),
    `expected only write accesses (got: ${JSON.stringify(writes.accesses)})`
  );
  assert(
    writeEnclosing.includes("Write"),
    `expected the write site enclosed by Write() (got: ${JSON.stringify(writeEnclosing)})`
  );
  assert(
    all.accesses.length === reads.accesses.length + writes.accesses.length,
    `expected mode=all to union read+write (all=${all.accesses.length}, read=${reads.accesses.length}, write=${writes.accesses.length})`
  );

  store.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true });
  console.log("[ok] find_field_accesses read/write partition", { reads: reads.accesses.length, writes: writes.accesses.length });
}

try {
  runBusExtraction();
  runBusResolution();
  runFieldAccesses();
  console.log("[ok] test-bus-edges passed");
} catch (err) {
  console.error("test-bus-edges: FAILED:", err.message);
  process.exit(1);
}
