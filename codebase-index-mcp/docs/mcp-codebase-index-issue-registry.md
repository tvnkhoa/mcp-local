# MCP Codebase-Index — Issue Registry (server-side bugs)

Bug/enhancement reports for the `codebase-index-mcp` server, raised from consuming repos (e.g.
`wec.communication-hub`). Each entry: Scenario · Tool/query attempted · Expected vs actual · Impact ·
Workaround · Enhancement proposal. Filed here so the MCP server team can triage and fix at the source.

> Note: consumer repos keep their own *fallback log* (when they drop to Grep/Read) separately; this
> file tracks defects/limitations of the MCP server itself.

---

## MCP-ISSUE-032 — an index run is not reproducible: edge counts vary between identical runs

- **Status:** **CLOSED** 2026-07-30. All nine edge types reproduce exactly across three full runs, with
  vectors on and off. Fixed in two stages — extraction node identity on 2026-07-29
  (`src/extractors/extractorEdges.ts` +3 files), then a fifth node-identity site plus nine unordered
  reads on 2026-07-30; see the two update sections at the bottom. Found while validating the S-41
  `indexPipeline` split; pre-existing and unrelated to that change.
- **Scenario:** index the same repository twice, same build, same input, nothing changed on disk.
- **Evidence:** on `wec.communication-hub` (521 files), two runs of the **same** build:

  | | run 1 | run 2 | delta |
  |---|---|---|---|
  | symbols | 4457 | 4457 | 0 |
  | CALLS / IMPORTS / PROPERTY_WRITE / DEPENDS_ON / PUBLISHES | — | — | 0 |
  | PROPERTY_REF | 10895 | 11397 | **+502** |
  | IMPLEMENTS | 308 | 300 | −8 |
  | CONSUMES | 58 | 60 | +2 |
  | TYPE_REF | 154 | 156 | +2 |

  Total `edgesUpserted` moved 34921 → 35419 (1.4%). Reproduced with `parseWorkers: 2` **and**
  `parseWorkers: 0`, so it is not worker-lane concurrency.
- **Root cause (confirmed for the first half):** `glob("**/*")` in the scan phase returns the same
  1422 paths in a **different order** on each call — verified directly over three consecutive
  calls, first divergence at index 11. Nothing sorts the result before it becomes the processing
  order.
- **Root cause (hypothesis for the second half, NOT verified):** the edge types that move are the
  ones needing a type resolved from elsewhere in the repo, while the per-file, order-independent
  ones (symbols, CALLS, IMPORTS, PROPERTY_WRITE) are stable. That is consistent with C# type/DI
  resolution seeing a different set of already-indexed files depending on order. Confirming this
  needs a run where the file order is fixed and only that varies — not yet done.
- **Impact:** `health_check` edge counts differ between identical runs, so a change in them is not
  evidence of a change in the code. Any test asserting an exact edge total on a C# repo is
  latently flaky. It also means a before/after edge count cannot validate a refactor — which is how
  this was found: the first comparison appeared to show a 237-edge regression that turned out to be
  noise, and only a same-build control run distinguished the two.
- **Workaround:** compare symbol counts, not edge counts. For edges, run the same build twice to
  establish the noise band before reading any delta as signal.
- **Update 2026-07-29 — the proposed fix was attempted and is NOT sufficient. Root cause relocated.**

  The sort landed (`indexing/fileScan.ts` now `.sort()`s the glob, plain UTF-16 order rather than
  `localeCompare`, so it is platform- and locale-stable). It did **not** make runs reproducible.
  Nine runs on `wec.communication-hub` (475 files), same build:

  | | sorted ×2 | workers off ×2 | + ORDER BY ×3 |
  |---|---|---|---|
  | symbolsUpserted | 4411 / 4411 | 4411 / 4411 | 4411 / 4411 / 4411 |
  | edgesUpserted | 35167 / 35566 | 35379 / 35579 | 35552 / 35765 / 35586 |

  Three things are now ruled out, each by measurement rather than reasoning:

  1. **Glob order** — sorted runs still vary.
  2. **Worker concurrency** — `CODEBASE_INDEX_PARSE_WORKERS=0` genuinely disables the pool
     (`parseWorkers > 0 ? new ExtractionWorkerPool(...) : null`), and single-threaded runs still vary.
  3. **Unordered `LIMIT` in the resolvers** — six queries in `src/graph/` had a `LIMIT` with no
     `ORDER BY`, so they sampled unresolved rows arbitrarily. Real latent bug, **fixed** (see below),
     but not this one: variance survives the fix.

