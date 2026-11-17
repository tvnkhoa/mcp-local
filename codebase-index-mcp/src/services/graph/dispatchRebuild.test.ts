import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { initGraphSchema, runGraphMigrations } from "../../repositories/schema.js";
import {
  IFACE_VIA_MARK,
  buildCallResolutionContext,
  rebuildInterfaceDispatchEdges,
  resolveCallEdgesBatch,
  unifyInterfaceVia,
  type ResolvedUpdate
} from "./edgeResolverCalls.js";
import { resolveBaseClassDispatch } from "./edgeResolverContracts.js";

/**
 * Release L (MCP-ISSUE-094): both dispatch fan-outs are rebuilt whole every run, from the resolved CALLS,
 * IMPLEMENTS and EXTENDS edges — so the result is the same whatever rows the run touched. Re-running never
 * duplicates; a caller's direct CALLS edge to the implementation wins over a dispatch edge; an implementor
 * added later is reached without re-resolving the caller.
 */

function db(): Database.Database {
  const conn = new Database(":memory:");
  initGraphSchema(conn);
  runGraphMigrations(conn, false);
  return conn;
}
const sym = (conn: Database.Database, id: string, name: string, kind: string, filePath: string, parent: string | null = null, signature: string | null = null): void => {
  conn.prepare(`insert into symbols (repo_id, symbol_id, file_path, name, kind, line, parent_symbol_id, signature) values ('r', ?, ?, ?, ?, 1, ?, ?)`).run(id, filePath, name, kind, parent, signature);
};
const edge = (conn: Database.Database, from: string, to: string, type: string, reason: string, confidence = 0.8): void => {
  conn.prepare(`insert into edges (repo_id, from_id, to_id, type, confidence, reason) values ('r', ?, ?, ?, ?, ?)`).run(from, to, type, confidence, reason);
};
const calls = (conn: Database.Database, reason: string) =>
  (conn.prepare(`select from_id as f, to_id as t from edges where repo_id = 'r' and type = 'CALLS' and reason = ? order by f, t`).all(reason) as { f: string; t: string }[]).map((r) => `${r.f}>${r.t}`);

test("release L: interface dispatch is rebuilt whole — idempotent, direct edges win, a new implementor is reached", () => {
  const conn = db();
  sym(conn, "I", "IStore", "interface", "IStore.cs");
  sym(conn, "I.Save", "Save", "method", "IStore.cs", "I");
  sym(conn, "A", "StoreA", "class", "StoreA.cs");
  sym(conn, "A.Save", "Save", "method", "StoreA.cs", "A");
  sym(conn, "B", "StoreB", "class", "StoreB.cs");
  sym(conn, "B.Save", "Save", "method", "StoreB.cs", "B");
  sym(conn, "caller1", "Handle", "method", "H1.cs");
  sym(conn, "caller2", "Handle", "method", "H2.cs");
  edge(conn, "A", "I", "IMPLEMENTS", "resolved interface");
  edge(conn, "B", "I", "IMPLEMENTS", "resolved interface");
  edge(conn, "caller1", "I.Save", "CALLS", "resolved interface method");
  edge(conn, "caller2", "I.Save", "CALLS", "resolved interface method (unproven receiver)", 0.7);
  edge(conn, "caller2", "B.Save", "CALLS", "resolved callee by receiver type", 0.85); // a direct edge to an implementation

  assert.equal(rebuildInterfaceDispatchEdges(conn, "r"), 3);
  assert.deepEqual(calls(conn, "interface-dispatch"), ["caller1>A.Save", "caller1>B.Save", "caller2>A.Save"], "caller2 keeps its direct edge to B.Save");
  assert.equal(rebuildInterfaceDispatchEdges(conn, "r"), 3, "a re-run rebuilds the same set");
  assert.equal(calls(conn, "interface-dispatch").length, 3, "and never duplicates it");

  // A third implementor appears; neither caller is touched — the rebuild still reaches it.
  sym(conn, "C", "StoreC", "class", "StoreC.cs");
  sym(conn, "C.Save", "Save", "method", "StoreC.cs", "C");
  edge(conn, "C", "I", "IMPLEMENTS", "resolved interface");
  rebuildInterfaceDispatchEdges(conn, "r");
  assert.deepEqual(calls(conn, "interface-dispatch"), ["caller1>A.Save", "caller1>B.Save", "caller1>C.Save", "caller2>A.Save", "caller2>C.Save"]);

  // An implementor whose IMPLEMENTS edge is still a token is not an implementor (yet).
  conn.prepare(`update edges set to_id = 'iface:IStore' where from_id = 'C' and type = 'IMPLEMENTS'`).run();
  rebuildInterfaceDispatchEdges(conn, "r");
  assert.ok(!calls(conn, "interface-dispatch").some((e) => e.endsWith(">C.Save")), "the stale C.Save edges are gone");
});

