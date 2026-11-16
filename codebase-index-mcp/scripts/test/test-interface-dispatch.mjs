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

import { GraphStore } from "../../dist/repositories/graphStore.js";
import { extractGraphData } from "../../dist/services/extractors/treeSitterExtractor.js";

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
  // Release L (MCP-ISSUE-094): the fan-out is a post-pass, rebuilt whole after IMPLEMENTS resolution.
  store.rebuildInterfaceDispatchEdges(repoId);

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

// ── 5. MCP-ISSUE-133: the implementer TYPE's method, from real C# extraction ──────────────────────

const issue133Interfaces = `
namespace App.Abstractions;

public interface IAuditSink
{
    void Save(string key, int value);
}

public interface IStore
{
    Task Save(string key, int value);
}
`;

// A helper type that sorts first and is not an implementer, a nested type with its own Save, and two
// implementers — one with an overload of the wrong arity declared first.
const issue133Stores = `
namespace App.Infrastructure;

public class AaHelper
{
    public void Save(string key, int value) { }
}

public class StoreA : IStore
{
    public class Inner
    {
        public void Save(string key, int value) { }
    }

    public Task Save(string key, int value) => Task.CompletedTask;
}

public class StoreB : IStore
{
    public Task Save(string key) => Task.CompletedTask;
    public Task Save(string key, int value) => Task.CompletedTask;
}
`;

const issue133Caller = `
namespace App.Handlers;

public class SaveHandler(IStore store)
{
    public async Task Handle() { await store.Save("k", 1); }
}
`;

function runIssue133() {
  const dbPath = createTempDbPath("ifd-133");
  const store = new GraphStore(dbPath);
  const repoId = "ifd-133";
  store.ensureRepository(repoId, path.dirname(dbPath));

  const ifaces = indexFile(store, repoId, "src/Abstractions/Contracts.cs", issue133Interfaces);
  const stores = indexFile(store, repoId, "src/Infrastructure/Stores.cs", issue133Stores);
  const caller = indexFile(store, repoId, "src/Handlers/SaveHandler.cs", issue133Caller);
  store.resolveImplementsEdges(repoId);
  const ctx = store.buildCallResolutionContext(repoId);
  while (store.resolveCallEdgesBatch(repoId, ctx, 5000) > 0) { /* drain */ }
  store.rebuildInterfaceDispatchEdges(repoId);

  const byId = new Map([...ifaces.symbols, ...stores.symbols].map((s) => [s.symbolId, s]));
  const owner = (s) => byId.get(s.parentSymbolId)?.name ?? "(none)";
  const label = (id) => {
    const s = byId.get(id);
    return s ? `${owner(s)}.${s.name}/${(s.signature ?? "").match(/\(([^)]*)\)/)?.[1].split(",").length ?? "?"}` : id;
  };
  const handle = caller.symbols.find((s) => s.kind === "method" && s.name === "Handle");
  const out = store.getCallEdges(repoId, handle.symbolId, "callees", 50).filter((e) => byId.has(e.toId));
  const direct = [...new Set(out.filter((e) => e.reason !== "interface-dispatch").map((e) => label(e.toId)))];
  const dispatch = out.filter((e) => e.reason === "interface-dispatch").map((e) => label(e.toId)).sort();

  assert.deepEqual(direct, ["IStore.Save/2"], `the call binds IStore's Save, not IAuditSink's from the same file (got ${JSON.stringify(direct)})`);
  assert.deepEqual(dispatch, ["StoreA.Save/2", "StoreB.Save/2"], `each implementer's own Save, the 2-parameter overload (got ${JSON.stringify(dispatch)})`);

  // The query-layer sibling expansion (stale-index safety net) agrees: IStore.Save's siblings are the same two.
  const ifaceSave = ifaces.symbols.find((s) => s.kind === "method" && owner(s) === "IStore");
  const siblings = store.expandInterfaceSiblings(repoId, [ifaceSave.symbolId]).filter((s) => s.via === "interface").map((s) => label(s.symbolId)).sort();
  assert.deepEqual(siblings, ["StoreA.Save/2", "StoreB.Save/2"], `interface siblings (got ${JSON.stringify(siblings)})`);

  store.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true });
  console.log("[ok] MCP-ISSUE-133: dispatch and siblings reach each implementer type's own Save overload");
}