- **Root cause (relocated, confirmed):** the divergence happens in the **extraction/write phase**, not
  in resolution. Verbose logs from two runs, normalized for timing, differ at the same batch:

  ```
  [index-write] batch=5/8 files=176 subtx=9 symbols=1316 edges=6377   <- run 1
  [index-write] batch=5/8 files=176 subtx=9 symbols=1316 edges=6480   <- run 2
  ```

  Identical batch composition, identical symbol count, **103 more edges**. Since the scan is now
  sorted and the read loop preserves order (`Promise.allSettled` over fixed chunks, results pushed in
  input order), the file processing order is deterministic — so the nondeterminism is *inside*
  extracting one file's edges. The most likely remaining mechanism is an extraction-time DB lookup
  that resolves a type/member name with a `LIMIT` and no `ORDER BY`, returning an arbitrary candidate:
  there are ~175 such candidate sites across `src/store/` and `src/search/`. **Not yet confirmed to
  that line**, and auditing 175 queries is its own change — adding `ORDER BY` blindly would broaden
  tool-output changes and risk sort costs on the hot path.

- **Why the edge-type split now makes sense:** the stable types (`PROPERTY_WRITE`, `IMPORTS`,
  `DEPENDS_ON`) are derived purely from the one file being parsed. The varying ones (`CALLS`,
  `PROPERTY_REF`, `TYPE_REF`, `IMPLEMENTS`, `CONSUMES`, `PUBLISHES`) all need a name resolved against
  symbols from elsewhere. The original note guessed this was *post-hoc* cross-file resolution; the
  logs show it happens during extraction.

- **What landed:**
  - `indexing/fileScan.ts` — glob result sorted. Independently worth keeping: when `maxFiles`
    truncates a scan, *which* files get indexed was previously arbitrary.
  - Six `ORDER BY` clauses in `src/graph/` — `edgeResolverCalls.ts`, `edgeResolverImports.ts`,
    `edgeResolverRefs.ts` (×2), `edgeResolverShared.ts` (the hard-coded `limit 5000`), and
    `interfaceSiblings.ts` (before `IMPLEMENTOR_CAP`, so which implementors survive the cap is no
    longer arbitrary).
  - 30/30 harnesses pass; `contracts:check` 4/4 — no schema change.

### Root cause, third attempt — and this one is it: `===` on tree-sitter nodes

Neither the glob order, nor worker concurrency, nor the unordered `LIMIT`s. Four sites compared
tree-sitter nodes by **JavaScript object identity**:

```js
if (fn === node || fn?.descendantsOfType(node.type).some(d => d === node))   // extractorEdges.ts
return leftNode === node;                                                    // csharpPropertyEdges.ts ×2
if (child === node) break;                                                   // csharpRoutes.ts
```

Every `.parent`, `.childForFieldName()` and `.descendantsOfType()` access mints a **new** JS wrapper
around the same underlying native node. The binding keeps a *weak* cache of wrappers, so `===` holds
most of the time and stops holding once that cache is pruned — which makes the comparison a function of
**garbage collection**, not of the syntax tree. Fixed by comparing `node.id`, a stable native identity
(`node.equals()` does not exist in this binding version).

How it was isolated, after two wrong root causes:

1. `extractGraphData` is a pure function, so it was called three times on each of 60 real C# files.
   Two files varied — proving the variance was inside extraction, not the write path.
2. Three calls in one process gave **79 / 77 / 70** edges, decreasing monotonically; three *fresh
   processes* gave **82 / 82 / 80**. Monotonic decay under accumulating heap pressure.
3. `node --expose-gc` with a forced collection between calls collapsed it immediately and repeatably:
   **82, then 66 forever**. That confirmed GC and ruled out input, ordering and JIT warm-up.
4. Diffing the edge sets showed all 14 lost edges were method invocations — `Regex.IsMatch`,
   `string.Split`, `LoadHtml`, `ToString` — i.e. `isAncestorInvocation` misclassifying calls as property
   references. `CALLS` was 45 in every run, which is why symbol counts never moved.

**It was also a correctness bug, not only a reproducibility one.** The pre-fix run emitted *spurious*
PROPERTY_REF edges for method calls; the stable post-fix value is the lower, correct one. So the graph
was wrong in a way that made `find_impact_files` and property-reference queries report calls as
property reads.

| | before | after |
|---|---|---|
| same file, 3 calls, GC forced | 82 / 66 / 66 | **66 / 66 / 66** |
| 60-file purity sweep | 2 files unstable | **all deterministic** |
| PROPERTY_REF over 3 full index runs | 10564 / 10951 / 11162 | **9168 / 9168 / 9168** |