test("MCP-ISSUE-133: interface dispatch binds the implementer TYPE's method, not the first same-named method in its file", () => {
  const conn = db();
  sym(conn, "I", "IStore", "interface", "IStore.cs");
  sym(conn, "I.Save", "Save", "method", "IStore.cs", "I", "Task Save(string key, int value);");
  // One file: a helper type that sorts first and is NOT an implementer, two implementers, and a nested type.
  sym(conn, "H", "Helper", "class", "Stores.cs");
  sym(conn, "0.H.Save", "Save", "method", "Stores.cs", "H", "public void Save(string key, int value)");
  sym(conn, "A", "StoreA", "class", "Stores.cs");
  sym(conn, "A.Inner", "Inner", "class", "Stores.cs", "A");
  sym(conn, "1.A.Inner.Save", "Save", "method", "Stores.cs", "A.Inner", "public void Save(string key, int value)");
  sym(conn, "2.A.Save", "Save", "method", "Stores.cs", "A", "public Task Save(string key, int value)");
  sym(conn, "B", "StoreB", "class", "Stores.cs");
  sym(conn, "3.B.Save1", "Save", "method", "Stores.cs", "B", "public Task Save(string key)");
  sym(conn, "4.B.Save2", "Save", "method", "Stores.cs", "B", "public Task Save(string key, int value)");
  sym(conn, "caller", "Handle", "method", "H.cs");
  edge(conn, "A", "I", "IMPLEMENTS", "resolved interface");
  edge(conn, "B", "I", "IMPLEMENTS", "resolved interface");
  edge(conn, "caller", "I.Save", "CALLS", "resolved interface method");

  rebuildInterfaceDispatchEdges(conn, "r");
  assert.deepEqual(
    calls(conn, "interface-dispatch"),
    ["caller>2.A.Save", "caller>4.B.Save2"],
    "each implementer reaches its own Save, the overload with the interface's arity; Helper and the nested type are never reached"
  );
});

test("MCP-ISSUE-133: a method row with no parent link still binds by file (an index written before parent_symbol_id)", () => {
  const conn = db();
  sym(conn, "I", "IStore", "interface", "IStore.cs");
  sym(conn, "I.Save", "Save", "method", "IStore.cs", "I");
  sym(conn, "A", "StoreA", "class", "StoreA.cs");
  sym(conn, "A.Save", "Save", "method", "StoreA.cs", null);
  sym(conn, "caller", "Handle", "method", "H.cs");
  edge(conn, "A", "I", "IMPLEMENTS", "resolved interface");
  edge(conn, "caller", "I.Save", "CALLS", "resolved interface method");
  rebuildInterfaceDispatchEdges(conn, "r");
  assert.deepEqual(calls(conn, "interface-dispatch"), ["caller>A.Save"]);
});

test("MCP-ISSUE-133: an implementer with no Save of its own is not given another type's Save from its file", () => {
  const conn = db();
  sym(conn, "I", "IStore", "interface", "IStore.cs");
  sym(conn, "I.Save", "Save", "method", "IStore.cs", "I");
  sym(conn, "A", "StoreA", "class", "Stores.cs");
  sym(conn, "O", "Other", "class", "Stores.cs");
  sym(conn, "O.Save", "Save", "method", "Stores.cs", "O");
  sym(conn, "caller", "Handle", "method", "H.cs");
  edge(conn, "A", "I", "IMPLEMENTS", "resolved interface");
  edge(conn, "caller", "I.Save", "CALLS", "resolved interface method");
  rebuildInterfaceDispatchEdges(conn, "r");
  assert.deepEqual(calls(conn, "interface-dispatch"), []);
});

