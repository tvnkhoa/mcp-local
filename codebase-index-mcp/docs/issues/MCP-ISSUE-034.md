## MCP-ISSUE-034 — C# `TYPE_REF` edges are almost never produced, so every C# type looks dead

- **Status:** **FIXED** — signature positions 2026-07-29 (`src/extractors/csharpSymbols.ts`,
  `src/extractors/extractorEdges.ts`), body positions 2026-07-30 (`src/extractors/csharpTypeRefs.ts`);
  see the update at the end of this entry. Found immediately after MCP-ISSUE-033 made `dead_code_scan`
  return results for the first time — the tool became usable and its first real output was mostly wrong.
- **Scenario:** `dead_code_scan` on a .NET repo. Every candidate it reports is a type declaration
  (`class` / `record` / `record struct`), and the obvious ones are live: `ValidationException`,
  `ForbiddenAccessException`, `RequestContext`, `N8nChatDecisionRequest`, and
  `NormalizedMessageContent` — which is the return type of the very file it is declared in.
- **Measured on `wec.communication-hub`** (4442 symbols, 35 887 edges):

  | edge type | distinct symbols that are its TARGET |
  |---|---|
  | CALLS | 1751 |
  | PROPERTY_REF | 1622 |
  | IMPORTS | 79 |
  | IMPLEMENTS | 58 |
  | **TYPE_REF** | **22** |

  | | count |
  |---|---|
  | C#-type-like declarations (`class`/`record`/`record struct`/`struct`/`interface`/`type`) | 792 |
  | ...with **zero** incoming `TYPE_REF` edge | **784 (99.0%)** |

- **Root cause (not yet confirmed):** the graph barely contains resolved C# type references at all —
  22 target symbols across a whole repo is not a suppression problem or a scan problem, it is an
  extraction/resolution problem. `dead_code_scan`'s rule ("no incoming CALLS/TYPE_REF/IMPORTS") is
  correct given the edges it is shown; the edges are missing. Whether the loss is at extraction
  (`treeSitterExtractor` not emitting `type:` placeholders for declarations, fields, parameters and
  return types) or at resolution (`resolveTypeRefEdges` not matching them) is the next question, and
  the `TYPE_REF` totals are small enough — 145 to 149 across runs — to inspect exhaustively.
- **Relationship to MCP-ISSUE-032:** `TYPE_REF` is one of the edge types that varies between identical
  runs there (145/146/147/148/149). Scarce *and* nondeterministic is a consistent picture: C# type
  resolution is barely functioning, so tiny differences in what happens to resolve move the total by a
  few percent.
- **Impact:** `dead_code_scan` is mechanically working but its **type-level** results on C# are not
  trustworthy — a reported type means "no TYPE_REF edge exists", which is true of 99% of types. Its
  method-level results are better founded, since `CALLS` coverage is real (1751 targets). Also affects
  anything else reading `TYPE_REF`: `find_impact_files` view `"surface"` (whose 0.75-confidence rows
  are TYPE_REF-based), and `get_change_context` blast radius for types.
- **Workaround:** treat a reported `class`/`record`/`struct` candidate as unproven. Cross-check with
  `search_regex` on the type name, or `find_impact_files`. Method/function candidates are the ones
  worth acting on.
- **Do not "fix" by dropping TYPE_REF from the scan rule.** That would hide the missing edges behind a
  narrower query and make the graph's real gap invisible.

### Root cause (confirmed) and fix

`emitTypeRefEdge` had **exactly one call site in the entire extractor** — the base class inside a
`base_list` in `csharpSymbols.ts`. Every other type position emitted nothing. Resolution was not at
fault: of the 148 edges that existed, 110 were unresolved `type:` tokens and all of them were
framework base types (`DbContext`, `BackgroundService`, `AbstractValidator`, `Exception`, `Migration`)
that legitimately have no symbol in the repo.

