/**
 * TypeScript edge coverage: inheritance, type references, and property access.
 *
 * Before this, the JS/TS lane emitted 2 of the 10 edge types — `IMPORTS` and `CALLS`. Everything
 * asserted here was previously produced by the C# extractor alone, which is why
 * `find_implementations` returned empty for any TypeScript repo and a type referenced only through
 * annotations had no incoming reference at all.
 */

import assert from "node:assert";

import { extractGraphData } from "../../dist/services/extractors/treeSitterExtractor.js";

function extract(source, filePath = "src/sample.ts") {
  return extractGraphData({ repoId: "repo-test", filePath, language: "typescript", source });
}

function requireSymbol(result, name, kind) {
  const found = result.symbols.find((s) => s.name === name && s.kind === kind);
  assert(found, `Expected a ${kind} symbol named ${name}; saw ${JSON.stringify(result.symbols.map((s) => `${s.kind}:${s.name}`))}`);
  return found;
}

/** Accept either the resolved symbolId or the placeholder token — single-file extraction cannot
 *  resolve across files, and `resolveIntraFileEdges` resolves what it can. */
function hasEdge(result, type, fromId, resolvedId, token) {
  return result.edges.some(
    (e) => e.type === type && e.fromId === fromId && (e.toId === resolvedId || e.toId === token)
  );
}

// ── Suite 1: EXTENDS / IMPLEMENTS ────────────────────────────────────────────────────────────
function runHeritage() {
  const source = `
export interface Repository {
  load(id: string): Promise<string>;
}

export interface AuditedRepository extends Repository {
  audit(): void;
}

export abstract class BaseService {}

export class UserService extends BaseService implements Repository, AuditedRepository {
  load(id: string): Promise<string> {
    return Promise.resolve(id);
  }
  audit(): void {}
}

export class Mixed extends withLogging(BaseService) {}
`;

  const result = extract(source);
  const userService = requireSymbol(result, "UserService", "class");
  const repository = requireSymbol(result, "Repository", "interface");
  const audited = requireSymbol(result, "AuditedRepository", "interface");
  const base = requireSymbol(result, "BaseService", "class");

  assert(
    hasEdge(result, "IMPLEMENTS", userService.symbolId, repository.symbolId, "iface:Repository"),
    "class implements interface"
  );
  assert(
    hasEdge(result, "IMPLEMENTS", userService.symbolId, audited.symbolId, "iface:AuditedRepository"),
    "a second implements entry is not dropped"
  );
  assert(
    hasEdge(result, "EXTENDS", userService.symbolId, base.symbolId, "base:BaseService"),
    "class extends class is EXTENDS, not IMPLEMENTS"
  );
  // TypeScript separates the two clauses syntactically, so unlike C# there is no name heuristic and
  // no chance of a base class landing in the interface bucket.
  assert(
    !hasEdge(result, "IMPLEMENTS", userService.symbolId, base.symbolId, "iface:BaseService"),
    "a base class must never be recorded as an implemented interface"
  );
  // `interface A extends B` means A satisfies B's contract — the relation find_implementations asks about.
  assert(
    hasEdge(result, "IMPLEMENTS", audited.symbolId, repository.symbolId, "iface:Repository"),
    "interface extends interface is recorded as IMPLEMENTS"
  );

  const mixed = requireSymbol(result, "Mixed", "class");
  assert(
    !result.edges.some((e) => e.fromId === mixed.symbolId && e.type === "EXTENDS"),
    "`extends withLogging(Base)` cannot be named without evaluating it, so it is dropped, not guessed"
  );

  console.log("[ok] TypeScript EXTENDS / IMPLEMENTS");
}