test("release L: base-class dispatch is rebuilt whole — a re-run never duplicates, a direct edge wins", () => {
  const conn = db();
  sym(conn, "Base", "ValueObject", "class", "ValueObject.cs");
  sym(conn, "Base.M", "GetEqualityComponents", "method", "ValueObject.cs", "Base", "protected abstract IEnumerable<object> GetEqualityComponents();");
  sym(conn, "Sub", "Money", "class", "Money.cs");
  sym(conn, "Sub.M", "GetEqualityComponents", "method", "Money.cs", "Sub", "protected override IEnumerable<object> GetEqualityComponents()");
  sym(conn, "Sub2", "Email", "class", "Email.cs");
  sym(conn, "Sub2.M", "GetEqualityComponents", "method", "Email.cs", "Sub2", "protected override IEnumerable<object> GetEqualityComponents()");
  sym(conn, "caller", "Equals", "method", "ValueObject.cs", "Base");
  edge(conn, "Sub", "Base", "EXTENDS", "base_list class", 0.9);
  edge(conn, "Sub2", "Base", "EXTENDS", "base_list class", 0.9);
  edge(conn, "caller", "Base.M", "CALLS", "resolved callee same-file", 0.9);
  edge(conn, "caller", "Sub2.M", "CALLS", "resolved callee by receiver type", 0.85);

  resolveBaseClassDispatch(conn, "r");
  resolveBaseClassDispatch(conn, "r");
  assert.deepEqual(calls(conn, "base-class-dispatch"), ["caller>Sub.M"], "one edge after two runs; Sub2.M keeps its direct edge");
});

test("MCP-ISSUE-133 (row #10): an implementer that inherits the interface method from a base class reaches the base's declaration", () => {
  const conn = db();
  sym(conn, "I", "IStore", "interface", "IStore.cs");
  sym(conn, "I.Save", "Save", "method", "IStore.cs", "I", "Task Save(string key);");
  // Inherited: Impl : StoreBase, IStore — only StoreBase declares Save.
  sym(conn, "Base", "StoreBase", "class", "StoreBase.cs");
  sym(conn, "Base.Save", "Save", "method", "StoreBase.cs", "Base", "public Task Save(string key)");
  sym(conn, "Impl", "Impl", "class", "Impl.cs");
  // Abstract root + override in the middle: Leaf : Mid : Root — the most-derived declaration (Mid's) wins.
  sym(conn, "Root", "Root", "class", "Root.cs");
  sym(conn, "Root.Save", "Save", "method", "Root.cs", "Root", "public abstract Task Save(string key);");
  sym(conn, "Mid", "Mid", "class", "Mid.cs");
  sym(conn, "Mid.Save", "Save", "method", "Mid.cs", "Mid", "public override Task Save(string key)");
  sym(conn, "Leaf", "Leaf", "class", "Leaf.cs");
  // A base whose same-named method has another type's owner in its file is not bound by file.
  sym(conn, "Lone", "Lone", "class", "Lone.cs");
  sym(conn, "LoneBase", "LoneBase", "class", "LoneBase.cs");
  sym(conn, "Other", "Other", "class", "LoneBase.cs");
  sym(conn, "Other.Save", "Save", "method", "LoneBase.cs", "Other", "public Task Save(string key)");
  // An implementer with its own Save keeps it even when its base declares one too.
  sym(conn, "Own", "Own", "class", "Own.cs");
  sym(conn, "Own.Save", "Save", "method", "Own.cs", "Own", "public new Task Save(string key)");
  sym(conn, "caller", "Handle", "method", "H.cs");
  for (const c of ["Impl", "Leaf", "Lone", "Own"]) edge(conn, c, "I", "IMPLEMENTS", "resolved interface");
  edge(conn, "Impl", "Base", "EXTENDS", "base_list class", 0.95);
  edge(conn, "Leaf", "Mid", "EXTENDS", "base_list class", 0.95);
  edge(conn, "Mid", "Root", "EXTENDS", "base_list class", 0.95);
  edge(conn, "Lone", "LoneBase", "EXTENDS", "base_list class", 0.95);
  edge(conn, "Own", "Base", "EXTENDS", "base_list class", 0.95);
  // A cycle (bad data) must not loop.
  edge(conn, "LoneBase", "Lone", "EXTENDS", "base_list class", 0.95);
  // A framework base is still a token: the walk stops there.
  edge(conn, "Impl", "base:ControllerBase", "EXTENDS", "external boundary", 0.1);
  edge(conn, "caller", "I.Save", "CALLS", "resolved interface method");

  rebuildInterfaceDispatchEdges(conn, "r");
  assert.deepEqual(calls(conn, "interface-dispatch"), ["caller>Base.Save", "caller>Mid.Save", "caller>Own.Save"]);
});