// ── 6. MCP-ISSUE-133 (row #10): the method an implementer INHERITS from an in-repo base class ─────────

const inheritInterfaces = `
namespace App.Abstractions;

public interface IStore
{
    Task Save(string key);
}

public interface IRepo<T>
{
    Task Add(T item);
}
`;

// Plain base, generic base, and an abstract root overridden in the middle of the chain.
const inheritBases = `
namespace App.Infrastructure;

public class StoreBase
{
    public Task Save(string key) => Task.CompletedTask;
}

public class RepoBase<T>
{
    public Task Add(T item) => Task.CompletedTask;
}

public abstract class RootStore
{
    public abstract Task Save(string key);
}

public class MidStore : RootStore
{
    public override Task Save(string key) => Task.CompletedTask;
}
`;

const inheritImpls = `
namespace App.Infrastructure;

public class PlainStore : StoreBase, IStore { }

public class OrderRepo : RepoBase<Order>, IRepo<Order> { }

public class LeafStore : MidStore, IStore { }
`;

const inheritCaller = `
namespace App.Handlers;

public class InheritHandler(IStore store, IRepo<Order> repo)
{
    public async Task Handle() { await store.Save("k"); await repo.Add(new Order()); }
}
`;

function runInheritedBaseMethod() {
  const dbPath = createTempDbPath("ifd-inherit");
  const store = new GraphStore(dbPath);
  const repoId = "ifd-inherit";
  store.ensureRepository(repoId, path.dirname(dbPath));

  const ifaces = indexFile(store, repoId, "src/Abstractions/Contracts.cs", inheritInterfaces);
  const bases = indexFile(store, repoId, "src/Infrastructure/Bases.cs", inheritBases);
  const impls = indexFile(store, repoId, "src/Infrastructure/Impls.cs", inheritImpls);
  const caller = indexFile(store, repoId, "src/Handlers/InheritHandler.cs", inheritCaller);
  // The order indexRunner's post-phase uses: IMPLEMENTS, EXTENDS, calls, then the dispatch rebuild.
  store.resolveImplementsEdges(repoId);
  store.resolveExtendsEdges(repoId);
  const ctx = store.buildCallResolutionContext(repoId);
  while (store.resolveCallEdgesBatch(repoId, ctx, 5000) > 0) { /* drain */ }
  store.rebuildInterfaceDispatchEdges(repoId);

  const byId = new Map([...ifaces.symbols, ...bases.symbols, ...impls.symbols].map((s) => [s.symbolId, s]));
  const label = (id) => {
    const s = byId.get(id);
    return s ? `${byId.get(s.parentSymbolId)?.name ?? "(none)"}.${s.name}` : id;
  };
  const handle = caller.symbols.find((s) => s.kind === "method" && s.name === "Handle");
  const dispatch = store
    .getCallEdges(repoId, handle.symbolId, "callees", 50)
    .filter((e) => e.reason === "interface-dispatch")
    .map((e) => label(e.toId))
    .sort();
  // StoreBase.Save for PlainStore, MidStore.Save (not the abstract RootStore.Save) for LeafStore, RepoBase.Add
  // for OrderRepo through the generic base.
  assert.deepEqual(dispatch, ["MidStore.Save", "RepoBase.Add", "StoreBase.Save"], `inherited members (got ${JSON.stringify(dispatch)})`);

  // The query-layer sibling expansion agrees for IStore.Save.
  const ifaceSave = ifaces.symbols.find((s) => s.kind === "method" && s.name === "Save");
  const siblings = store.expandInterfaceSiblings(repoId, [ifaceSave.symbolId]).filter((s) => s.via === "interface").map((s) => label(s.symbolId)).sort();
  assert.deepEqual(siblings, ["MidStore.Save", "StoreBase.Save"], `interface siblings (got ${JSON.stringify(siblings)})`);

  store.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true });
  console.log("[ok] MCP-ISSUE-133 (row #10): dispatch and siblings reach a method inherited from an in-repo base");
}

