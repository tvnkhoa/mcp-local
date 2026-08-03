/**
 * MCP-ISSUE-032 — tree-sitter nodes must never be compared with `===`.
 *
 * Every `.parent`, `.childForFieldName()` and `.descendantsOfType()` access mints a NEW JavaScript
 * wrapper around the same underlying native node. The binding keeps a weak cache of wrappers, so `===`
 * holds most of the time and stops holding once that cache is pruned — making the comparison a function
 * of garbage collection rather than of the syntax tree.
 *
 * Four sites did this. The one in `isAncestorInvocation` decided whether a member access was part of an
 * invocation, so under memory pressure method calls were misclassified: one 300-line file emitted 14
 * spurious PROPERTY_REF edges for things like `Regex.IsMatch` and `string.Split`. That is why two
 * identical index runs disagreed on edge counts while agreeing exactly on symbol counts, and why the
 * variance concentrated in PROPERTY_REF — the last C# pass to run.
 *
 * Asserted behaviourally rather than by forcing GC: a test that depends on collection timing is a test
 * that fails for the wrong reasons. A method invocation must never appear as a property reference,
 * which is false whenever the identity check misfires.
 */

import assert from "node:assert";

import { extractGraphData } from "../../dist/services/extractors/treeSitterExtractor.js";

let failures = 0;
const log = [];

function propertyRefs(source) {
  const { edges } = extractGraphData({ repoId: "r", filePath: "src/X.cs", language: "csharp", source });
  return new Set(
    edges.filter((e) => e.type === "PROPERTY_REF").map((e) => e.toId.replace(/^property:/, ""))
  );
}

function check(label, source, forbidden) {
  const refs = propertyRefs(source);
  const leaked = forbidden.filter((f) => refs.has(f));
  if (leaked.length === 0) {
    log.push(`  ok    ${label}`);
    return;
  }
  failures += 1;
  log.push(`  FAIL  ${label}`);
  log.push(`          emitted as PROPERTY_REF but is an invocation: ${leaked.join(", ")}`);
  log.push(`          all property refs: ${[...refs].sort().join(", ") || "(none)"}`);
}

// The exact shapes that regressed. Each is a method call, so none may be a property reference.
check(
  "static method invocation",
  `public class S {
     public void M(string a, string b) { Regex.IsMatch(a, b); Regex.Replace(a, b, ""); }
   }`,
  ["Regex.IsMatch", "Regex.Replace"]
);

check(
  "instance method invocation on a local",
  `public class S {
     public void M(string s) { s.Trim(); s.Split(','); s.Replace("a", "b"); }
   }`,
  ["s.Trim", "s.Split", "s.Replace", "Trim", "Split", "Replace"]
);

check(
  "chained invocation",
  `public class S {
     public void M(HtmlDocument doc) { doc.DocumentNode.SelectSingleNode("//p").InnerText.Trim(); }
   }`,
  ["DocumentNode.SelectSingleNode", "SelectSingleNode", "Trim"]
);

check(
  "invocation with a generic argument",
  `public class S {
     public void M() { JsonSerializer.Deserialize<Thing>("{}"); }
   }`,
  ["JsonSerializer.Deserialize", "Deserialize"]
);

// The other half: a genuine property read must STILL be reported, so the fix cannot have simply
// stopped emitting property references.
const kept = propertyRefs(`public class S {
   public void M(Order o) { var x = o.CustomerName; var y = o.Total; }
 }`);
if (kept.size === 0) {
  failures += 1;
  log.push("  FAIL  a genuine property read is still emitted");
  log.push("          nothing emitted — the fix silenced property refs entirely");
} else {
  log.push(`  ok    a genuine property read is still emitted (${[...kept].sort().join(", ")})`);
}

// The fifth site, found later and worse than the other four: `baseList.parent !== node` in
// `csharpSymbols.ts`. When the identity check misfired the whole class was SKIPPED — no IMPLEMENTS edge
// and no base-list TYPE_REF — so classes appeared and vanished between runs. Six repeated extractions of
// one real test file gave 0, 0, 6, 6, 0, 6 IMPLEMENTS edges.
//
// Several classes in one file, because a single class was not enough to reproduce it: the wrapper cache
// only gets pruned once there is enough churn to prune.
const multiClass = `
  public interface IAlpha { }
  public interface IBeta { }
  public class One : IAlpha { public void M() { Regex.IsMatch("a", "b"); } }
  public class Two : IBeta { public void M() { "x".Trim().Split(','); } }
  public class Three : IAlpha, IBeta { public void M() { JsonSerializer.Deserialize<Thing>("{}"); } }
  public class Outer : IAlpha {
    public class Nested : IBeta { }
    public void M() { Console.WriteLine("x"); }
  }
`;
const implementsSets = new Set();
for (let i = 0; i < 8; i += 1) {
  const { edges } = extractGraphData({ repoId: "r", filePath: "src/Multi.cs", language: "csharp", source: multiClass });
  implementsSets.add(
    edges.filter((e) => e.type === "IMPLEMENTS").map((e) => `${e.fromId}|${e.toId}`).sort().join(",")
  );
}
const oneSet = [...implementsSets][0] ?? "";
if (implementsSets.size !== 1) {
  failures += 1;
  log.push(`  FAIL  8 extractions produced ${implementsSets.size} different IMPLEMENTS sets`);
  log.push(`          base_list parent identity is order/GC dependent again`);
} else if (oneSet.split(",").filter(Boolean).length < 6) {
  // One, Two, Outer, Nested + Three twice = 6. Nested counts on its own: the guard rejects a base_list
  // that belongs to a DIFFERENT declaration, and Nested's base_list belongs to Nested. Fewer than 6
  // means whole classes are being skipped, which is the failure this case exists to catch.
  failures += 1;
  log.push(`  FAIL  IMPLEMENTS edges are being dropped: only ${oneSet.split(",").filter(Boolean).length} of 6`);
} else {
  log.push(`  ok    8 extractions agree on IMPLEMENTS across 4 classes (${oneSet.split(",").filter(Boolean).length} edges)`);
}

// Determinism: repeated extraction of the same source must give an identical edge set. This is the
// property that MCP-ISSUE-032 broke, stated directly.
const src = `public class S {
   public void M(string a, string b) {
     if (Regex.IsMatch(a, b)) { a.Trim().Split(',').ToString(); }
   }
 }`;
const signatures = new Set();
for (let i = 0; i < 8; i += 1) {
  const { edges } = extractGraphData({ repoId: "r", filePath: "src/X.cs", language: "csharp", source: src });
  signatures.add(edges.map((e) => `${e.fromId}|${e.toId}|${e.type}`).sort().join("\n"));
}
if (signatures.size === 1) {
  log.push("  ok    8 repeated extractions produce an identical edge set");
} else {
  failures += 1;
  log.push(`  FAIL  8 repeated extractions produced ${signatures.size} different edge sets`);
}

console.log(log.join("\n"));
console.log(`\n  ${failures === 0 ? "PASS" : "FAIL"} — tree-sitter node identity (${failures} failing)`);
assert.equal(failures, 0, `${failures} node-identity check(s) failed`);
