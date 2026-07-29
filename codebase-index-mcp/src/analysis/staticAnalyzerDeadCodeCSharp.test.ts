import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFileContexts,
  getCSharpSuppressionReason,
  isLikelyEntryPoint,
  type DeadCodeFileContext,
  type DeadCodeRow
} from "./staticAnalyzerDeadCodeCSharp.js";

/**
 * The C# suppression policy decides which symbols `dead_code_scan` stays quiet about, and it was
 * effectively untested: the only harness touching the scan (`test:bus-edges`) asserts that a bus
 * consumer is *absent* from the candidate list — an assertion that would still pass if this policy
 * suppressed every row it was shown.
 *
 * These are possible only because S-41 lifted three closures out of `getDeadCodeCandidates`. As
 * closures over `fileContexts` they could not be reached without a database, an index run, and a
 * .NET fixture; as exported functions they are pure (row + contexts in, a reason out).
 *
 * Two properties are load-bearing and pinned below:
 *
 *  1. **First match wins.** The chain is a long ordered `if`, and the winning branch chooses which
 *     key appears in `suppressed.reasons`. Reordering it changes tool output without changing which
 *     symbols are suppressed, so a count-based test would not notice.
 *  2. **Per-file contexts stay separate.** The extraction replaced three inline default-context
 *     literals with an `emptyFileContext()` factory. Had it become a shared constant, one file's
 *     evidence would leak into every other file in the scan.
 */

function row(over: Partial<DeadCodeRow> = {}): DeadCodeRow {
  return {
    symbolId: "s1",
    name: "Thing",
    kind: "method",
    filePath: "src/App/Thing.cs",
    line: 1,
    signature: "public void Thing()",
    language: "csharp",
    incomingCalls: 0,
    incomingTypeRefs: 0,
    incomingImports: 0,
    incomingPublishes: 0,
    outgoingCalls: 0,
    fileIncomingUsages: 0,
    ...over
  };
}

const noContexts = new Map<string, DeadCodeFileContext>();

test("suppression is C#-only", () => {
  const ts = row({ language: "typescript", filePath: "src/endpoints/thing.ts" });
  assert.equal(getCSharpSuppressionReason(ts, noContexts), null);
  assert.equal(isLikelyEntryPoint({ ...ts, outgoingCalls: 9, name: "main" }, noContexts), false);

  // An unknown language must behave like a non-match, not throw on the null signature.
  assert.equal(getCSharpSuppressionReason(row({ language: null, signature: null }), noContexts), null);
});

test("the three reason keys are exactly the ones the tool reports", () => {
  // These strings are wire output: they become the keys of `suppressed.reasons`.
  assert.equal(
    getCSharpSuppressionReason(row({ filePath: "src/App/Interfaces/IThing.cs" }), noContexts),
    "heuristic_contract_declaration"
  );
  assert.equal(
    getCSharpSuppressionReason(
      row({ kind: "class", name: "PathHelper", signature: "public static class PathHelper", filePath: "src/App/Helpers/PathHelper.cs" }),
      noContexts
    ),
    "heuristic_helper_container"
  );
  assert.equal(
    getCSharpSuppressionReason(row({ filePath: "src/App/Endpoints/OrderEndpoints.cs" }), noContexts),
    "heuristic_runtime_or_convention_usage"
  );
});

test("KNOWN DEFECT (MCP-ISSUE-031): any i-prefixed filename reads as an interface file", () => {
  // `getCSharpSuppressionReason` lowercases the path before taking the filename, then tests
  // /^i[a-z].*\.cs$/ to spot an interface declaration. The intent is `IThing.cs`, but the casing is
  // already gone by then, so `ItemEndpoints.cs`, `IndexService.cs` and `InvoiceRepository.cs` all
  // match — every method in them is suppressed as a contract declaration, and `dead_code_scan`
  // under-reports on .NET repos.
  //
  // Pinned as-is rather than fixed: S-41 is a file split, and tightening this would change tool
  // output. The first assertion is the behaviour to change when MCP-ISSUE-031 is fixed; the second
  // is the behaviour that must survive the fix.
  assert.equal(
    getCSharpSuppressionReason(row({ filePath: "src/App/Services/ItemService.cs" }), noContexts),
    "heuristic_contract_declaration"
  );
  assert.equal(
    getCSharpSuppressionReason(row({ filePath: "src/App/Services/OrderService.cs" }), noContexts),
    null
  );
});

