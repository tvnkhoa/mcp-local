import assert from "node:assert/strict";
import test from "node:test";

import {
  createOwnerFileContext,
  declaredTypeFromSignature,
  resolveOwnerAt,
  type OwnerRepoIndex
} from "./ownerResolver.js";

/**
 * B-13 / MCP-ISSUE-043 — the owner prover.
 *
 * The defect these pin down: `findOwnerType` answered "which class does this code SIT IN", so the
 * three sites of one static method reported three different owners (each caller's own class) and
 * `requiredOwnerType:"Codec"` matched exactly one of them — the declaration. The regression test is
 * `three sites of one static member all resolve to the declaring type`: under the old scan that
 * assertion is impossible to satisfy, because two of the three sites are in other classes.
 *
 * Everything here is pure: source text + offset in, a verdict out. No database, no index run, no
 * server — the repo-level facts arrive through a stub `OwnerRepoIndex`.
 */

function repoIndex(types: string[] = [], members: Record<string, Record<string, string>> = {}): OwnerRepoIndex {
  const typeSet = new Set(types.map((x) => x.toLowerCase()));
  return {
    isTypeName: (name) => typeSet.has(name.toLowerCase()),
    memberDeclaredType: (ownerType, memberName) =>
      members[ownerType.toLowerCase()]?.[memberName.toLowerCase()] ?? null
  };
}

/** Resolve at the Nth occurrence (1-based) of `token` in `source`. */
function proveAt(
  source: string,
  token: string,
  occurrence: number,
  required: string[],
  index: OwnerRepoIndex = repoIndex(),
  filePath = "src/App/Sample.cs"
) {
  let offset = -1;
  for (let i = 0; i < occurrence; i += 1) {
    offset = source.indexOf(token, offset + 1);
    assert.notEqual(offset, -1, `token '${token}' occurrence ${occurrence} not found`);
  }
  const ctx = createOwnerFileContext(filePath, source, index);
  return resolveOwnerAt(ctx, offset, offset + token.length, required);
}

// ---------------------------------------------------------------------------
// The B-13 regression: one static member, three sites, one owner.
// ---------------------------------------------------------------------------

const THREE_SITES = `namespace App;

public class Codec
{
    public static string Normalize(string raw) => raw.Trim();

    public string Round(string raw) => Normalize(raw);
}

public class Notifier
{
    public string Send(string raw) => Codec.Normalize(raw);
}

public class Handler
{
    public string Handle(string raw)
    {
        return Codec.Normalize(raw);
    }
}
`;

test("all three sites of a static member resolve to the DECLARING type, not the enclosing class", () => {
  const index = repoIndex(["Codec", "Notifier", "Handler"]);

  // 1: the declaration inside Codec. 2: the implicit-this call in Codec.Round.
  const declaration = proveAt(THREE_SITES, "Normalize", 1, ["Codec"], index);
  assert.equal(declaration.verdict, "verified");
  assert.equal(declaration.ownerType, "Codec");
  assert.equal(declaration.rule, "declaration_site");

  // 3 and 4: `Codec.Normalize(raw)` from Notifier and from Handler — the two sites the old scan
  // attributed to 'Notifier' and 'Handler' and therefore rejected.
  for (const occurrence of [3, 4]) {
    const proof = proveAt(THREE_SITES, "Normalize", occurrence, ["Codec"], index);
    assert.equal(proof.verdict, "verified", `occurrence ${occurrence} verdict`);
    assert.equal(proof.ownerType, "Codec", `occurrence ${occurrence} owner`);
    assert.equal(proof.rule, "static_type_receiver", `occurrence ${occurrence} rule`);
  }
});

test("a static receiver that is NOT the required type is a proven mismatch, so it can be rejected", () => {
  const proof = proveAt(THREE_SITES, "Normalize", 3, ["OtherCodec"], repoIndex(["Codec", "OtherCodec"]));
  assert.equal(proof.verdict, "cross_type");
  assert.equal(proof.ownerType, "Codec");
  assert.equal(proof.rule, "static_type_receiver_mismatch");
});

test("a receiver that is neither in scope nor a declared type stays unprovable, never a wrong owner", () => {
  // No repo type named Codec → `Codec.Normalize` cannot be attributed. It must NOT come back as
  // 'Notifier' (the old scan's answer), because that would be rejected as a proven wrong owner.
  const proof = proveAt(THREE_SITES, "Normalize", 3, ["Codec"], repoIndex([]));
  assert.equal(proof.verdict, "unknown");
  assert.equal(proof.rule, "receiver_type_not_in_scope");
});

