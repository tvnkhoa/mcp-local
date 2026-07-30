/**
 * MCP-ISSUE-034 — every C# type position must produce a TYPE_REF edge.
 *
 * `emitTypeRefEdge` used to have exactly one call site in the whole extractor: the base class in a
 * `base_list`. So the graph's TYPE_REF relation recorded inheritance and nothing else — 148 edges and
 * 22 distinct target symbols across a 4442-symbol C# repo, leaving 99% of type declarations with no
 * incoming reference. `dead_code_scan` then reported live DTOs and records as dead: correct by its own
 * rule, over a relation that was almost empty.
 *
 * Per-position assertions on parsed source, not whole-repo edge counts. Counts cannot be used here:
 * MCP-ISSUE-032 means two identical index runs differ by ~1.4%, which is larger than what adding a
 * single position contributes — measuring this feature by re-indexing would read as noise.
 */

import assert from "node:assert";

import { extractGraphData } from "../../dist/extractors/treeSitterExtractor.js";

let failures = 0;
const results = [];

function check(label, source, expectPresent, expectAbsent = []) {
  const { edges } = extractGraphData({
    repoId: "r",
    filePath: "src/Thing.cs",
    language: "csharp",
    source
  });
  const typeRefs = new Set(
    edges.filter((e) => e.type === "TYPE_REF" && e.toId.startsWith("type:")).map((e) => e.toId.slice(5))
  );

  const missing = expectPresent.filter((n) => !typeRefs.has(n));
  const leaked = expectAbsent.filter((n) => typeRefs.has(n));

  if (missing.length === 0 && leaked.length === 0) {
    results.push(`  ok    ${label}`);
    return;
  }
  failures += 1;
  results.push(`  FAIL  ${label}`);
  if (missing.length) results.push(`          missing: ${missing.join(", ")}`);
  if (leaked.length) results.push(`          unwanted: ${leaked.join(", ")}`);
  results.push(`          got: ${[...typeRefs].sort().join(", ") || "(none)"}`);
}

// The position that already worked — pinned so the rewrite did not lose it.
check(
  "base class",
  `public class Impl : BaseService {}`,
  ["BaseService"]
);

// The generic arguments of a base type. `IRequestHandler<CreateOrder, Result>` used to reference only
// the interface, so the command and result records looked unreferenced.
check(
  "base-list generic arguments",
  `public class Handler : IRequestHandler<CreateOrderCommand, OrderResult> {}`,
  ["IRequestHandler", "CreateOrderCommand", "OrderResult"]
);

check(
  "method return type and parameters",
  `public class S {
     public OrderDto Get(CustomerRef who, PagingArgs paging) { return null; }
   }`,
  ["OrderDto", "CustomerRef", "PagingArgs"]
);

// Nested generics: the innermost argument is usually the one that matters.
check(
  "nested generic return type",
  `public class S {
     public Task<List<OrderDto>> All() { return null; }
   }`,
  ["Task", "List", "OrderDto"]
);

check(
  "property type",
  `public class S {
     public InboxCard Card { get; set; }
   }`,
  ["InboxCard"]
);

// Where a .NET class names its injected dependencies. Fields are not emitted as symbols, so this
// position was invisible until the edge was attributed to the enclosing type.
check(
  "field type",
  `public class S {
     private readonly IOrderService _orders;
   }`,
  ["IOrderService"]
);

check(
  "constructor parameter type",
  `public class S {
     public S(IOrderService orders, ILogger<S> log) {}
   }`,
  ["IOrderService", "ILogger"]
);

check(
  "record positional parameters",
  `public record CreateOrder(OrderDto Order, CustomerRef Customer);`,
  ["OrderDto", "CustomerRef"]
);

check(
  "nullable and array types",
  `public class S {
     public OrderDto? Maybe { get; set; }
     public CustomerRef[] Many { get; set; }
   }`,
  ["OrderDto", "CustomerRef"]
);

// Builtins would add thousands of edges that can never resolve to a symbol in any repo.
check(
  "builtin types are not emitted",
  `public class S {
     public string Name { get; set; }
     public int Count { get; set; }
     public bool Ok { get; set; }
     public void Do(double d, decimal m) {}
   }`,
  [],
  ["string", "int", "bool", "void", "double", "decimal"]
);

// A qualified name must contribute the type only — not its namespace segments.
check(
  "namespace segments are not emitted",
  `public class S {
     public System.Threading.Tasks.Task<Application.Orders.OrderDto> Go() { return null; }
   }`,
  ["Task", "OrderDto"],
  ["System", "Threading", "Tasks", "Application", "Orders"]
);

// ── Positions inside method bodies (MCP-ISSUE-034, second half) ────────────────────────────────
//
// Signature positions cover where a type is DECLARED. These cover where it is USED — a DTO that is only
// ever constructed, or a helper only ever reached through a static call, has no signature mention
// anywhere and so had no incoming TYPE_REF at all.

check(
  "object creation",
  `public class S { public void M() { var a = new Order(); var b = new Repo<Invoice>(); } }`,
  ["Order", "Repo", "Invoice"]
);

check(
  "generic arguments on an invocation, without the method name",
  `public class S { public void M(string s) { JsonSerializer.Deserialize<OrderDto>(s); } }`,
  ["OrderDto"],
  // `Deserialize` is a method; emitting it as a type would make every generic call a bogus type
  // reference. `JsonSerializer` is a BCL static receiver and is filtered.
  ["Deserialize", "JsonSerializer"]
);