// ── 7. Row #10: base-class fan-out after an inherited dispatch (the wec.social-ads shape) ──────────────

const repoInterfaces = `
namespace App.Abstractions;

public interface ICampaignRepository
{
    void Update(Campaign campaign);
}
`;

// PureRepository<T> declares a virtual Update. CampaignRepository implements ICampaignRepository and inherits it;
// AudienceRepository, another subclass of the base and no implementer, overrides it; ArchivedCampaignRepository,
// a subclass of the implementer, overrides it too.
const repoClasses = `
namespace App.Infrastructure;

public class PureRepository<T>
{
    public virtual void Update(T entity) { }
}

public class CampaignRepository : PureRepository<Campaign>, ICampaignRepository { }
`;
const audienceRepo = `
namespace App.Infrastructure;

public sealed class AudienceRepository : PureRepository<Audience>
{
    public override void Update(Audience audience) { }
}
`;
const archivedRepo = `
namespace App.Infrastructure;

public sealed class ArchivedCampaignRepository : CampaignRepository
{
    public override void Update(Campaign campaign) { }
}
`;
const repoCaller = `
namespace App.Handlers;

public class ApproveHandler(ICampaignRepository campaigns)
{
    public void Handle(Campaign c) { campaigns.Update(c); }
}
`;

function runBaseClassAfterInheritedDispatch() {
  const dbPath = createTempDbPath("ifd-bcd");
  const store = new GraphStore(dbPath);
  const repoId = "ifd-bcd";
  store.ensureRepository(repoId, path.dirname(dbPath));

  const files = [
    indexFile(store, repoId, "src/Abstractions/Repos.cs", repoInterfaces),
    indexFile(store, repoId, "src/Infrastructure/Repository.cs", repoClasses),
    indexFile(store, repoId, "src/Infrastructure/AudienceRepository.cs", audienceRepo),
    indexFile(store, repoId, "src/Infrastructure/ArchivedCampaignRepository.cs", archivedRepo)
  ];
  const caller = indexFile(store, repoId, "src/Handlers/ApproveHandler.cs", repoCaller);
  // indexRunner's post-phase order: IMPLEMENTS, EXTENDS, calls, interface dispatch, then base-class dispatch.
  store.resolveImplementsEdges(repoId);
  store.resolveExtendsEdges(repoId);
  const ctx = store.buildCallResolutionContext(repoId);
  while (store.resolveCallEdgesBatch(repoId, ctx, 5000) > 0) { /* drain */ }
  store.rebuildInterfaceDispatchEdges(repoId);
  store.resolveBaseClassDispatch(repoId);

  const byId = new Map(files.flatMap((f) => f.symbols).map((s) => [s.symbolId, s]));
  const label = (id) => {
    const s = byId.get(id);
    return s ? `${byId.get(s.parentSymbolId)?.name ?? "(none)"}.${s.name}` : id;
  };
  const handle = caller.symbols.find((s) => s.kind === "method" && s.name === "Handle");
  const out = store.getCallEdges(repoId, handle.symbolId, "callees", 50).filter((e) => byId.has(e.toId));
  const by = (reason) => out.filter((e) => e.reason === reason).map((e) => label(e.toId)).sort();
  assert.deepEqual(by("interface-dispatch"), ["PureRepository.Update"], `the inherited Update runs (got ${JSON.stringify(by("interface-dispatch"))})`);
  assert.deepEqual(
    by("base-class-dispatch"),
    ["ArchivedCampaignRepository.Update"],
    `only the implementer's own subclass override, never AudienceRepository's (got ${JSON.stringify(by("base-class-dispatch"))})`
  );

  store.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true });
  console.log("[ok] row #10: base-class fan-out after an inherited dispatch stays in the dispatching implementer's subtree");
}

try {
  runExtraction();
  runResolutionAndQuery();
  runStaleIndexSafetyNet();
  runIssue133();
  runInheritedBaseMethod();
  runBaseClassAfterInheritedDispatch();
  console.log("[ok] test-interface-dispatch passed");
} catch (err) {
  console.error("test-interface-dispatch: FAILED:", err.message);
  process.exit(1);
}