// ── Suite 2: TYPE_REF ────────────────────────────────────────────────────────────────────────
function runTypeRefs() {
  const source = `
export interface Payload { id: string; }
export type Outcome = string;
export class Widget {}

export class Handler {
  private cache: Payload;

  constructor(private readonly seed: Outcome) {
    this.cache = { id: seed };
  }

  run(input: Payload): Promise<Outcome> {
    const w = new Widget();
    return Promise.resolve(input.id);
  }
}
`;

  const result = extract(source);
  const payload = requireSymbol(result, "Payload", "interface");
  const outcome = requireSymbol(result, "Outcome", "type");
  const widget = requireSymbol(result, "Widget", "class");
  const run = requireSymbol(result, "run", "method");
  const cache = requireSymbol(result, "cache", "property");

  const typeRefs = result.edges.filter((e) => e.type === "TYPE_REF");
  assert(typeRefs.length > 0, "TYPE_REF must be emitted for TypeScript");

  assert(
    hasEdge(result, "TYPE_REF", cache.symbolId, payload.symbolId, "type:Payload"),
    "a field annotation belongs to the field, not to the class"
  );
  assert(
    hasEdge(result, "TYPE_REF", run.symbolId, payload.symbolId, "type:Payload"),
    "a parameter annotation belongs to its method"
  );
  assert(
    hasEdge(result, "TYPE_REF", run.symbolId, outcome.symbolId, "type:Outcome"),
    "a generic argument in the return type is a reference too"
  );
  assert(
    hasEdge(result, "TYPE_REF", run.symbolId, widget.symbolId, "type:Widget"),
    "`new Widget()` is a reference to Widget"
  );
  assert(
    !typeRefs.some((e) => e.toId === "type:string" || e.toId === "type:Promise"),
    "built-in and predefined types are not repo symbols"
  );

  // A type parameter is spelled exactly like a type reference but is local to the signature, so an
  // edge for it can never resolve — it only inflates the unresolved ratio health_check reports.
  const generic = extract(`
export interface Box<TPayload> { value: TPayload; }
export function unwrap<TValue>(box: Box<TValue>): TValue {
  return box.value;
}
`);
  assert.deepStrictEqual(
    generic.edges.filter((e) => e.type === "TYPE_REF" && /^type:T(Payload|Value)$/.test(String(e.toId))),
    [],
    "type parameters must not be emitted as type references"
  );
  assert(
    generic.edges.some((e) => e.type === "TYPE_REF"),
    "the surrounding real type reference is still emitted"
  );

  console.log("[ok] TypeScript TYPE_REF");
}

// ── Suite 3: PROPERTY_REF / PROPERTY_WRITE ───────────────────────────────────────────────────
function runPropertyEdges() {
  const source = `
export class Counter {
  private total: number = 0;

  bump(step: number): void {
    this.total = this.total + step;
  }

  read(): number {
    return this.total;
  }
}

export function loose(other: { total: number }): number {
  return other.total;
}
`;

  const result = extract(source);
  const bump = requireSymbol(result, "bump", "method");
  const read = requireSymbol(result, "read", "method");
  const total = requireSymbol(result, "total", "property");

  // The token is qualified `Counter.total`, which is exactly what lets `resolveIntraFileEdges` bind
  // it to the real property symbol — so accept either form.
  assert(
    hasEdge(result, "PROPERTY_WRITE", bump.symbolId, total.symbolId, "property:Counter.total"),
    "a write to this.total is qualified with the owning class"
  );
  assert(
    hasEdge(result, "PROPERTY_REF", read.symbolId, total.symbolId, "property:Counter.total"),
    "a read of this.total is a PROPERTY_REF"
  );
  // `this.total = this.total + step` is a write on the left and a read on the right; the write span
  // is excluded from the read pass, the right-hand occurrence is not.
  assert(
    hasEdge(result, "PROPERTY_REF", bump.symbolId, total.symbolId, "property:Counter.total"),
    "the right-hand side of a compound write is still a read"
  );

  // Deliberately narrow: an untyped receiver cannot be qualified, and emitting a bare member name
  // for every `a.b` in a JavaScript file would add rows without signal.
  const loose = requireSymbol(result, "loose", "function");
  assert(
    !result.edges.some((e) => e.fromId === loose.symbolId && e.type.startsWith("PROPERTY")),
    "a non-this receiver emits nothing while its type is unknown"
  );

  console.log("[ok] TypeScript PROPERTY_REF / PROPERTY_WRITE");
}