test("first match wins: an extension method in /interfaces/ is not a contract declaration", () => {
  // Both branches match this row. The extension-method check is first, so the reported reason is
  // runtime/convention — if the chain were reordered this would flip to a contract declaration.
  const both = row({
    filePath: "src/App/Interfaces/StringExtensions.cs",
    signature: "public static string Slugify(this string value)"
  });
  assert.equal(getCSharpSuppressionReason(both, noContexts), "heuristic_runtime_or_convention_usage");

  // Same row without `this` on the first parameter falls through to the /interfaces/ branch.
  assert.equal(
    getCSharpSuppressionReason({ ...both, signature: "public static string Slugify(string value)" }, noContexts),
    "heuristic_contract_declaration"
  );
});

test("a private validator helper is suppressed only when its file holds a validator class", () => {
  // This is the check that proves `fileContexts` is threaded through correctly: the row alone
  // carries no evidence, so a dropped argument would silently stop suppressing.
  const helper = row({ name: "BeAValidEmail", signature: "private bool BeAValidEmail(string v)" });
  assert.equal(getCSharpSuppressionReason(helper, noContexts), null);

  const contexts = buildFileContexts([
    row({ kind: "class", name: "CreateUserValidator", signature: "public class CreateUserValidator : AbstractValidator<CreateUser>" }),
    helper
  ]);
  assert.equal(getCSharpSuppressionReason(helper, contexts), "heuristic_runtime_or_convention_usage");
});

test("buildFileContexts keeps files independent", () => {
  const contexts = buildFileContexts([
    row({ kind: "class", name: "ThingValidator", filePath: "a.cs", signature: "public class ThingValidator : AbstractValidator<Thing>" }),
    row({ kind: "class", name: "AuditAttribute", filePath: "b.cs", signature: "public class AuditAttribute : Attribute" })
  ]);

  assert.equal(contexts.get("a.cs")?.hasValidatorClass, true);
  assert.equal(contexts.get("a.cs")?.hasAttributeClass, false, "b.cs evidence leaked into a.cs");
  assert.equal(contexts.get("b.cs")?.hasAttributeClass, true);
  assert.equal(contexts.get("b.cs")?.hasValidatorClass, false, "a.cs evidence leaked into b.cs");
});

test("buildFileContexts ignores non-C# and non-class-like rows", () => {
  const contexts = buildFileContexts([
    row({ kind: "method", name: "ThingValidator", filePath: "a.cs", signature: "public class ThingValidator : AbstractValidator<Thing>" }),
    row({ kind: "class", name: "ThingValidator", filePath: "b.ts", language: "typescript", signature: "public class ThingValidator : AbstractValidator<Thing>" })
  ]);

  assert.equal(contexts.size, 0);
});

test("isLikelyEntryPoint needs outgoing calls plus a name or path hint", () => {
  const handler = row({ name: "HandleAsync", filePath: "src/App/Handlers/CreateUser.cs", signature: "public async Task HandleAsync()" });

  // Below the outgoing-call floor, path and name hints do not matter.
  assert.equal(isLikelyEntryPoint({ ...handler, outgoingCalls: 1 }, noContexts), false);
  assert.equal(isLikelyEntryPoint({ ...handler, outgoingCalls: 2 }, noContexts), true);

  // A utility name costs a point, and neither name nor path hint remains.
  const util = row({ name: "ToDto", filePath: "src/App/Mapping/Mapper.cs", signature: "public Dto ToDto()", outgoingCalls: 4 });
  assert.equal(isLikelyEntryPoint(util, noContexts), false);
});