Covered by `scripts/test/test-node-identity.mjs` (`test:node-identity`), asserted behaviourally — a
method invocation must never appear as a property reference — rather than by forcing GC, since a test
that depends on collection timing fails for the wrong reasons.

### Update 2026-07-30 — CLOSED. All nine edge types are now reproducible.

The residual was **not** the vector fallback. That hypothesis was tested and refuted, then the real
causes were found: one more `===` on tree-sitter nodes, plus a family of `LIMIT`/first-row-wins reads
with no total order.

**The vector hypothesis, refuted.** `CODEBASE_INDEX_VECTOR_ENABLED` was added specifically to run the
control (see MCP-ISSUE-035, which the attempt uncovered). With vectors off entirely, the same four types
varied by the same magnitude — so vectors were never the cause:

| | vectors on | vectors off |
|---|---|---|
| CALLS | 14664 / 14654 / 14784 | 14639 / 14797 / 14690 |
| TYPE_REF | 4880 / 4894 / 4893 | 4882 / 4907 / 4893 |
| IMPLEMENTS | 281 / 291 / 293 | 280 / 302 / 292 |

**Cause 1 — ordering.** Diffing edge *rows* rather than counts showed the drift concentrated in
`reason='interface-dispatch'` (99 of 120 rows unique to one run). Nine reads decided an outcome without
a total order, each in a place where the choice was then treated as a ranking:

- `edgeResolverCalls.ts` — `implementorFilesByIfaceId` is capped by `MAX_INTERFACE_DISPATCH_FANOUT` at
  the point of use, so an unordered source query meant an arbitrary subset survived the cap.
- `edgeResolverShared.ts` — `buildNamedCandidateMap` feeds `pickBestNamedCandidate`, which keeps the
  first candidate at the minimum score. Same-named types in different files tie, so list order picked the
  winner. This one map serves CALLS, TYPE_REF and PROPERTY_REF, which is why a single missing `ORDER BY`
  surfaced as drift across three edge types.
- `edgeResolverContracts.ts` — four unordered reads plus two `if (!map.has(name))` first-row-wins
  lookups, and `consumers[0]` taken from a `Set` whose order came from an unordered query. `consumers[0]`
  is privileged: it UPDATEs the existing edge while the rest are INSERTed, so it decides edge identity.
- `interfaceSiblings.ts` — `limit 10` and three `limit 1` name lookups (C# overloads make the latter
  genuinely multi-row).
- `crossRepoStore.ts` — `order by s.repo_id limit 1`, not a total order when a provider repo declares the
  same type name in several files.

`pickBestNamedCandidate` now also breaks ties on `symbolId` itself, so its result is a property of its
arguments rather than of their arrangement — ordering every caller works until the next caller forgets.

This took the drift from 120/107 rows down to 26/80, but not to zero.

**Cause 2 — the fifth `===`, and the worst of them.** `csharpSymbols.ts` had
`if (baseList.parent !== node) continue;`. Missed in the first sweep because that pass searched for
`=== node`, not `.parent !== node`. When the wrapper identity misfired, the guard skipped the class
**entirely** — no IMPLEMENTS edge, no base-list TYPE_REF. Six extractions of one unchanged real file in
one process gave **0, 0, 6, 6, 0, 6** IMPLEMENTS edges.

That explains why the drift looked correlated across five edge types and resisted every ordering fix:
IMPLEMENTS seeds interface-dispatch CALLS and contract CONSUMES/PUBLISHES resolution, so one flipped
comparison moved all of them together.

**Result — three full runs, `wec.communication-hub`, both vector settings:**

| edge type | before (3 runs) | after (3 runs) |
|---|---|---|
| CALLS | 14664 / 14654 / 14784 | **14591 / 14591 / 14591** |
| TYPE_REF | 4880 / 4894 / 4893 | **4949 / 4949 / 4949** |
| IMPLEMENTS | 281 / 291 / 293 | **314 / 314 / 314** |
| CONSUMES | 54 / 55 / 49 | **60 / 60 / 60** |
| PUBLISHES | 28 / 28 / 25 | **28 / 28 / 28** |

Counts went **up**: classes that were being silently skipped now contribute their edges. As with the
first half of this issue, the reproducibility bug was also a correctness bug.

Covered by `test:node-identity`, extended with a multi-class base-list case — a single class could not
reproduce it, since the wrapper cache is only pruned once there is enough churn to prune.

---

## MCP-ISSUE-037 — abstract/virtual base-class members have no dispatch fan-out, so every override looks dead

- **Status:** **OPEN**, filed 2026-07-30. Not fixed: it needs a new edge semantic, which is a design
  decision rather than a repair. Found while verifying MCP-ISSUE-036 — after two false-positive causes were
  removed, this is what the remaining `dead_code_scan` candidates turned out to be.
