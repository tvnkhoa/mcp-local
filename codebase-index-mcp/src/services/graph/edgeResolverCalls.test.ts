import assert from "node:assert/strict";
import test from "node:test";

import { suppressBareCallsShadowedByQualified, type ResolvedUpdate } from "./edgeResolverCalls.js";
import { NAME_ONLY_EDGE_REASONS } from "../../types/index.js";
import { buildCoverageBlock, summarizeEdgeProvenance } from "../../middleware/coverage.js";

/**
 * MCP-ISSUE-052 — the bare/qualified double edge.
 *
 * The defect: for one call site `ConversationLoopCorrelationCodec.Parse(x)` the C# extractor emits
 * BOTH `callee:Parse` and `callee:ConversationLoopCorrelationCodec.Parse`, and relied on the unique
 * index on `edges(repo_id, from_id, to_id, type)` to collapse them. Once MCP-ISSUE-036 taught the
 * qualified token to follow its receiver, the two stopped landing on the same symbol: the qualified
 * half resolved correctly while the bare half kept picking whichever same-named method won
 * `pickBestNamedCandidate`. Nothing collapsed, and the caller got one right edge plus one wrong one
 * — the wrong one seeding a seven-node subtree reported at `confidence: "high"`.
 *
 * The tests below pin the three-part rule that decides a suppression, and — more importantly — the
 * cases that must NOT be suppressed. A rule that only ever deletes is easy to get right and useless;
 * the risk here is losing a genuine same-named local call.
 */

const CALLER = "caller-1";

function bare(name: string, target: string, reason = "resolved callee by name", confidence = 0.75): ResolvedUpdate {
  return { fromId: CALLER, oldToId: `callee:${name}`, newToId: target, confidence, reason };
}

function qualified(receiver: string, name: string, target: string): ResolvedUpdate {
  return {
    fromId: CALLER,
    oldToId: `callee:${receiver}.${name}`,
    newToId: target,
    confidence: 0.85,
    reason: "resolved callee by receiver type"
  };
}

test("the filed case: bare Parse is suppressed once qualified Codec.Parse proves a different target", () => {
  const updates = [
    qualified("ConversationLoopCorrelationCodec", "Parse", "codec-parse"),
    bare("Parse", "outbound-metadata-parse")
  ];

  const suppressed = suppressBareCallsShadowedByQualified(updates);

  assert.equal(suppressed, 1);
  // Demoted back to its placeholder rather than deleted: the audit trail survives, and
  // MCP-ISSUE-053's unresolved filter hides it from edgesOut / topCallees.
  assert.deepEqual(updates[1], {
    fromId: CALLER,
    oldToId: "callee:Parse",
    newToId: "callee:Parse",
    confidence: 0.1,
    reason: "superseded by qualified call"
  });
  // The correct edge is untouched.
  assert.equal(updates[0].newToId, "codec-parse");
});

test("a same-file bare call is NOT suppressed — it needed no cross-file inference", () => {
  const updates = [
    qualified("Codec", "Parse", "codec-parse"),
    bare("Parse", "local-parse", "resolved callee same-file", 0.9)
  ];

  assert.equal(suppressBareCallsShadowedByQualified(updates), 0);
  assert.equal(updates[1].newToId, "local-parse");
  assert.equal(updates[1].reason, "resolved callee same-file");
});

test("agreement is not a conflict: bare and qualified on the same target are both kept", () => {
  const updates = [qualified("Codec", "Parse", "codec-parse"), bare("Parse", "codec-parse")];

  assert.equal(suppressBareCallsShadowedByQualified(updates), 0);
  assert.equal(updates[1].newToId, "codec-parse");
});

test("an unresolved qualified sibling proves nothing, so the bare edge stands", () => {
  const stillPlaceholder: ResolvedUpdate = {
    fromId: CALLER,
    oldToId: "callee:Codec.Parse",
    newToId: "callee:Codec.Parse",
    confidence: 0.1,
    reason: "external boundary"
  };
  const updates = [stillPlaceholder, bare("Parse", "some-parse")];

  assert.equal(suppressBareCallsShadowedByQualified(updates), 0);
  assert.equal(updates[1].newToId, "some-parse");
});

test("the qualified sibling must belong to the SAME caller", () => {
  const updates = [
    { ...qualified("Codec", "Parse", "codec-parse"), fromId: "another-caller" },
    bare("Parse", "outbound-metadata-parse")
  ];

  assert.equal(suppressBareCallsShadowedByQualified(updates), 0);
  assert.equal(updates[1].newToId, "outbound-metadata-parse");
});

