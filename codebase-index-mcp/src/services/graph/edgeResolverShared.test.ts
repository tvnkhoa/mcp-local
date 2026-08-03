import assert from "node:assert/strict";
import test from "node:test";

import { pickBestNamedCandidate } from "./edgeResolverShared.js";

/**
 * Candidate selection during edge resolution (backlog B-06).
 *
 * This is the function that decides which same-named symbol an unresolved `callee:`/`type:`/
 * `property:` token points at, and it feeds CALLS, TYPE_REF and PROPERTY_REF resolution alike —
 * so one wrong tie-break shows up as drift across three edge types at once. That is exactly what
 * happened before `b764b39`: ties were resolved by input order, and the input order came from a
 * query with no `ORDER BY`.
 *
 * Pure — candidates in, winner out — so the property worth pinning is precisely that: **the result
 * is a function of the arguments, not of their arrangement.**
 */

const c = (symbolId: string, filePath: string, kind: string) => ({ symbolId, filePath, kind });
const KINDS = ["class", "interface", "function", "method"] as const;

test("no candidates yields undefined", () => {
  assert.equal(pickBestNamedCandidate([], "a.ts", KINDS), undefined);
});

test("a candidate in the calling file wins over one elsewhere", () => {
  // The same-file penalty (0 vs 100) dominates every kind penalty, which is the intent:
  // a local definition beats a better-typed remote one.
  const best = pickBestNamedCandidate(
    [c("bbb", "other.ts", "class"), c("aaa", "caller.ts", "method")],
    "caller.ts",
    KINDS
  );
  assert.equal(best?.symbolId, "aaa");
});

test("within the same file, kind priority decides", () => {
  const best = pickBestNamedCandidate(
    [c("zzz", "caller.ts", "method"), c("aaa", "caller.ts", "class")],
    "caller.ts",
    KINDS
  );
  assert.equal(best?.symbolId, "aaa", "class outranks method in the supplied priority");
});

test("a kind absent from the priority list ranks last but is still selectable", () => {
  const best = pickBestNamedCandidate([c("only", "x.ts", "struct")], "caller.ts", KINDS);
  assert.equal(best?.symbolId, "only");

  const ranked = pickBestNamedCandidate(
    [c("unknown", "x.ts", "struct"), c("known", "x.ts", "function")],
    "caller.ts",
    KINDS
  );
  assert.equal(ranked?.symbolId, "known");
});

test("a tie is broken by symbolId, not by input order", () => {
  // The regression this exists for. Both candidates score identically — different file from the
  // caller, same kind — so before the symbolId tie-break the winner was whichever came first.
  const forwards = pickBestNamedCandidate(
    [c("aaa", "one.ts", "class"), c("bbb", "two.ts", "class")],
    "caller.ts",
    KINDS
  );
  const backwards = pickBestNamedCandidate(
    [c("bbb", "two.ts", "class"), c("aaa", "one.ts", "class")],
    "caller.ts",
    KINDS
  );
  assert.equal(forwards?.symbolId, "aaa");
  assert.equal(backwards?.symbolId, "aaa", "reversing the input must not change the winner");
});

test("order independence holds across every permutation of a tied set", () => {
  // Three-way tie: the property must hold for all 6 orderings, not just the reversal above.
  const all = [c("ccc", "a.ts", "class"), c("aaa", "b.ts", "class"), c("bbb", "c.ts", "class")];
  const permutations = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]
  ];
  for (const p of permutations) {
    const winner = pickBestNamedCandidate(p.map((i) => all[i]), "caller.ts", KINDS);
    assert.equal(winner?.symbolId, "aaa", `permutation ${JSON.stringify(p)} picked ${winner?.symbolId}`);
  }
});

test("the same-file rule outranks the tie-break", () => {
  // "zzz" sorts last but is the only local one; locality must still win.
  const best = pickBestNamedCandidate(
    [c("aaa", "elsewhere.ts", "class"), c("zzz", "caller.ts", "class")],
    "caller.ts",
    KINDS
  );
  assert.equal(best?.symbolId, "zzz");
});