- **Scenario:** a template-method base class. `SentMessageConsumerBase<TContract>` declares
  `protected abstract SentMessageInfo GetMessageInfo(TContract)` and calls it; `AutomationSentConsumer` and
  `CampaignSentConsumer` each `override` it.
- **Evidence:**

  | symbol | signature | incoming CALLS |
  |---|---|---|
  | `SentMessageConsumerBase.GetMessageInfo` | `protected abstract` | 1 |
  | `AutomationSentConsumer.GetMessageInfo` | `protected override` | **0** |
  | `CampaignSentConsumer.GetMessageInfo` | `protected override` | **0** |

  Same for `BuildCommand`, `LogProcessed`, `LogDuplicate`. The base's own call resolves to the base's
  abstract declaration and stops there.
- **Why the existing machinery does not cover it:** interface dispatch IS handled — a call to an interface
  method fans out to implementors as `interface-dispatch` CALLS edges, capped by
  `MAX_INTERFACE_DISPATCH_FANOUT`. The identical relationship through an abstract *class* has no
  equivalent, and cannot be given one as things stand, because **class inheritance is not recorded as a
  traversable relation at all.** `IMPLEMENTS` is only emitted for base-list entries passing
  `isLikelyCSharpInterfaceName`, so `class X : SomeBaseClass` yields nothing; verified on
  `AutomationSentConsumer`, which has zero IMPLEMENTS edges and only a `TYPE_REF` to its base — and a
  TYPE_REF carries no "extends" meaning, so nothing can walk it as a hierarchy.
- **Impact:** every `override` of an abstract or virtual member is a `dead_code_scan` false positive, and
  `find_implementations` / `get_call_chain` cannot follow a template-method hierarchy. The template-method
  pattern is common in this codebase's consumer lane, so the false positives cluster and look like a
  systematic finding rather than noise.
- **Shape of a fix (two parts, in order):** emit an inheritance edge for a non-interface base type — either
  a distinct `EXTENDS` type or `IMPLEMENTS` with a reason that distinguishes it, and the choice matters
  because several tools already read `IMPLEMENTS` as "interface contract". Then reuse the existing
  dispatch fan-out, keyed on that edge, for members marked `abstract` or `virtual`.
- **Workaround until then:** treat a candidate whose signature contains `override` as suppressed. Note that
  `dead_code_scan` does not currently do this — the signature is already stored, so it is a cheap interim
  guard if the full fix is deferred.

---

## MCP-ISSUE-036 — a qualified static call resolved to the WRONG same-named method

- **Status:** **FIXED** 2026-07-30 (`src/graph/edgeResolverCalls.ts`). Found by checking `dead_code_scan`
  on the live index after MCP-ISSUE-034 closed — the tool still reported methods with nine call sites dead,
  and the reason turned out to be resolution, not extraction.
- **Scenario:** two classes each declare a static method with the same name — extremely ordinary in C#.
  `ActivityCursor.EncodeCursor(DateTimeOffset, Guid)` and a private `EncodeCursor(int, DateTimeOffset, int)`
  in `GetInboxConversations`; `CrossChannelReplyHelpers.ResolveSubject` and
  `OutboundMetadataResolver.ResolveSubject`.
- **Root cause:** extraction emits BOTH `callee:Method` and `callee:Type.Method` for a qualified call, so
  the receiver type is known. The resolver then threw it away: the dotted branch consulted only
  `interfaceByName`, which misses a static class, and fell through to a name-only
  `pickBestNamedCandidate`. That picks ONE winner per name, so every call to either method landed on the
  same symbol.
- **Why it was invisible in the counts:** the qualified and bare tokens resolved to the same symbolId and
  collapsed under the unique index on `edges(repo_id, from_id, to_id, type)`. Nothing in the totals hinted
  that half the information had been discarded — the graph looked smaller, not wrong.
- **Impact:** not imprecision, misattribution. The loser showed **zero** incoming calls, so `dead_code_scan`
  reported it dead while `search_regex` found nine call sites. It also means "who calls this method" was
  answerable and wrong for any duplicated static helper name.
- **Fix:** before the name-only fallback, resolve the receiver as a `class` candidate and take the member
  method whose `parentSymbolId` is that class — with file identity as a second try, since symbols indexed
  before `parent_symbol_id` existed carry no parent and would otherwise silently miss.

| | before | after |
|---|---|---|
| `ActivityCursor.EncodeCursor` incoming calls | **0** | **2** |
| `CrossChannelReplyHelpers.ResolveSubject` | **0** | **2** |
| the same-named methods in the other class | 6 / 6 | 6 / 6 (unchanged) |
| total CALLS | 14621 | 16131 |