test("member names must match — Codec.Parse says nothing about a bare Format", () => {
  const updates = [qualified("Codec", "Parse", "codec-parse"), bare("Format", "some-format")];

  assert.equal(suppressBareCallsShadowedByQualified(updates), 0);
  assert.equal(updates[1].newToId, "some-format");
});

test("the ambiguous name-only label is suppressible too", () => {
  const updates = [
    qualified("Codec", "Parse", "codec-parse"),
    bare("Parse", "outbound-metadata-parse", "resolved callee by name (ambiguous)")
  ];

  assert.equal(suppressBareCallsShadowedByQualified(updates), 1);
  assert.equal(updates[1].reason, "superseded by qualified call");
});

test("an interface-dispatch edge is evidence, not a guess, and survives", () => {
  const updates = [
    qualified("Codec", "Parse", "codec-parse"),
    bare("Parse", "iface-parse", "resolved interface method", 0.8)
  ];

  assert.equal(suppressBareCallsShadowedByQualified(updates), 0);
  assert.equal(updates[1].newToId, "iface-parse");
});

test("no qualified rows at all is a cheap no-op", () => {
  const updates = [bare("Parse", "some-parse"), bare("Format", "some-format")];

  assert.equal(suppressBareCallsShadowedByQualified(updates), 0);
  assert.equal(updates[0].newToId, "some-parse");
  assert.equal(updates[1].newToId, "some-format");
});

test("a dotted receiver chain still keys off the terminal member", () => {
  const updates = [
    qualified("Outer.Inner", "Parse", "inner-parse"),
    bare("Parse", "unrelated-parse")
  ];

  assert.equal(suppressBareCallsShadowedByQualified(updates), 1);
  assert.equal(updates[1].reason, "superseded by qualified call");
});

/**
 * MCP-ISSUE-060 — the interface relabel laundered a name guess into a proof.
 *
 * `resolveCallEdgesBatch` sets `dispatchMethodName` on two different paths: one where extraction
 * handed it a receiver that named an interface, and one where a bare NAME match merely happened to
 * land on a method whose parent is an interface. Both emitted `resolved interface method` at 0.8,
 * and because the reason ternary tested `dispatchMethodName` before `nameAmbiguous`, the ambiguity
 * branch was unreachable for the second path.
 *
 * Measured on `wec.be`: 2070 such edges, of which 986 targeted a method name declared by two or more
 * DIFFERENT interfaces — `CreateAsync` by 35 of them. That is how `EmailOnAcidService` acquired a
 * confident CALLS edge into `ISmsConversationService.GetAsync`.
 *
 * The value of the fix is entirely in what the coverage layer sees, so that is what is pinned here:
 * the unproven variant must count as name-only, and the proven one must not.
 */
test("an unproven-receiver interface edge counts as name-only provenance; a proven one does not", () => {
  assert.equal(
    NAME_ONLY_EDGE_REASONS.has("resolved interface method (unproven receiver)"),
    true,
    "the unproven variant must reach summarizeEdgeProvenance's nameOnly count"
  );
  assert.equal(
    NAME_ONLY_EDGE_REASONS.has("resolved interface method"),
    false,
    "a receiver-proven interface dispatch is knowledge, not a guess — flagging it would train agents to discount good answers"
  );

  const prov = summarizeEdgeProvenance([
    { reason: "resolved interface method", confidence: 0.8 },
    { reason: "resolved interface method (unproven receiver)", confidence: 0.7 },
    { reason: "resolved callee same-file", confidence: 0.9 }
  ]);
  assert.equal(prov.total, 3);
  assert.equal(prov.nameOnly, 1);
});

test("a traversal standing on an unproven interface edge cannot report high confidence", () => {
  const block = buildCoverageBlock({
    resultCount: 7,
    kind: "call_chain",
    edgeProvenance: summarizeEdgeProvenance([
      { reason: "resolved interface method (unproven receiver)", confidence: 0.7 }
    ])
  });
  // MCP-ISSUE-052's rule, now reaching this lane: a large confident answer built on a guess is the
  // dangerous case, not an empty one.
  assert.notEqual(block.confidence, "high");
  assert.ok(block.knownGaps.some((g) => g.includes("NAME only")));
});