test("an implicit-this call inside the declaring type is attributed to that type", () => {
  const proof = proveAt(THREE_SITES, "Normalize", 2, ["Codec"], repoIndex(["Codec"]));
  assert.equal(proof.verdict, "verified");
  assert.equal(proof.ownerType, "Codec");
  assert.equal(proof.rule, "implicit_this");
});

// ---------------------------------------------------------------------------
// Instance receivers
// ---------------------------------------------------------------------------

const INSTANCE_RECEIVERS = `public class Runner
{
    private readonly Codec _codec = new Codec();

    public void Run(Codec injected)
    {
        var local = new Codec();
        local.Normalize("a");
        injected.Normalize("b");
        _codec.Normalize("c");
        this.Helper();
    }

    private void Helper() { }
}
`;

test("a local, a parameter and a field receiver all type from the scope map", () => {
  for (const occurrence of [1, 2, 3]) {
    const proof = proveAt(INSTANCE_RECEIVERS, "Normalize", occurrence, ["Codec"]);
    assert.equal(proof.verdict, "verified", `occurrence ${occurrence} verdict (${proof.rule})`);
    assert.equal(proof.ownerType, "Codec", `occurrence ${occurrence} owner`);
    assert.equal(proof.rule, "receiver_type_match", `occurrence ${occurrence} rule`);
  }
});

test("an instance receiver of a different type is a proven mismatch", () => {
  const proof = proveAt(INSTANCE_RECEIVERS, "Normalize", 1, ["Conversation"]);
  assert.equal(proof.verdict, "cross_type");
  assert.equal(proof.ownerType, "Codec");
  assert.equal(proof.rule, "receiver_type_mismatch");
});

test("`this.Member` resolves to the enclosing type", () => {
  const proof = proveAt(INSTANCE_RECEIVERS, "Helper", 1, ["Runner"]);
  assert.equal(proof.verdict, "verified");
  assert.equal(proof.ownerType, "Runner");
  assert.equal(proof.rule, "implicit_this");
});

test("`base.Member` resolves to the base type, not the derived one", () => {
  const source = `public class Sub : Codec, IThing
{
    public void Go() => base.Normalize("x");
}
`;
  const proof = proveAt(source, "Normalize", 1, ["Codec"]);
  assert.equal(proof.verdict, "verified");
  assert.equal(proof.ownerType, "Codec");
  assert.equal(proof.rule, "base_type_receiver");
});

// ---------------------------------------------------------------------------
// Object initializers
// ---------------------------------------------------------------------------

test("a bare member inside `new T { … }` is owned by T", () => {
  const source = `public class Builder
{
    public Conversation Make() => new Conversation { HandledBy = "ai" };
}
`;
  const proof = proveAt(source, "HandledBy", 1, ["Conversation"]);
  assert.equal(proof.verdict, "verified");
  assert.equal(proof.ownerType, "Conversation");
  assert.equal(proof.rule, "initializer_type_match");
});

test("an initializer for a different type is a proven mismatch", () => {
  const source = `public class Builder
{
    public Other Make() => new Other { HandledBy = "ai" };
}
`;
  const proof = proveAt(source, "HandledBy", 1, ["Conversation"]);
  assert.equal(proof.verdict, "cross_type");
  assert.equal(proof.ownerType, "Other");
  assert.equal(proof.rule, "initializer_type_mismatch");
});

// ---------------------------------------------------------------------------
// Two-hop receivers — MCP-ISSUE-043 Scenario B
// ---------------------------------------------------------------------------

const TWO_HOP = `public class Service
{
    public void Handle(Conversation conversation)
    {
        conversation.Assignment.HandledBy = "ai";
    }
}
`;

test("a two-hop receiver resolves through the member's declared type (Scenario B)", () => {
  const index = repoIndex(
    ["Conversation", "ConversationAssignmentState"],
    { conversation: { assignment: "ConversationAssignmentState" } }
  );
  const proof = proveAt(TWO_HOP, "HandledBy", 1, ["ConversationAssignmentState"], index);
  assert.equal(proof.verdict, "verified");
  assert.equal(proof.ownerType, "ConversationAssignmentState");
  assert.equal(proof.rule, "receiver_member_type");
});

test("a two-hop receiver resolving to a different type is a proven mismatch", () => {
  const index = repoIndex(
    ["Conversation", "ConversationAssignmentState"],
    { conversation: { assignment: "ConversationAssignmentState" } }
  );
  const proof = proveAt(TWO_HOP, "HandledBy", 1, ["Conversation"], index);
  assert.equal(proof.verdict, "cross_type");
  assert.equal(proof.ownerType, "ConversationAssignmentState");
  assert.equal(proof.rule, "receiver_member_type_mismatch");
});