Both sides now hold their own calls — the fix attributes correctly rather than moving the attribution from
one symbol to another. Determinism re-verified: two full runs, all nine edge types identical.

---

## MCP-ISSUE-035 — vector KNN applied `k` across all repos, then filtered, so resolution lost its fallback

- **Status:** **FIXED** 2026-07-30 (`src/store/vectorStore.ts`). Found while building the control run for
  MCP-ISSUE-032 — the hypothesis was wrong, but looking for it surfaced this.
- **Scenario:** any repo sharing the central DB with others; worse the smaller its share.
- **Root cause:** `vec_symbols` had no repo column, so the query filtered `m.repo_id` on the *joined map
  table* while `k` was evaluated by vec0 against the **entire** table. It asked for the 3 nearest symbols
  in the world, then kept whichever happened to belong to the repo being resolved.
- **Evidence:** 34709 vectors across 7 repos; `wec.communication-hub` is 7.7% of them. Of 40 real
  unresolved type names from that repo:

  | | before | after |
  |---|---|---|
  | returned fewer than the 3 rows requested | **34 / 40** | **0 / 40** |
  | returned ZERO rows | **14 / 40** | **0 / 40** |
  | zero despite the repo holding candidates | 14 (one had 332) | 0 |

- **Second defect, same query:** vec0 assigns rowids on insert and `deleteVectorsByRepo` re-inserts on
  every rebuild, so distance ties broke by rowid — 7 of those 40 queries were tie-affected. `ORDER BY
  distance, symbol_id` is **not** enough: vec0 picks its k rows first, breaking ties internally, and only
  then does SQL sort them. The ORDER BY can reorder the chosen k, not change which k were chosen. Fixed
  by over-fetching and widening until the farthest row returned is strictly beyond the k-th, at which
  point the whole tie group is provably in hand.
- **Fix:** `repo_id TEXT partition key` on `vec_symbols`, so vec0 evaluates k within the repo; plus the
  deterministic cut above. A pre-partition table is detected via `pragma_table_info` and rebuilt — vectors
  are derived data (trigram hashes of `symbols.name`), so dropping beats migrating. 2664 vectors rebuild
  in 319ms.
- **Also added:** `CODEBASE_INDEX_VECTOR_ENABLED=false` disables vector search outright — not "fall back
  to the in-memory index", genuinely off. The distinction is the point: it exists to be a control, and a
  switch that quietly re-routed to another vector implementation would answer a different question.
- **Covered by:** `src/store/vectorStore.test.ts`, 5 cases, built on a deliberately multi-repo fixture. A
  single-repo fixture passes either way and would have caught nothing.

---

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

## MCP-ISSUE-033 — `dead_code_scan` returned an empty result for every repo, always

- **Status:** **fixed** 2026-07-29 (`src/analysis/staticAnalyzerDeadCode.ts`). Found while trying to
  observe the MCP-ISSUE-031 fix through the tool — which turned out to be impossible, because the
  tool had never returned anything.
- **Scenario:** `dead_code_scan` on any repo, with default options.
- **Symptom:** `{"count": 0, "suppressed": {"total": 0, "reasons": {}}, "symbols": []}`. Both lists
  empty, status ok.
- **Root cause (confirmed):** `includePrivate` defaults to `false`, which added the condition
  `s.name not like '_%'`. The intent was "skip names beginning with an underscore" (the C# private
  backing-field convention). But in SQL `LIKE`, `_` is a **single-character wildcard**, so `'_%'`
  matches every name of length ≥ 1 and `NOT LIKE '_%'` excluded **every symbol**. Measured on
  `wec.communication-hub`:

  | filter applied | rows surviving |
  |---|---|
  | repo + kind filter | 2760 |
  | + `signature not like 'private %'` | 2137 |
  | + `name not like '_%'` *(as written)* | **0** |
  | + `name not like '\_%' escape ''` *(fixed)* | 2760 |

  For the record, the repo contains **zero** symbols actually starting with an underscore, so the
  condition was removing 2760 rows to filter nothing.
- **Why it survived this long:** the empty result is a *plausible* answer — "no dead code found" reads
  as a clean bill of health, not as a broken filter. Two further things pointed away from the cause:
  the `suppressed` block was also empty (suppression only ever sees candidates, and there were none),
  and the response's own hint suggested unresolved call/import edges, which sends a reader to look at
  edge resolution. It also means **every previous clean `dead_code_scan` in this workspace was
  meaningless**, including the ones behind the "Dead public symbols" row in the tool-selection table.
- **Fix:** `s.name not like '\_%' escape ''`. Only one site in `src/` used an unescaped `_` in a
  LIKE pattern, verified by grep.