Added `emitTypeRefEdgesFromTypeNode`, which walks a type expression per node kind and emits one edge
per name mentioned, including nested generic arguments — `Task<List<OrderDto>>` yields `Task`, `List`
and `OrderDto`. Walking generics is the point: a DTO's only reference is very often a generic argument
on a return type. Handled per node kind rather than by collecting descendant identifiers, so a
`qualified_name` contributes the type and not its namespace segments. C# keyword types are excluded —
`string` and `int` would add thousands of edges that can never resolve in any repo.

Wired into: method return types and parameters, property types, constructor parameters, field and
event-field types (attributed to the enclosing type, since fields are not emitted as symbols), record
and primary-constructor positional parameters, and the generic arguments of a base type — which the
old `base_list` path discarded by stripping `<...>`, so `IRequestHandler<CreateOrderCommand, Result>`
referenced only the interface.

**Two field names were wrong and only a per-position test caught them.** A `method_declaration`'s
return type is the **`returns`** field, not `type` — reading `type` returns null, so return types
silently emitted nothing while parameters worked. And a record's positional `parameter_list` carries
**no field name at all**, so `childForFieldName("parameters")` was null for exactly the CQRS shape this
was meant to fix. Both were found by dumping the grammar's fields after the test failed, not by
reading the code.

### Measured (`wec.communication-hub`, 475 files, 4411 symbols)

| | before | after |
|---|---|---|
| TYPE_REF edges | 148 | **4885** |
| distinct TYPE_REF target symbols | 22 | **576** |
| type declarations with no incoming TYPE_REF | 784 / 792 (99.0%) | **479 / 794 (60.3%)** |

Of the 479 still unreferenced, **248 are under `Migrations/` or `Tests/`** — EF migrations and test
classes are discovered by reflection and genuinely have no code reference, which is why
`dead_code_scan` already suppresses them under `heuristic_runtime_or_convention_usage`.

### Update 2026-07-30 — body positions added, entry closed

The positions deferred above were each expected to be "a smaller increment". Probing them first showed
that was wrong: **eight** distinct positions emitted nothing at all, not four, and together they were
worth more than everything already covered.

Added in `src/extractors/csharpTypeRefs.ts` (its own module, to keep `csharpSymbols.ts` under the file
cap): object creation, generic arguments on invocations, static member access, `typeof`, casts,
`as`, both `is`-pattern forms, `catch` declarations, local variable declarations, generic constraints,
and attributes. Grammar node types and field names were read off a live parse rather than assumed —
`as` has `left`/`right` and no `type` field, and `o is Customer` without a binding is a
`constant_pattern`, not the `declaration_pattern` that `o is Customer c` produces.

Two judgment calls, both stated rather than hidden:

- **Static member access is filtered against a BCL receiver list.** `OrderHelper.Compute()` is a real
  reference to a repo type — and `dead_code_scan` could not see it, because the existing lane emits
  `callee:OrderHelper.Compute` while the scan tests `to_id = 'callee:' || name`, which never matches the
  dotted form. But `Console.WriteLine` and `Log.Information` are not references to anything indexable,
  and unresolvable TYPE_REF rows have a measured cost — they are the ones that fall through to the
  cross-repo and vector fallbacks. So ~60 BCL statics are excluded by name.
- **Method groups emit CALLS, not TYPE_REF** (`b.Must(BeValidBase64)`). The method really is invoked, by
  the validator, but nothing names it in an `invocation_expression`. Restricted to a bare identifier
  matching a method declared in the SAME FILE: a bare identifier argument is usually a variable, and a
  spurious CALLS edge is worse than a missing one because it makes a dead symbol look live.

| | signature positions only | + body positions |
|---|---|---|
| TYPE_REF edges | 4949 | **14377** |
| resolved to a real symbol | — | 7725 (603 distinct targets) |
| unresolved `type:` tokens | — | 6652 (framework types, expected) |
| raw dead-code candidates | 1568 | **1387** |
| of which class/record/struct | 345 | **180 (−48%)** |
| `type_resolve_ms` | 10723 | 12021 (+12%) |

