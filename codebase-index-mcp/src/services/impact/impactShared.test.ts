import assert from "node:assert/strict";
import test from "node:test";

import {
  TRIVIAL_CALLEE_IN_CLAUSE,
  TRIVIAL_CALLEE_TOKENS,
  buildEdgeToSymbolPairsCte,
  getEdgeDefaults,
  normalizePath
} from "./impactShared.js";
import type { EdgeRecord } from "../../types/index.js";

/**
 * The shared pieces every impact answer is built from (backlog B-06).
 *
 * `buildEdgeToSymbolPairsCte` is the one worth the most: it encodes the token grammar for "this
 * edge points at this symbol", it is stitched into SQL by string concatenation, and its structure
 * — a `union` of one branch per alternative rather than one `or`-ed predicate — is load-bearing
 * for performance, not style. The disjunctive form measured 216 s on a large index; the union
 * form is 448× faster. A refactor that "simplifies" it back to `or` would pass every integration
 * harness and quietly restore the timeout, so the shape is asserted here.
 */

const edge = (parts: Partial<EdgeRecord>): EdgeRecord => ({
  repoId: "r", fromId: "f", toId: "t", type: "CALLS", ...parts
} as EdgeRecord);

test("normalizePath converts Windows separators and leaves POSIX alone", () => {
  assert.equal(normalizePath("src\\services\\graph\\edgeResolver.ts"), "src/services/graph/edgeResolver.ts");
  assert.equal(normalizePath("src/services/graph/edgeResolver.ts"), "src/services/graph/edgeResolver.ts");
  assert.equal(normalizePath(""), "");
});

test("the pairs CTE keeps one union branch per token alternative", () => {
  const sql = buildEdgeToSymbolPairsCte("s.repo_id = @repoId and s.file_path = @filePath");

  // Six alternatives => five `union`s. Asserted as a count because the failure mode is a branch
  // being dropped during an edit, which leaves valid SQL that silently resolves fewer edges.
  assert.equal((sql.match(/\bunion\b/g) ?? []).length, 5, sql);

  for (const token of ["'callee:'", "'type:'", "'property:'", "e.to_id = s.symbol_id"]) {
    assert.ok(sql.includes(token), `missing alternative: ${token}`);
  }
  // The any-owner branch is the only LIKE, and must stay gated on kind = 'property'.
  assert.match(sql, /s\.kind = 'property' and e\.to_id like/);
});

test("the pairs CTE stays union-based, not a single or-ed predicate", () => {
  const sql = buildEdgeToSymbolPairsCte("s.repo_id = @repoId");
  // `cross join` is SQLite's join-order pin; losing it lets the planner drive from `edges`,
  // which is the 216 s plan. One per branch.
  assert.ok((sql.match(/cross join/g) ?? []).length >= 6, "each branch must pin its join order");
  assert.ok(!/\bor\b\s+e\.to_id/.test(sql), "the disjunctive predicate form must not come back");
});

test("the pairs CTE inlines the caller's filter into every branch", () => {
  // Referenced once per branch, which is why the filter's parameters must be named, not positional.
  const filter = "s.repo_id = @repoId and s.file_path = @filePath";
  const sql = buildEdgeToSymbolPairsCte(filter);
  assert.equal((sql.split(filter).length - 1), 6, "filter must appear in all six branches");
  assert.ok(!sql.includes("?"), "positional parameters would bind wrongly when repeated");
});

test("unresolved token prefixes outrank the edge type when scoring confidence", () => {
  // A CALLS edge whose target is still a token is NOT a resolved call — the prefix check has to
  // come first, or every unresolved callee would report confidence 1.0.
  assert.deepEqual(getEdgeDefaults(edge({ toId: "callee:map", type: "CALLS" })),
    { confidence: 0.4, reason: "unresolved callee token" });
  assert.deepEqual(getEdgeDefaults(edge({ toId: "type:Foo", type: "TYPE_REF" })),
    { confidence: 0.45, reason: "unresolved type token" });
  assert.deepEqual(getEdgeDefaults(edge({ toId: "property:Foo.Bar", type: "PROPERTY_REF" })),
    { confidence: 0.5, reason: "unresolved property token" });
  assert.deepEqual(getEdgeDefaults(edge({ toId: "import:x", type: "IMPORTS" })),
    { confidence: 0.5, reason: "unresolved import token" });
});

test("a resolved edge is scored by its type", () => {
  assert.equal(getEdgeDefaults(edge({ toId: "abc123", type: "CALLS" })).confidence, 1.0);
  assert.equal(getEdgeDefaults(edge({ toId: "abc123", type: "IMPORTS" })).confidence, 0.95);
  assert.equal(getEdgeDefaults(edge({ toId: "abc123", type: "TYPE_REF" })).confidence, 0.9);
  assert.equal(getEdgeDefaults(edge({ toId: "abc123", type: "PROPERTY_REF" })).confidence, 0.85);
  assert.equal(getEdgeDefaults(edge({ toId: "abc123", type: "PROPERTY_WRITE" })).confidence, 0.82);
  // An edge type with no rule falls through to the catch-all rather than throwing.
  assert.deepEqual(getEdgeDefaults(edge({ toId: "abc123", type: "IMPLEMENTS" })),
    { confidence: 1.0, reason: "direct edge" });
});

test("the trivial-callee IN clause is derived from the token set, not written twice", () => {
  // Two hand-maintained copies of this list is how one gains a token and the other does not.
  const quoted = TRIVIAL_CALLEE_IN_CLAUSE.split(", ");
  assert.equal(quoted.length, TRIVIAL_CALLEE_TOKENS.size);
  for (const token of TRIVIAL_CALLEE_TOKENS) {
    assert.ok(TRIVIAL_CALLEE_IN_CLAUSE.includes(`'callee:${token}'`), `missing ${token}`);
  }
  // Every entry is a quoted callee token — an unquoted one would be a SQL syntax error at runtime.
  for (const entry of quoted) assert.match(entry, /^'callee:[^']+'$/);
});