check(
  "static member access on a repo type",
  `public class S { public void M() { OrderHelper.Compute(); var x = OrderConstants.Max; } }`,
  ["OrderHelper", "OrderConstants"]
);

check(
  "BCL static receivers are not emitted",
  `public class S { public void M() { Console.WriteLine(Math.Abs(-1)); Log.Information("x"); var g = Guid.NewGuid(); } }`,
  [],
  ["Console", "Math", "Log", "Guid"]
);

check(
  "typeof, cast, as, and both is-pattern forms",
  `public class S {
     public void M(object o) {
       var t = typeof(Order);
       var c = (Invoice)o;
       var d = o as Vendor;
       if (o is Customer bound) { }
       if (o is Supplier) { }
     }
   }`,
  ["Order", "Invoice", "Vendor", "Customer", "Supplier"]
);

check(
  "catch clause, local declaration, generic constraint, attribute",
  `[Authorize]
   public class S<T> where T : IAggregate {
     public void M() { Order local = null; try { } catch (DomainException e) { } }
   }`,
  ["Authorize", "IAggregate", "Order", "DomainException"]
);

check(
  "var does not emit a type",
  `public class S { public void M() { var x = 1; } }`,
  [],
  ["var", "x"]
);

// Method groups are CALLS, not TYPE_REF, so they need their own assertion.
{
  const { edges } = extractGraphData({
    repoId: "r",
    filePath: "src/Thing.cs",
    language: "csharp",
    source: `public class S {
       public void Configure(RuleBuilder b) { b.Must(BeValidBase64); b.Must(x => x > 0); }
       private bool BeValidBase64(string s) => true;
     }`
  });
  const groupEdges = edges.filter((e) => e.type === "CALLS" && e.reason === "method group reference");
  // Exactly one: `BeValidBase64` is a method declared in this file; the lambda is not an identifier.
  if (groupEdges.length === 1) {
    results.push("  ok    method group passed as a delegate emits a CALLS edge");
  } else {
    failures += 1;
    results.push(`  FAIL  method group passed as a delegate emits a CALLS edge`);
    results.push(`          expected 1 'method group reference' edge, got ${groupEdges.length}`);
  }

  // The qualified form — how it is actually written when the helper lives in another class, and the case
  // the first pass missed: three real EmailReplyAttachmentRules helpers stayed "dead" because every call
  // site is in a different file.
  const qualified = extractGraphData({
    repoId: "r",
    filePath: "src/Validator.cs",
    language: "csharp",
    source: `public class V {
       public V() {
         RuleFor(x => x.Data).Must(EmailReplyAttachmentRules.BeValidBase64);
         RuleFor(x => x.Data).MaximumLength(EmailReplyAttachmentRules.MaxChars);
       }
     }`
  }).edges.filter((e) => e.reason === "method group reference");

  // Both lines have the same AST shape — a PascalCase static member passed as an argument — so both emit.
  // What keeps that safe is the token FORM: qualified only, never a bare `callee:MaxChars`, which
  // dead_code_scan would count as a reference even unresolved and use to mark a same-named method live.
  const tokens = qualified.map((e) => e.toId).sort();
  if (tokens.length === 2 && tokens.every((t) => t.startsWith("callee:EmailReplyAttachmentRules."))) {
    results.push("  ok    a qualified static method group emits a qualified callee token");
  } else {
    failures += 1;
    results.push(`  FAIL  a qualified static method group emits a qualified callee token`);
    results.push(`          got: ${tokens.join(", ") || "(none)"}`);
  }
  const bare = qualified.filter((e) => !e.toId.includes("."));
  if (bare.length === 0) {
    results.push("  ok    no bare callee token is emitted for a qualified member (a const cannot fake a method)");
  } else {
    failures += 1;
    results.push(`  FAIL  emitted a bare callee token: ${bare.map((e) => e.toId).join(", ")}`);
  }

  // A lowercase receiver is a local or field, so `x.SomeProperty` is a value, not a method group.
  const lower = extractGraphData({
    repoId: "r",
    filePath: "src/Validator.cs",
    language: "csharp",
    source: `public class V { public void M(Thing x) { Send(x.Payload); } }`
  }).edges.filter((e) => e.reason === "method group reference");
  if (lower.length === 0) {
    results.push("  ok    a lowercase receiver is not treated as a static method group");
  } else {
    failures += 1;
    results.push(`  FAIL  a lowercase receiver was treated as a method group (${lower.length} edges)`);
  }

  // The guard that keeps this from firing on ordinary variable arguments.
  const { edges: noneExpected } = extractGraphData({
    repoId: "r",
    filePath: "src/Thing.cs",
    language: "csharp",
    source: `public class S { public void M(string payload) { Send(payload); } }`
  });
  const spurious = noneExpected.filter((e) => e.reason === "method group reference");
  if (spurious.length === 0) {
    results.push("  ok    a plain variable argument is not treated as a method group");
  } else {
    failures += 1;
    results.push(`  FAIL  a plain variable argument was treated as a method group (${spurious.length} edges)`);
  }
}

console.log(results.join("\n"));
console.log(`\n  ${failures === 0 ? "PASS" : "FAIL"} — C# TYPE_REF positions (${failures} failing)`);
assert.equal(failures, 0, `${failures} TYPE_REF position(s) not emitted as expected`);
