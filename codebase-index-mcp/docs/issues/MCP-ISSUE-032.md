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