// ── Suite 4: members carry parentSymbolId ────────────────────────────────────────────────────
function runMemberOwnership() {
  const source = `
export interface Contract {
  id: string;
  run(): void;
}

export enum Mode {
  On = "on",
  Off = "off"
}

export class Service {
  private dep: string;

  constructor(dep: string) {
    this.dep = dep;
  }

  handle(): void {}
}

export function standalone(): { inline: string } {
  return { inline: "x" };
}
`;

  const result = extract(source);
  const service = requireSymbol(result, "Service", "class");
  const contract = requireSymbol(result, "Contract", "interface");
  const mode = requireSymbol(result, "Mode", "type");

  assert.equal(requireSymbol(result, "handle", "method").parentSymbolId, service.symbolId);
  assert.equal(requireSymbol(result, "dep", "property").parentSymbolId, service.symbolId);
  assert.equal(requireSymbol(result, "constructor", "constructor").parentSymbolId, service.symbolId);
  assert.equal(requireSymbol(result, "run", "method").parentSymbolId, contract.symbolId);
  assert.equal(requireSymbol(result, "id", "property").parentSymbolId, contract.symbolId);
  assert.equal(requireSymbol(result, "On", "property").parentSymbolId, mode.symbolId);

  // An inline object type is structural typing, not a member — indexing it would fill the graph
  // with names nobody searches for.
  assert(
    !result.symbols.some((s) => s.name === "inline"),
    "members of an inline object type are not registered"
  );

  console.log("[ok] TypeScript members carry parentSymbolId");
}

// ── Suite 5: the module-dependency shapes beyond static import ───────────────────────────────
function runImportShapes() {
  const source = `
import { a } from "./a.js";
export * from "./barrel.js";
export { b } from "./named.js";
const legacy = require("./legacy.cjs");

export async function lazy(): Promise<void> {
  const mod = await import("./lazy.js");
}
`;

  const result = extract(source);
  const imports = result.edges.filter((e) => e.type === "IMPORTS").map((e) => e.toId);

  for (const specifier of ["./a.js", "./barrel.js", "./named.js", "./legacy.cjs", "./lazy.js"]) {
    assert(
      imports.includes(`import:${specifier}`),
      `expected an IMPORTS edge for ${specifier}; saw ${JSON.stringify(imports)}`
    );
  }

  // `reason` decides resolution, it does not describe provenance. schema.ts rewrites a NULL reason
  // to 'unresolved import token', and that exact string is what resolveImportEdges selects on — so
  // labelling a re-export `re_export` left it permanently unresolved and the barrel stayed invisible
  // to detect_circular_dependencies, which is the whole point of emitting the edge.
  for (const edge of result.edges.filter((e) => e.type === "IMPORTS")) {
    const specifier = String(edge.toId).slice("import:".length);
    if (!specifier.startsWith(".")) continue;
    assert.equal(
      edge.reason ?? null,
      null,
      `a relative import must carry no reason so the resolver can claim it (${specifier} had ${String(edge.reason)})`
    );
  }

  console.log("[ok] TypeScript re-export, require and dynamic import all produce IMPORTS");
}

// ── Suite 6: no edge may point out of a symbol that does not exist ───────────────────────────
function runNoOrphanEdgesAcrossAllPasses() {
  const source = `
export interface Contract { id: string; run(): void; }
export type Alias = { inline: string };
export enum Mode { On, Off }

export class Service implements Contract {
  id: string = "";
  private cache = new Map<string, Contract>();

  constructor(private readonly dep: Contract) {
    this.id = dep.id;
    helper();
  }

  run(): void {
    this.cache.clear();
    helper();
  }
}

export const Named = class Inner extends Service {
  extra(): void { helper(); }
};

export function shape(input: Alias): { nested: Contract } {
  const inner = (): void => { helper(); };
  inner();
  return { nested: null as unknown as Contract };
}
`;

  const result = extract(source);
  const symbolIds = new Set(result.symbols.map((s) => s.symbolId));
  const orphans = result.edges
    .filter((e) => !symbolIds.has(e.fromId))
    .map((e) => `${e.type} ${e.fromId} -> ${e.toId}`);

  assert.deepStrictEqual(orphans, [], "every edge from every pass must originate at a real symbol");

  console.log("[ok] TypeScript edges have no dangling fromId across all passes");
}

runHeritage();
runTypeRefs();
runPropertyEdges();
runMemberOwnership();
runImportShapes();
runNoOrphanEdgesAcrossAllPasses();