The 48% drop in falsely-dead type declarations is the point of the whole issue. The resolve cost stayed
nearly flat only because the per-name memoization added earlier absorbed it; without that, 2.9× the rows
would have gone through the expensive fallback path.

Determinism was re-verified after the change, since these are new extraction passes: three full runs,
all nine edge types identical.

Covered by `test:csharp-type-refs`, extended from 11 to 19 cases — including two negative ones (BCL
receivers must NOT emit, and a plain variable argument must not be read as a method group).

**Do not measure any of this by re-indexing and comparing edge totals.** MCP-ISSUE-032 means two
identical runs differ by ~1.4%, which is larger than what a single new position contributes — adding
record positional parameters showed a *negative* total delta on one run purely as noise. The
per-position harness (`scripts/test/test-csharp-type-refs.mjs`, 11 cases) is deterministic and is what
proved each position works.

### Cost — and the 21× regression it first caused

The initial measurement of `typeResolveMs` (19798, from a single-repo temp DB) was too optimistic. On
the **real** 319 MB central DB holding seven repos, the first full re-index reported
**`typeResolveMs: 111950`** and `resolvePhaseMs: 133078` — the index run exceeded the 120s tool timeout
and had to finish in the background. A 21× regression against the 5214 it replaced.

Cause: in `resolveTypeRefEdges`, every row that fails the primary name match falls through to two
**per-row** fallbacks — a cross-repo provider lookup and a **vector similarity search**. Raising
unresolved TYPE_REF rows from 110 to ~3200 multiplied that path by 29, and the rows that reach it are
overwhelmingly framework types (`Task`, `CancellationToken`, `ILogger`, `IServiceCollection`) which can
never resolve — so they *always* take the expensive branch, and they are also the names that repeat
most.

Both fallbacks depend only on the type name, so they are now memoized per name (a few hundred distinct
names against a few thousand rows). The primary `pickBestNamedCandidate` match is deliberately **not**
cached: it takes `row.fromFile` to prefer a same-file declaration, so it is genuinely per-row.

| | before -034 | after -034 | after memoization |
|---|---|---|---|
| `typeResolveMs` | 5214 | 111950 | **11527** |
| `resolvePhaseMs` | 28354 | 133078 | **31794** |
| run completes inline | yes | no (>120s) | yes (6.9s elapsed) |

2.2× the original resolve cost for 33× the edges is the honest trade. It lands on the same resolver
queries as MCP-ISSUE-032's `ORDER BY` work, so a performance pass should treat them together.

### What the fix visibly changed in `dead_code_scan`

Re-indexed and re-scanned the same repo. Gone from the candidate list — these were the false positives:
`RequestContext`, `NotificationLabel`, `ComposeResult`, `ParseResult`, `ReplyTarget`,
`CustomerSuggestCacheEntry`, `ErrorCategory`, `N8nChatDecisionRequest`, `N8nChatDecisionResponse`,
`N8nCustomerProfileSnapshot`, `N8nOutboundMemoryEntry`. Suppressed rose 87 → 171, and the candidate list
now contains **methods** rather than only type declarations.

The false positives that remain map precisely onto the positions listed above as uncovered, which is
the useful part — it says what to do next:

| still reported | why | uncovered position |
|---|---|---|
| `ValidationException`, `ForbiddenAccessException` | only ever `throw new ValidationException(...)` | object creation `new X()` |
| `N8nApiEnvelope` | only a deserialization type argument | generic args on method invocations |
| `AuditPayloadSerializer`, `CrossChannelReplyHelpers` | reached by static call on the type name | static member access |
| `BeValidBase64`, `BeAllowedReviewUrl` | FluentValidation `.Must(BeValidBase64)` — a method group, never invoked | method-group reference |

`new X()` and invocation generic arguments are the two with the best ratio of remaining false positives
to effort.

---