- **Verified end to end** through a real server against the real graph, `language: "csharp"`:
  400 candidates (limit-capped) and 997 suppressed, broken down as
  `heuristic_runtime_or_convention_usage: 631`, `heuristic_entry_point: 302`,
  `heuristic_contract_declaration: 56`, `heuristic_helper_container: 8` — so the C# suppressors are
  live rather than merely unreachable. 22 of the reported symbols sit in `I<lowercase>.cs`
  implementation files (`InboundMessageConsumer.cs`, `IdentityAuthorizationRequest.cs`,
  `InboxCardProjection.cs`, …), which is MCP-ISSUE-031's fix visible through the tool for the first
  time.
- **Covered by:** `src/analysis/staticAnalyzerDeadCode.test.ts` — five tests over an in-memory DB:
  ordinary names survive, a literal leading underscore is still excluded, `includePrivate: true`
  lifts both conditions, a symbol with an incoming edge is not a candidate, and the language filter
  works through the `files` join. The test schema carries the real `primary key (repo_id, path)` on
  `files`; without it the `insert or ignore` has nothing to conflict on and the LEFT JOIN multiplies
  every row — a test schema that drifts from the real one invents its own failures.
- **Follow-on found by the fix: the scan was never fast, only empty.** With the filter working, the
  first live call exceeded the 120s tool timeout on `wec.communication-hub` (4442 symbols). The row
  query selected `fileIncomingUsages` — a correlated subquery joining `edges` to `symbols` **twice**,
  evaluated once per row, and correlated only on `s.file_path`, so it recomputed an identical answer
  for every symbol in the same file. **Nothing read it**: not the suppressors, not the response. It was
  the most expensive part of the statement and its value was discarded. Removed; the call went from
  timing out to ~29.5s.
- **Performance — fixed 2026-07-29.** Three changes, each necessary; the third did most of the work:

  1. **`NOT EXISTS` instead of counting.** Four of the five correlated subqueries existed only to find
     rows whose count was zero, so they moved into the `WHERE` clause where they short-circuit on the
     first match and use `idx_edges_repo_type_to`. Only `outgoingCalls` is still selected as a value —
     `isLikelyEntryPoint` reads it.
  2. **Two queries, not one.** The counts could not simply move: `buildFileContexts` needs *every* row
     of a file to collect its evidence ("does this file hold a validator class?"), and that class
     usually *does* have incoming edges — so it would vanish from a filtered row set and silently
     weaken suppression. Candidates are fetched first, then context rows for just those candidates'
     files. The context query deliberately ignores the caller's `kind`/`includePrivate` filters, for
     the same reason.
  3. **Keyset pagination instead of `OFFSET`.** This was the real bottleneck. With `OFFSET`, SQLite
     re-evaluates and discards the skipped prefix on every page, re-running the `NOT EXISTS` predicates
     quadratically. A `(file_path, line)` cursor matching the `ORDER BY` fixed it: `wec.communication-hub`
     went 15.2s → 0.4s and `wec.be` from a request timeout → 0.8s.

  | repo | symbols | before | after |
  |---|---|---|---|
  | `codebase-index-mcp` | 1051 | 83ms | **18ms** |
  | `ssnet` | 5087 | 7.2s | **186ms** |
  | `wec.communication-hub` | 4411 | 29.5s | **402ms** |
  | `api-testing-studio` | 3937 | — | **261ms** |
  | `wec.social-ads` | 9406 | — | **619ms** |
  | `wec.be` | 67887 | **request timeout** | **838ms** |

- **Two deliberate output changes**, both stated rather than slipped in:
  - `suppressed.total` is smaller (171 → 95 on `wec.communication-hub`). The suppression checks run
    *before* the incoming-edge test, so the old count included symbols that had incoming edges and were
    never candidates at all. The new number counts only symbols that would otherwise have been
    reported, which is what the field is for.
  - A **`suppressed.truncated: true`** flag. The candidate scan stops at `max(limit * 20, 300)` rows,
    because paging the entire candidate set costs 40s on `wec.be` against 0.8s with the bound. That
    makes `suppressed.total` a count over rows examined rather than over the repo, so it is reported —
    a capped number that looks total is worse than a smaller number that says it is capped. Raise
    `limit` for a wider census; the cap scales with it.

- **Lesson worth keeping:** a tool that returns a well-formed empty result is harder to notice than
  one that errors. MCP-ISSUE-031 was found by reading code, and its fix could only be *measured* by
  bypassing the tool entirely — that gap should itself have been the signal.

---

## MCP-ISSUE-031 — `dead_code_scan` suppresses every method in an `i`-prefixed C# file