test("a two-hop receiver whose member type is unknown stays unprovable", () => {
  const proof = proveAt(TWO_HOP, "HandledBy", 1, ["ConversationAssignmentState"], repoIndex(["Conversation"]));
  assert.equal(proof.verdict, "unknown");
  assert.equal(proof.rule, "receiver_path_unresolved");
});

test("a namespace-qualified static receiver resolves on its last segment", () => {
  const source = `public class Caller
{
    public string Go(string raw) => App.Text.Codec.Normalize(raw);
}
`;
  const proof = proveAt(source, "Normalize", 1, ["Codec"], repoIndex(["Codec"]));
  assert.equal(proof.verdict, "verified");
  assert.equal(proof.ownerType, "Codec");
  assert.equal(proof.rule, "qualified_type_receiver");
});

// ---------------------------------------------------------------------------
// Declarations, non-identifier spans, other languages
// ---------------------------------------------------------------------------

test("a field declaration is a declaration site owned by its enclosing type", () => {
  const proof = proveAt(INSTANCE_RECEIVERS, "_codec", 1, ["Runner"]);
  assert.equal(proof.verdict, "verified");
  assert.equal(proof.ownerType, "Runner");
  assert.equal(proof.rule, "declaration_site");
});

test("a receiver that is an expression result is unprovable rather than guessed", () => {
  const source = `public class Caller
{
    public void Go() => Build().Normalize("x");
    private Codec Build() => new Codec();
}
`;
  const proof = proveAt(source, "Normalize", 1, ["Codec"], repoIndex(["Codec"]));
  assert.equal(proof.verdict, "unknown");
  assert.equal(proof.rule, "receiver_not_identifier");
});

test("a match spanning something that is not a whole identifier is unprovable, with a scan hint", () => {
  // A regex-mode match can land anywhere. `ec.Norm` is a partial token across the dot.
  const proof = proveAt(THREE_SITES, "ec.Norm", 1, ["Codec"], repoIndex(["Codec"]));
  assert.equal(proof.verdict, "unknown");
  assert.equal(proof.rule, "site_not_an_identifier");
  // The hint keeps `hunk.ownerType` populated so the confidence formula does not change meaning.
  assert.equal(typeof proof.ownerType, "string");
});

test("a non-C# file keeps the historical text scan, labelled as a fallback, and still compares", () => {
  const source = `export class Codec {\n  normalize(raw: string) { return raw.trim(); }\n}\n`;
  const match = proveAt(source, "normalize", 1, ["Codec"], repoIndex(), "src/codec.ts");
  assert.equal(match.verdict, "verified");
  assert.equal(match.ownerType, "Codec");
  assert.equal(match.rule, "enclosing_type_fallback");

  // The guard still bites for non-C#: a mismatch is cross_type, exactly as before B-13.
  const mismatch = proveAt(source, "normalize", 1, ["Other"], repoIndex(), "src/codec.ts");
  assert.equal(mismatch.verdict, "cross_type");
  assert.equal(mismatch.ownerType, "Codec");
});

// ---------------------------------------------------------------------------
// Signature → declared type (the two-hop lookup's parser)
// ---------------------------------------------------------------------------

test("declaredTypeFromSignature reads the declared type past modifiers, attributes and generics", () => {
  assert.equal(
    declaredTypeFromSignature("public ConversationAssignmentState Assignment { get; set; }", "Assignment"),
    "ConversationAssignmentState"
  );
  assert.equal(declaredTypeFromSignature("private readonly ILogger _logger;", "_logger"), "ILogger");
  assert.equal(declaredTypeFromSignature("[JsonIgnore] public Codec Codec { get; }", "Codec"), "Codec");
  assert.equal(declaredTypeFromSignature("public List<Conversation> Items { get; }", "Items"), "List");
  assert.equal(declaredTypeFromSignature("public Conversation? Current { get; }", "Current"), "Conversation");
  assert.equal(declaredTypeFromSignature("public App.Model.Conversation Current { get; }", "Current"), "Conversation");
});

test("declaredTypeFromSignature refuses a shape it cannot read, rather than guessing a type", () => {
  // A guess here becomes a WRONG `verified`, which is the whole defect B-13 fixes.
  assert.equal(declaredTypeFromSignature("Assignment", "Assignment"), null);
  assert.equal(declaredTypeFromSignature("public Assignment { get; set; }", "Assignment"), null);
  assert.equal(declaredTypeFromSignature("public (int, int) Pair { get; }", "Pair"), null);
});
