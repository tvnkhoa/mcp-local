import assert from "node:assert/strict";
import test from "node:test";

import { parameterCount, pickInheritedMethod, pickOwnedMethod, type ClassBase, type MemberCandidate } from "./interfaceSiblings.js";

test("MCP-ISSUE-133: parameterCount reads the declaration's top-level parameters", () => {
  assert.equal(parameterCount("Task Save(string key, int value);", "Save"), 2);
  assert.equal(parameterCount("public Task Save()", "Save"), 0);
  assert.equal(parameterCount("public Task Save(  )", "Save"), 0);
  assert.equal(parameterCount("public Task<T> Save<T>(Dictionary<string, int> map, (int, int) pair, int[] xs)", "Save"), 3);
  assert.equal(parameterCount("public void Save(string sep = \",\", char c = ',')", "Save"), 2);
  assert.equal(parameterCount("async save(cb: (a: number, b: number) => void = () => {}, opts?: { a: 1, b: 2 }): Promise<void>", "save"), 2);
  assert.equal(parameterCount("void SaveAll(int a)", "Save"), null, "another name is not this method");
  assert.equal(parameterCount(null, "Save"), null);
  assert.equal(parameterCount("public int Save", "Save"), null);
});

test("MCP-ISSUE-133: pickOwnedMethod — owner link first, file only for unlinked rows, arity among overloads", () => {
  const rows: MemberCandidate[] = [
    { symbolId: "h", filePath: "S.cs", parentSymbolId: "H", signature: "void Save(int a)" },
    { symbolId: "a1", filePath: "S.cs", parentSymbolId: "A", signature: "void Save(int a)" },
    { symbolId: "a2", filePath: "S.cs", parentSymbolId: "A", signature: "void Save(int a, int b)" },
    { symbolId: "legacy", filePath: "L.cs", parentSymbolId: null, signature: null }
  ];
  assert.equal(pickOwnedMethod(rows, "A", "S.cs", "Save", 2)?.symbolId, "a2");
  assert.equal(pickOwnedMethod(rows, "A", "S.cs", "Save", null)?.symbolId, "a1");
  assert.equal(pickOwnedMethod(rows, "A", "S.cs", "Save", 5)?.symbolId, "a1", "no overload fits: the first");
  assert.equal(pickOwnedMethod(rows, "B", "S.cs", "Save", 1), undefined, "another type's Save in the file is not B's");
  assert.equal(pickOwnedMethod(rows, "L", "L.cs", "Save", 1)?.symbolId, "legacy");
});

test("MCP-ISSUE-133 (row #10): pickInheritedMethod — own first, else the most-derived base declaration; cycles stop", () => {
  const rows: MemberCandidate[] = [
    { symbolId: "root", filePath: "Root.cs", parentSymbolId: "Root", signature: "public abstract Task Save(string k);" },
    { symbolId: "mid", filePath: "Mid.cs", parentSymbolId: "Mid", signature: "public override Task Save(string k)" },
    { symbolId: "own", filePath: "Own.cs", parentSymbolId: "Own", signature: "public Task Save(string k)" }
  ];
  const bases = new Map<string, ClassBase>([
    ["Leaf", { baseId: "Mid", filePath: "Mid.cs" }],
    ["Mid", { baseId: "Root", filePath: "Root.cs" }],
    ["Own", { baseId: "Mid", filePath: "Mid.cs" }],
    ["X", { baseId: "Y", filePath: "Y.cs" }],
    ["Y", { baseId: "X", filePath: "X.cs" }]
  ]);
  const baseOf = (id: string) => bases.get(id);
  assert.equal(pickInheritedMethod(rows, baseOf, "Leaf", "Leaf.cs", "Save", 1)?.symbolId, "mid", "the override in the middle beats the abstract root");
  assert.equal(pickInheritedMethod(rows, baseOf, "Own", "Own.cs", "Save", 1)?.symbolId, "own", "an own declaration wins");
  assert.equal(pickInheritedMethod(rows, baseOf, "Mid", "Mid.cs", "Save", 1)?.symbolId, "mid");
  assert.equal(pickInheritedMethod(rows, baseOf, "X", "X.cs", "Save", 1), undefined, "a cycle ends with no pick");
  assert.equal(pickInheritedMethod(rows, baseOf, "Free", "Free.cs", "Save", 1), undefined, "no base, no Save");
});