- **Status:** **fixed** 2026-07-29 (`src/analysis/staticAnalyzerDeadCodeCSharp.ts`). Found the same
  day while splitting `staticAnalyzer.ts` (S-41); the defect predated the split.
- **Scenario:** `dead_code_scan` on a .NET repo. Any method declared in a file whose name begins
  with `I` followed by a letter — `ItemService.cs`, `IndexController.cs`, `InvoiceRepository.cs` —
  is dropped from the candidate list under `suppressed.reasons.heuristic_contract_declaration`.
- **Root cause (confirmed):** in `getCSharpSuppressionReason`
  (`src/analysis/staticAnalyzerDeadCodeCSharp.ts`), `normalizedPath` is lowercased before the filename is
  taken, and the interface-file test is then `/^i[a-z].*\.cs$/`. The pattern was written for the
  `IThing.cs` convention, where the discriminator is the *capital* `I` followed by a capital letter
  — but the casing is already gone by the time the test runs, so it matches any `i`-initial
  filename. The three sibling checks on the same branch (`/interfaces/`, `/contracts/`,
  `/abstractions/`) are path-based and unaffected.
- **Expected vs actual:** expected only interface declarations (`IOrderService.cs`) to be reported
  as `heuristic_contract_declaration`. Actual: ordinary implementation files match too, so the scan
  silently under-reports. Because a suppressed symbol is *excluded*, this is a false negative — the
  tool looks clean while hiding candidates, which is the failure mode hardest to notice.
- **Impact:** `dead_code_scan` under-reports on any .NET repo with `I`-initial type names. Scale
  depends on naming; on `wec.communication-hub` it covers every `Invoice*`/`Item*`/`Identity*` file.
  No effect on non-C# rows, which exit the function before this check.
- **Workaround:** none from the tool side. Cross-check an `I`-initial file by hand
  (`find_impact_files` view `"surface"` on it) before trusting a clean scan.
- **Fix:** the filename test now reads the basename from the **original** path and matches
  `/^I[A-Z]/` (plus a case-insensitive `.cs$`). The three sibling checks stay on `normalizedPath`
  because they are path-based and case-insensitive by intent — a repo naming the folder `Interfaces/`
  or `INTERFACES/` must still match, and a test pins that. `fileName` (lowercased) is retained
  alongside the new `originalFileName`, since the later `/abstractions?\.cs$/` check genuinely wants
  the case-folded form; removing it broke three unrelated tests before typecheck caught the
  undefined reference.