test("MCP-ISSUE-133 (row #10): base-class fan-out from an inherited dispatch reaches only the dispatching implementer's subclasses; an unproven bind does not walk", () => {
  const conn = db();
  sym(conn, "I", "IStore", "interface", "IStore.cs");
  sym(conn, "I.Save", "Save", "method", "IStore.cs", "I", "void Save(int x);");
  sym(conn, "Base", "PureStore", "class", "PureStore.cs");
  sym(conn, "Base.Save", "Save", "method", "PureStore.cs", "Base", "public virtual void Save(int x)");
  // The implementer the interface call runs on: inherits Save. Its subclass overrides it.
  sym(conn, "Impl", "CampaignStore", "class", "CampaignStore.cs");
  sym(conn, "Sub", "AuditedCampaignStore", "class", "AuditedCampaignStore.cs");
  sym(conn, "Sub.Save", "Save", "method", "AuditedCampaignStore.cs", "Sub", "public override void Save(int x)");
  // Another subclass of the base, NOT an implementer of IStore: a call through IStore never runs its override.
  sym(conn, "Other", "AudienceStore", "class", "AudienceStore.cs");
  sym(conn, "Other.Save", "Save", "method", "AudienceStore.cs", "Other", "public override void Save(int x)");
  sym(conn, "viaIface", "Handle", "method", "H1.cs");
  sym(conn, "viaGuess", "Handle", "method", "H2.cs");
  sym(conn, "direct", "Run", "method", "H3.cs");
  edge(conn, "Impl", "I", "IMPLEMENTS", "resolved interface");
  edge(conn, "Impl", "Base", "EXTENDS", "base_list class", 0.95);
  edge(conn, "Sub", "Impl", "EXTENDS", "base_list class", 0.95);
  edge(conn, "Other", "Base", "EXTENDS", "base_list class", 0.95);
  edge(conn, "viaIface", "I.Save", "CALLS", "resolved interface method");
  edge(conn, "viaGuess", "I.Save", "CALLS", "resolved interface method (unproven receiver)", 0.7);
  edge(conn, "direct", "Base.Save", "CALLS", "resolved callee by receiver type", 0.85);

  rebuildInterfaceDispatchEdges(conn, "r");
  resolveBaseClassDispatch(conn, "r");
  assert.deepEqual(calls(conn, "interface-dispatch"), ["viaIface>Base.Save"], "the unproven bind reaches no inherited member");
  assert.deepEqual(
    calls(conn, "base-class-dispatch"),
    ["direct>Other.Save", "viaIface>Sub.Save"],
    "the interface caller reaches the implementer's subclass override, never AudienceStore's; a direct caller of the base keeps the base's fan-out"
  );
});

test("MCP-ISSUE-133 (row 5): unifyInterfaceVia — one marker per (caller, target); a plain proven bind clears it", () => {
  const proven = "resolved interface method";
  const unproven = "resolved interface method (unproven receiver)";
  const u = (fromId: string, oldToId: string, newToId: string, reason: string, via?: string): ResolvedUpdate => ({
    fromId, oldToId, newToId, confidence: 0.8, reason, via
  });
  // The bare half that guessed the same method joins its qualified half; two receivers merge, sorted.
  const a = [
    u("h", "callee:ITenant.Add", "IPure.Add", proven, `${IFACE_VIA_MARK}t`),
    u("h", "callee:IMedia.Add", "IPure.Add", proven, `${IFACE_VIA_MARK}m`),
    u("h", "callee:Add", "IPure.Add", unproven)
  ];
  unifyInterfaceVia(a);
  assert.deepEqual(a.map((x) => x.via), [`${IFACE_VIA_MARK}m,t`, `${IFACE_VIA_MARK}m,t`, `${IFACE_VIA_MARK}m,t`]);
  // A proven call through the declaring interface itself takes the whole implementer set: no marker.
  const b = [u("h", "callee:ITenant.Add", "IPure.Add", proven, `${IFACE_VIA_MARK}t`), u("h", "callee:IPure.Add", "IPure.Add", proven)];
  unifyInterfaceVia(b);
  assert.deepEqual(b.map((x) => x.via), [null, null]);
  // Other callers, other targets and other reasons are left alone.
  const c = [u("g", "callee:ITenant.Add", "IPure.Add", proven, `${IFACE_VIA_MARK}t`), u("h", "callee:Add", "IPure.Add", unproven), u("g", "callee:X", "Y", "resolved callee by name")];
  unifyInterfaceVia(c);
  assert.deepEqual(c.map((x) => x.via), [`${IFACE_VIA_MARK}t`, undefined, undefined]);
});

