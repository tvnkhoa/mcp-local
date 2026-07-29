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

console.log(results.join("\n"));
console.log(`\n  ${failures === 0 ? "PASS" : "FAIL"} — C# TYPE_REF positions (${failures} failing)`);
assert.equal(failures, 0, `${failures} TYPE_REF position(s) not emitted as expected`);