- **Measured on the repo the issue named** (`wec.communication-hub`, 2021 C# methods), running both
  predicates over the real indexed symbols:

  | | old rule | new rule |
  |---|---|---|
  | methods suppressed by the filename test | 124 | 46 |

  78 methods across 9 files are no longer hidden — `InboundMessageMetadataMapper.cs`,
  `InboxCardProjectionService.cs`, `IdentityService.cs`, `Inbox.cs`,
  `IdentityAuthorizationClient.cs` and four more. 27 genuine interface files
  (`IApplicationDbContext.cs`, `IBackgroundTaskQueue.cs`, …) are still suppressed, and **nothing
  became newly suppressed**. That second half matters: a fix that merely stopped suppressing
  everything would have shown the same headline delta.
- **Contract impact:** none. `tools/list` is unchanged (`contracts:check` 4/4); this is a behaviour
  change only — `dead_code_scan` now reports more candidates on .NET repos, which is the point.
- **Covered by:** `src/analysis/staticAnalyzerDeadCodeCSharp.test.ts`, tests
  `"MCP-ISSUE-031 fixed: only a capital-I-capital filename reads as an interface file"` and
  `"MCP-ISSUE-031: the path-based interface checks stay case-insensitive"`.
- **Noticed, not fixed:** 42 of the 78 freed methods are in test files
  (`InboundMessageConsumerIntegrationTests.cs`, `InboxCardProjectionServiceConcurrencyTests.cs`).
  `dead_code_scan` has no `excludeTests` option the way `search_symbols` does, so test methods
  compete with production candidates in the output. Separate concern, separate change.

---

## ISSUE-CR-001 — Package bridge resolves 0/257 (cross-repo provider linkage)

- **Status:** fixed 2026-06-29 (`src/dotnetProjectParser.ts`) — provider bridge symbol now emitted for implicit PackageId. Consumer-side `edges`/`find_package_consumers` workaround remains valid as a fallback.
- **Root cause (confirmed):** the provider-side `nuget-export` module symbol (signature `nuget:<id>`) was only emitted when the `.csproj` declared an explicit `<PackageId>`. Real provider projects (e.g. `SSNet.CommunicationHub.Messaging`) rarely set it — NuGet defaults `PackageId` to `AssemblyName`, then to the project file name — so no provider symbol existed for `resolveUnlinkedEdges` to bridge against, leaving `packageResolved: 0`.
- **Fix:** `extractCsproj` now derives the contract id as `PackageId ?? AssemblyName ?? <project file name>`. Non-packable projects emit no bridge symbol — `isProjectPackable` detects `<IsPackable…>false`, `<IsTestProject>true`, and a `Microsoft.NET.Test.Sdk` reference (attribute-tolerant). Because the broadened emission raises the chance of two repos exporting the same `nuget:<id>`, `resolveUnlinkedEdges` no longer drops a colliding contract as `ambiguous_candidates`: for `nuget:`/`endpoint:` toIds it now resolves to the most complete provider repo (same `pickBestModule` heuristic as `resolveImportsCrossRepo`); genuine symbol-id collisions still stay ambiguous. Covered by `scripts/test/test-nuget-bridge.mjs` (implicit-PackageId, non-packable, and contract-collision-tiebreak scenarios).
- **First observed:** 2026-06-29 (live `health_check` on `wec.communication-hub`)
- **Scenario:** Cross-repo "who consumes the messaging contract" / provider-side symbol resolution.
- **Tool/query attempted:**
  - `health_check{ repoId: "wec.communication-hub" }` → `packageBridge: { packageAttempts: 257, packageResolved: 0, packageNoCandidate: 257 }`; `crossRepoResolved 34/5000`.
  - `get_cross_repo_impact` → returns `impactCount: 0` for actively-consumed contract symbols.
  - `find_package_consumers{ packageName: "nuget:ssnet.communicationhub.messaging" }` → 0 (double-prefixed to `nuget:nuget:...`).
- **Expected vs actual:** Expected provider symbols (in `ssnet.communicationhub.messaging`) to link to Hub's `nuget:` dependency edges. Actual: zero bridge links; per-consumer `resolved:false`.
- **Root-cause hypothesis (from `codebase-index-mcp/src/crossRepoStore.ts`):** The bridge (`findProviderSymbolByName` / `getPackageBridgeStatsImpl`) only links when a provider repo emits a `module` symbol whose `signature` **exactly equals** the consumer's `nuget:<contractId>` string. The messaging provider repo apparently does not produce a `module` symbol with signature `nuget:ssnet.communicationhub.messaging`, so no edge matches.
- **Impact:** Provider-side enrichment (provider repo/symbol columns) is empty; `get_cross_repo_impact` is unreliable. Consumer-side discovery is NOT affected.
- **Workaround (verified, in CLAUDE.md + POLICY.md + SKILL.md):**
  1. `query_graph` → `select distinct to_id from edges where repo_id=:repoId and type='DEPENDS_ON' and to_id like 'nuget:%'` to get the exact contract id.
  2. `find_package_consumers{ packageName: "ssnet.communicationhub.messaging" }` — **bare name, no `nuget:` prefix** → returns 8 consumers. The `edges` query works regardless of bridge state; `resolved:false` is the expected gap.
- **Enhancement proposal (touches `codebase-index-mcp`, out of scope for the docs PR — separate follow-up):**
  - Confirm the gap: `query_graph{ repoId: "ssnet.communicationhub.messaging", sql: "select symbol_id, name, signature from symbols where kind='module'" }` and compare `signature` values against the `to_id` strings the Hub depends on.
  - If signatures don't match the `nuget:<id>` format, fix the provider-side module-symbol signature emission (or the bridge's matching rule) in the indexer so `packageResolved` rises above 0; otherwise accept the consumer-side workaround as permanent and document it as such.

---

## ISSUE-CR-002 — `find_package_consumers` double-prefixes `nuget:`

- **Status:** fixed 2026-06-29 (`src/responseFormatter.ts`) — `toNugetContractId` is now idempotent.
- **First observed:** 2026-06-29
- **Scenario:** Passing a fully-qualified `nuget:<name>` to `find_package_consumers`.
- **Expected vs actual:** Expected the tool to accept the contract id as-is. Actual: it re-prepended `nuget:`, producing `packageContractId: "nuget:nuget:<name>"` → `consumerCount: 0` (false negative).
- **Fix:** `toNugetContractId` strips a leading `nuget:` prefix (any case/whitespace) before re-prefixing, so both a bare name and a fully-qualified id normalize to the same `nuget:<lowercase>` contract id. Covered by `scripts/test/test-nuget-bridge.mjs` (idempotency scenario).
- **Note:** Passing the bare package name still works exactly as before; both forms are now accepted.
