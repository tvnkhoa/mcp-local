/**
 * TypeScript extraction contract.
 *
 * The first harness to exercise the TS/JS lane at all — before it, every wired `test:*` script was
 * C#-specific, which is why the defect this file pins went unnoticed: `findEnclosingSymbolId` minted
 * `repoId:filePath:name:row+1` while symbol registration used `repoId:filePath:kind:name:row`, so
 * 77% of the TypeScript edges in this very repo carried a `fromId` that matched no symbol. Both
 * sides now go through `makeSymbolId`, and suite 1 is what keeps them from drifting apart again.
 */

import assert from "node:assert";

import { extractGraphData } from "../../dist/services/extractors/treeSitterExtractor.js";

function extract(source, filePath = "src/sample.ts") {
  return extractGraphData({ repoId: "repo-test", filePath, language: "typescript", source });
}

function requireSymbol(result, name, kind) {
  const found = result.symbols.find((s) => s.name === name && s.kind === kind);
  assert(found, `Expected a ${kind} symbol named ${name}`);
  return found;
}

function callsFrom(result, symbolId) {
  return result.edges.filter((e) => e.type === "CALLS" && e.fromId === symbolId).map((e) => e.toId);
}

// ── Suite 1: no edge may point out of a symbol that does not exist ───────────────────────────
function runNoOrphanEdges() {
  const source = `
import { helper } from "./helper.js";

export function topLevel(): void {
  helper();
}

export const boundArrow = (): void => {
  helper();
};

export class Service {
  run(): void {
    helper();
  }
}

export function withCallback(items: string[]): string[] {
  return items.map((item) => helper(item));
}

function outer(): void {
  const inner = (): void => {
    helper();
  };
  inner();
}
`;

  const result = extract(source);
  const symbolIds = new Set(result.symbols.map((s) => s.symbolId));
  const orphans = result.edges
    .filter((e) => !symbolIds.has(e.fromId))
    .map((e) => `${e.type} ${e.fromId} -> ${e.toId}`);

  assert.deepStrictEqual(orphans, [], `Every edge fromId must name a symbol this file produced`);

  console.log("[ok] TypeScript edges have no dangling fromId");
}

// ── Suite 2: a call is attributed to the nearest NAMED owner ─────────────────────────────────
function runEnclosingOwnerAttribution() {
  const source = `
import { helper } from "./helper.js";

export function topLevel(): void {
  helper();
}

export const boundArrow = (): void => {
  helper();
};

export class Service {
  run(): void {
    helper();
  }
}

export function withCallback(items: string[]): string[] {
  return items.map((item) => helper(item));
}

function outer(): void {
  const inner = (): void => {
    helper();
  };
  inner();
}
`;

  const result = extract(source);

  for (const [name, kind] of [
    ["topLevel", "function"],
    ["boundArrow", "function"],
    ["run", "method"],
    ["withCallback", "function"],
    ["inner", "function"],
    ["outer", "function"]
  ]) {
    const symbol = requireSymbol(result, name, kind);
    if (name !== "outer") {
      assert(
        callsFrom(result, symbol.symbolId).includes("callee:helper"),
        `Expected ${name} to own its call to helper()`
      );
    }
  }

  // An anonymous callback is not a symbol, so its call belongs to the function that contains it —
  // never to a fabricated `anonymous:<row>` id, and never demoted all the way to the module.
  const withCallback = requireSymbol(result, "withCallback", "function");
  const moduleSymbol = result.symbols.find((s) => s.kind === "module");
  assert(moduleSymbol, "Expected a module symbol");
  assert(
    !callsFrom(result, moduleSymbol.symbolId).includes("callee:helper"),
    "A call inside a function must not be attributed to the module"
  );
  assert(
    callsFrom(result, withCallback.symbolId).includes("callee:helper"),
    "A call inside an anonymous callback belongs to the enclosing named function"
  );

  // `inner` is declared inside `outer`, not at module scope. It is still a call-graph node — and
  // because both ends are in this file, `resolveIntraFileEdges` has already turned the token into
  // the real symbolId, so accept either form.
  const outer = requireSymbol(result, "outer", "function");
  const inner = requireSymbol(result, "inner", "function");
  const outerCalls = callsFrom(result, outer.symbolId);
  assert(
    outerCalls.includes(inner.symbolId) || outerCalls.includes("callee:inner"),
    `Expected outer() to call inner(); saw ${JSON.stringify(outerCalls)}`
  );

  console.log("[ok] TypeScript calls are attributed to the nearest named owner");
}

// ── Suite 3: a nested declaration is keyed on its own row, not its ancestor's ────────────────
function runNestedDeclarationRows() {
  const source = `
export function outerFn(): void {
  const nestedOne = (): void => {
    doWork();
  };
  const nestedTwo = (): void => {
    doWork();
  };
  nestedOne();
  nestedTwo();
}
`;

  const result = extract(source);
  const one = requireSymbol(result, "nestedOne", "function");
  const two = requireSymbol(result, "nestedTwo", "function");

  assert.notStrictEqual(one.symbolId, two.symbolId, "Two nested declarations must not share an id");
  assert(one.line < two.line, "Each nested declaration keeps its own line");
  assert(
    callsFrom(result, one.symbolId).includes("callee:doWork") &&
      callsFrom(result, two.symbolId).includes("callee:doWork"),
    "Each nested declaration owns the calls in its own body"
  );

  console.log("[ok] TypeScript nested declarations are keyed on their own row");
}

// ── Suite 4: the symbol kinds the lane is expected to produce ────────────────────────────────
function runSymbolKindCoverage() {
  const source = `
export interface Contract {
  id: string;
}

export type Alias = Contract;

export enum Mode {
  On,
  Off
}

export class Impl {
  private cache: string;

  constructor(cache: string) {
    this.cache = cache;
  }

  read(): string {
    return this.cache;
  }
}

export function* generate(): Generator<number> {
  yield 1;
}

export const CONSTANT = "value";
`;

  const result = extract(source);

  requireSymbol(result, "Contract", "interface");
  requireSymbol(result, "Alias", "type");
  requireSymbol(result, "Mode", "type");
  requireSymbol(result, "Impl", "class");
  requireSymbol(result, "read", "method");
  requireSymbol(result, "generate", "function");
  requireSymbol(result, "CONSTANT", "variable");

  console.log("[ok] TypeScript symbol kind coverage");
}

// ── Suite 5: `.tsx` is parsed with the JSX dialect ───────────────────────────────────────────
function runTsxDialect() {
  const source = `
import { useState } from "react";

export const Widget = () => {
  const [count, setCount] = useState(0);
  return <div onClick={() => setCount(count + 1)}>{count}</div>;
};

export function afterJsx(): void {
  doWork();
}

export class Panel {
  render(): void {
    doWork();
  }
}
`;

  // `.tsx` and `.ts` both carry language tag "typescript"; only the grammar differs. Under the
  // plain dialect the JSX expression parses to an ERROR node, and what error recovery then
  // swallows is not something to pin an assertion on — so this asserts the outcome that matters:
  // with the right dialect, nothing in the file is lost.
  const tsx = extract(source, "src/Widget.tsx");
  requireSymbol(tsx, "Widget", "function");
  requireSymbol(tsx, "afterJsx", "function");
  requireSymbol(tsx, "Panel", "class");
  requireSymbol(tsx, "render", "method");

  console.log("[ok] .tsx is parsed with the JSX dialect");
}

runNoOrphanEdges();
runEnclosingOwnerAttribution();
runNestedDeclarationRows();
runSymbolKindCoverage();
runTsxDialect();