test("MCP-ISSUE-133 (row 5 review): an interface bind keeps a Python hint in assigned_expression and clears only a stale marker", () => {
  const conn = db();
  // A Python Protocol-typed call: its row carries the extractor's hint, which the untyped-receiver lane reads.
  sym(conn, "P", "Store", "interface", "store.py");
  sym(conn, "P.save", "save", "method", "store.py", "P");
  sym(conn, "py", "run", "function", "app.py");
  // A C# call through the declaring interface, on a row holding a marker from an earlier resolution.
  sym(conn, "I", "ITenant", "interface", "ITenant.cs", null, "public interface ITenant");
  sym(conn, "I.Add", "Add", "method", "ITenant.cs", "I");
  sym(conn, "cs", "Handle", "method", "H.cs");
  const raw = conn.prepare(`insert into edges (repo_id, from_id, to_id, type, confidence, reason, assigned_expression) values ('r', ?, ?, 'CALLS', 0.75, 'qualified call', ?)`);
  raw.run("py", "callee:Store.save", "pyargs:x");
  raw.run("cs", "callee:ITenant.Add", `${IFACE_VIA_MARK}OLD`);

  const ctx = buildCallResolutionContext(conn, "r");
  while (ctx.offset < ctx.unresolvedRows.length) resolveCallEdgesBatch(conn, "r", ctx, 500);
  const row = (from: string) =>
    conn.prepare(`select to_id as t, reason, assigned_expression as a from edges where repo_id = 'r' and from_id = ? and type = 'CALLS'`).get(from) as { t: string; reason: string; a: string | null };
  assert.deepEqual(row("py"), { t: "P.save", reason: "resolved interface method", a: "pyargs:x" }, "the Python hint survives the bind");
  assert.deepEqual(row("cs"), { t: "I.Add", reason: "resolved interface method", a: null }, "a call through the declaring interface clears a stale marker");
});

test("MCP-ISSUE-133 (row 5 review): a TS qualified token on a derived interface binds the base interface's method", () => {
  // The TS extractor emits no receiver-qualified token today (`s.read()` on `s: Store` gives `callee:read`), so this
  // drives the resolver directly: the walk is language-agnostic for every non-Python file, TS included.
  const conn = db();
  sym(conn, "R", "Reader", "interface", "src/a/reader.ts", null, "interface Reader { read(): string; }");
  sym(conn, "R.read", "read", "method", "src/a/reader.ts", "R");
  sym(conn, "A", "Audit", "interface", "src/b/store.ts", null, "interface Audit { read(): string; }");
  sym(conn, "A.read", "read", "method", "src/b/store.ts", "A");
  sym(conn, "S", "Store", "interface", "src/b/store.ts", null, "interface Store extends Reader { save(): void; }");
  sym(conn, "f", "f", "function", "src/c/svc.ts");
  conn.prepare(`insert into edges (repo_id, from_id, to_id, type, confidence, reason) values ('r', 'f', 'callee:Store.read', 'CALLS', 0.75, 'qualified call')`).run();

  const ctx = buildCallResolutionContext(conn, "r");
  while (ctx.offset < ctx.unresolvedRows.length) resolveCallEdgesBatch(conn, "r", ctx, 500);
  const row = conn.prepare(`select to_id as t, reason, assigned_expression as a from edges where repo_id = 'r' and from_id = 'f'`).get() as { t: string; reason: string; a: string };
  assert.deepEqual(row, { t: "R.read", reason: "resolved interface method", a: `${IFACE_VIA_MARK}S` }, "Reader.read, never Audit.read from Store's file");
});
