# MCP Codebase-Index — Issue Registry (server-side bugs)

Bug/enhancement reports for the `codebase-index-mcp` server, raised from consuming repos (e.g.
`wec.communication-hub`). Each entry: Scenario · Tool/query attempted · Expected vs actual · Impact ·
Workaround · Enhancement proposal. Filed here so the MCP server team can triage and fix at the source.

> Note: consumer repos keep their own *fallback log* (when they drop to Grep/Read) separately; this
> file tracks defects/limitations of the MCP server itself.


## Index

**22 entries — 20 resolved, 2 open.** Statuses and dates are copied from each entry's own
`**Status:**` line — the entry is authoritative. Regenerate by scanning `^## ` headings and the
first `- **Status:**` line beneath each.

Entries 042–049 all came from one sweep: every tool (43) and every resource (28) exercised
against `wec.communication-hub` on 2026-08-04, on the post-restructure build (`411afe5`), from a
fresh server process (staleness gate per MCP-ISSUE-040 cleared first). They were **not** regressions
of the restructure — each reproduced a defect first observed on 2026-08-03 unless the entry says
otherwise. Seven were triaged and fixed on 2026-08-04, 049 in a third wave the same day with one of
its ten items **refuted** on inspection. The consumer repo then re-ran every repro independently —
see *Independent re-verification* below: seven confirmed fixed, **two sub-items of 049 still
reproduce**, and 043's deferred half is measurably load-bearing rather than cosmetic. Both surviving
sub-items were then reproduced here and **fixed 2026-08-04 (fourth wave)**; the staleness one was not
the relabelling defect the consumer diagnosed but an append-only table underneath it — see
*Fourth wave* below, and read it before trusting any "verified on a fresh index" claim in this file.
**051 closed in the same wave**, with the zod↔JSON-Schema parity check the entry named as its real
deliverable. The one piece left undone was 043's owner prover, promoted to backlog **B-13** (P1)
because it needed AST work rather than a patch — **shipped 2026-08-05 as the fifth wave**, and with it
every entry in this registry is closed. See *043 → Deferred* below: the prover moved to
`src/services/refactor/ownerResolver.ts`, `requiredOwnerType` went from 1 of 3 sites to 3 of 3, and an
unprovable owner is now flagged rather than dropped.

| ID | Title | Status |
|---|---|---|
| `MCP-ISSUE-042` | `refactor_replace_rollback` restores the files and leaves the graph holding the reverted names, while `health_check` reports "ready" | ✅ FIXED 2026-08-04 |
| `MCP-ISSUE-043` | the guarded-refactor tools refuse work `refactor_replace_preview` does — a hardcoded kind filter, **and** an owner prover that answered the wrong question | ✅ FIXED 2026-08-04 (kind filter + diagnostics) · ✅ FIXED 2026-08-05 (AST owner prover, B-13) |
| `MCP-ISSUE-044` | `find_entry_points(kind:"route_handler")` returns a count with empty arrays; `route_map` names the endpoint group, not the handler | ✅ FIXED 2026-08-04 |
| `MCP-ISSUE-045` | cross-repo resolution matches bare type names, so `Task` links every repo to one unrelated class | ✅ FIXED 2026-08-04 |
| `MCP-ISSUE-046` | `find_package_consumers` returns the files that DEFINE the package, and a wrong name returns 0 silently | ✅ FIXED 2026-08-04 |
| `MCP-ISSUE-047` | `get_persistence_mapping` dumps every CHECK constraint in the repo, ignores `profile`, and disagrees with `find_field_accesses` about "owner" | ✅ FIXED 2026-08-04 |
| `MCP-ISSUE-048` | index-run counters contradict the database and each other | ✅ FIXED 2026-08-04 |
| `MCP-ISSUE-050` | `index_version` was never persisted, so `mode:"incremental"` could never fast-skip | ✅ FIXED 2026-08-04 |
| `MCP-ISSUE-049` | ten papercuts found by the same sweep (identity dropped at compact/nano, no test filter, envelope varies by mode, path style split) | ✅ FIXED 2026-08-04 — incl. the 2 sub-items that survived consumer re-verification (4th wave) |
| `MCP-ISSUE-051` | four tools accept `profile` in code but never advertise it, so a spec-conformant client must reject it | ✅ FIXED 2026-08-04 (incl. the zod↔JSON-Schema parity check) |
| `MCP-ISSUE-040` | a live server running a replaced build fails every parse, and the run still reports `ok` | ✅ FIXED 2026-08-03 |
| `MCP-ISSUE-041` | `get_call_chain` stopped seeing through DI when a fix was orphaned by a file move | ✅ FIXED 2026-08-03 |
| `MCP-ISSUE-032` | an index run is not reproducible: edge counts vary between identical runs | ✅ CLOSED 2026-07-30 |
| `MCP-ISSUE-038` | the `very-large` profile silently discarded every unresolved TYPE_REF, so MCP-ISSUE-034's fix was… | ✅ FIXED 2026-07-30 |
| `MCP-ISSUE-039` | the vector fallback cost 30s per run and resolved nothing | ✅ FIXED 2026-07-30 |
| `MCP-ISSUE-037` | abstract/virtual base-class members have no dispatch fan-out, so every override looks dead | ✅ FIXED 2026-07-30 |
| `MCP-ISSUE-036` | a qualified static call resolved to the WRONG same-named method | ✅ FIXED 2026-07-30 |
| `MCP-ISSUE-035` | vector KNN applied `k` across all repos, then filtered, so resolution lost its fallback | ✅ FIXED 2026-07-30 |
| `MCP-ISSUE-034` | C# `TYPE_REF` edges are almost never produced, so every C# type looks dead | ✅ FIXED |
| `MCP-ISSUE-033` | `dead_code_scan` returned an empty result for every repo, always | ✅ FIXED 2026-07-29 |
| `MCP-ISSUE-031` | `dead_code_scan` suppresses every method in an `i`-prefixed C# file | ✅ FIXED 2026-07-29 |
| `ISSUE-CR-001` | Package bridge resolves 0/257 (cross-repo provider linkage) | ✅ FIXED 2026-06-29 |
| `ISSUE-CR-002` | `find_package_consumers` double-prefixes `nuget:` | ✅ FIXED 2026-06-29 |

> IDs are not contiguous: this registry was pruned to the currently-tracked set, so `001`–`021`
> and `023`–`030` no longer appear. A document citing one of those is citing a removed entry.

### Live re-verification 2026-08-04 (`wec.communication-hub` @ `8fe717b`, full re-index, run `194918d4`)

Each entry's own repro re-run against the fixed build. Measured, not asserted:

| | before | after |
|---|---|---|
| **042** `health_check` after rollback | `status:"ready"`, `shouldReindex:false`, `reasons:[]` | `status:"stale"`, `shouldReindex:true`, all 3 files listed under `pendingReindex` — while `staleness.isStale:false` and `workingTree.isDirty:false`, i.e. both git signals still read healthy, exactly as filed. `mode:"dirty"` then re-indexed 3 files on a clean tree and the graph healed to the real name. |
| **043** `refactor_symbol_migration` | `totalMatches: 0`, `unresolvedOccurrences: 0`, empty summary | `totalMatches: 1` (confidence 0.95, no risk flags) **plus** `rejectedSiteCount: 2` naming the rule: `owner_not_allowed, inferred owner 'OutboundDeliveryFailedNotifier' != required` — the `findOwnerType` category error, now visible rather than silent |
| **044** `find_entry_points(route_handler)` | `{"total":5,"runtimeEntryPoints":[],"graphEntryPoints":[]}` | `total:5` with 5 `routeEntryPoints`, each a real handler method (`Reply`, `RetryReply`, …) with a distinct symbolId and an absolute normalized template — `POST /api/v1/conversations/{conversationId}/reply`, prefix resolved and `{conversationId}` casing preserved |
| **046** `find_package_consumers` | `consumerCount: 8`, all in the provider repo | `consumerCount: 46` across `wec.communication-hub` + `wec.be` — including the 34 hub edges the entry said appear nowhere — with `excludedPublisherRows: 64` |
| **047** `get_persistence_mapping(profile:"nano")` | full payload, all 24 repo-wide constraints | 9-field payload, `checkConstraintCount: 1`, `resolvedProperty` echoed, `ownersWithMapping:["Conversation"]`; mapping and projection warning unchanged |
| **048** edges | `edgesUpserted 49582` vs table 47998, unexplained | `edgesUpserted 49582`, `edgesInGraph 47998`, `edgesDeduplicated 2243`, `dispatchEdgesInserted 644` — the 1584 delta now reconciles (49582 − 2243 + 644 + 15 base-class/bus inserts) |
| **048** timings | `elapsedMs 15924` < `resolvePhaseMs 22270` | `elapsedMs 34358` > `extractPhaseMs 13891` + `resolvePhaseMs 20275`; containment holds |
| **048** coverage / unresolved | `1.0446`; `callEdgesUnresolved 0` beside `unresolvedCallsTotal 14420` | `resolveCallsCoverage 1` exactly (14420/14420); partition holds, and the measured remainder is reported separately as `callEdgesUnresolvedInGraph: 11331`. Note `dispatchEdgesInserted: 644` — and 14420 + 644 = 15064, which is the inflated "resolved" figure this entry recorded as 15063. That is the root cause, arithmetically confirmed. |
| **048** cross-repo | full 8 (attempts saturated at 5000) vs dirty 459 | full 123/425 attempts vs dirty 123/423 — no longer saturated, no longer inverted |
| **045** `Task` cross-repo links | 7 of 10 sampled rows | **408 links still present after the denylist shipped** — which exposed the append-only table described in that entry. Re-verify after the clearing fix. → **done, clean:** see the row for 045 in the consumer re-verification below. |

### Independent re-verification from the consumer repo — 2026-08-04

Same repros, re-run from `wec.communication-hub` by the agent that filed 042–049, against `dist`
built **16:40:22** (i.e. including `src/services/extractors/markdownParser.ts` at 16:33:11), on its
own full re-index — run `9f3c2a8a`, 521 files / 4459 symbols / `edgesInGraph` 47998. Independent of
run `194918d4` above. Live tool calls only; no source inspection.

**Confirmed fixed, from the consumer side:**

| | measured |
|---|---|
| **042** | After apply → `dirty` → rollback on a clean tree: `codebaseState.status:"stale"`, `shouldReindex:true`, `pendingReindex.fileCount:3` each with `reason:"restored by refactor rollback"`, `reasons:["3 file(s) written by the refactor engine are not re-indexed"]`, and an `actionHints` entry at urgency **high** whose reason states the danger outright. `refactor_replace_rollback`'s own response carries the same hint. `mode:"dirty"` then scanned exactly those 3 files **on a clean tree** and the graph healed to the real name; `pendingReindex` cleared and status returned to `ready`. Both enhancements the entry proposed, and the transient desync is now disclosed rather than hidden. |
| **044** | `find_entry_points{kind:"route_handler"}` → `total:5` with 5 `routeEntryPoints`, distinct symbolIds, `signature:"POST /api/v1/conversations/{conversationId}/reply"`. `route_map{excludeTests:true}` → `handlerName:"Reply"` ≠ `controllerName`, absolute template. |
| **045** | `cross_repo_deps` rows pointing at ssnet `Task`: **0** (was 7 of 10 sampled, then 408 table-wide). 123 links total, every target a genuine SSNet symbol — `OutboundFlowType`, `IOutboundDeliveryPublisher`, `QueueNames`, `ManualCallLogSourceType`, `CrmNotificationException`. The clearing fix works; the row above is superseded. |
| **046** | `consumerCount:46`, `consumerRepos:["wec.be","wec.communication-hub"]` — the hub's 34 edges are in — `resolvedCount:36`, `providers[]` separated, `excludedPublisherRows:64`. |
| **047** | `profile:"nano"` → 9 fields, `checkConstraintCount:1` (was all 24), `ownersWithMapping:["Conversation"]`. Wrong owner (`ConversationAssignmentState`) now answers with a `hint` naming the owned-type/EF-owner distinction and telling the caller to retry from `ownersWithMapping` — which is what closes the `find_field_accesses` → `get_persistence_mapping` chain the entry described. |
| **048** | Own full run: `elapsedMs 32060` > `extractPhaseMs 10774` + `resolvePhaseMs 21055`; `resolveCallsCoverage` exactly `1`; `edgesUpserted 49582` / `edgesInGraph 47998` / `edgesDeduplicated 2243` / `dispatchEdgesInserted 644` in one payload; cross-repo `425 attempts / 123 resolved` on full vs `423 / 123` on dirty — no saturation, no inversion. |
| **050** | `mode:"incremental"` on an unchanged clean tree → `filesScanned:0`, `elapsedMs:0`, `skipReason:"head unchanged and working tree clean"`. |
| **049** (8 of 10) | `get_call_chain{nano}` hops now carry `symbolId`+`name`+`filePath`; `view:"files"` and `view:"surface"` return visibly different shapes with `edgeTypes[]`; all three `query_docs` modes return the object envelope (`documented` on coverage); `health_check` without `repoId` → `scope:"server"` + `note` + `vectorIndex.measured:false` instead of a `0`; `find_implementations{excludeTests:true}` → 1 row; `get_feature_bundle{excludeTests:true}` → `command` role down to 4 and no `TestDbContext`; `rename_assist` → `affectedFileCount:3` including the declaring file, `hints` forward-slashed; `trace_execution_flow{nano}` → 10 distinct callees + `distinctCalleeCount:15`; `get_file_context` and `get_file_summary` now agree at `symbolCount:6`; intent ranking no longer returns a single migration in the top 4. |

**Still reproduces — two sub-items of 049, both under the `FIXED` status:**

1. **`mode:"stale"` still returns the archived-doc hits.** `query_docs{mode:"stale", symbolIds:["42814a63…" /* ConversationLoopCorrelationCodec.Parse */]}` → the same **5** hits, all `docs/02-flows/_archive/*`, each `mentionType:"backtick"` — the label the root-cause note identifies as the wrong one for an identifier harvested from a fenced code block. Measured after a `mode:"full"` run that re-extracted the docs lane (`docsUpserted 298`, `mentionsUpserted 2182`) on a `dist` newer than the parser source, so it is not a stale-mention artefact. If a rebuild after 16:57 changes this, the check is one call.
2. **nano `topEdges` still has no identity, which is what made the "duplicates" look unfixed.** `get_dependency_graph{profile:"nano"}` reports `collapsed:{selfReferences:1,duplicateEndpoints:13}` — the dedupe is working — but the surviving rows carry **names only**, so three genuinely distinct `NotifyAsync → PublishConversationNotificationAsync` edges (interface, implementation, test double) and a constructor→class `TYPE_REF` pair render as indistinguishable repeats. `get_call_chain{nano}` gained `symbolId` in the same change set; `topEdges` did not. From the consumer side this is the identity item, not the duplicate item — the fix is the same one-line-ish widening.

### Fourth wave — both reproduced here, both fixed 2026-08-04

Item 2 was exactly as reported. **Item 1's symptom was real and its diagnosis was wrong**, in a way
worth keeping on the record, because the wrong diagnosis is the one this file's own evidence pointed at.

**Item 2 — nano `topEdges` identity. Confirmed, fixed.** `handleGetDependencyGraph`
(`src/tools/handlers/impactHandler.ts`) mapped both nano branches to `{fromName, toName, type}`.
Widened to carry `fromId`/`toId`, matching what `get_call_chain` already did. One detail the consumer
could not have seen from names alone: when a target is unresolved, `toName` is null and the compact
serializer drops null fields, so the row arrived as `{"fromName":"docsStore.ts","type":"IMPORTS"}` —
naming nothing at all, not merely looking like a duplicate.

**Item 1 — `mode:"stale"`. Symptom confirmed; cause is not the parser.** The relabelling fix was
present and correct in the `dist` the consumer measured (`code_call` is in
`dist/services/extractors/markdownParser.js`, built 16:40:22 against a 16:33:11 source). The real
cause is one table below:

- `doc_mentions` was written by `upsertDocMentionsImpl` and **deleted by nothing**. There was no
  `delete from doc_mentions` anywhere in `src/`. `pruneFiles` (`src/repositories/writeStore.ts`)
  clears `edges`, `symbols`, `docs`, `routes`, `string_literals` and `files` for a path and omitted
  this one table — and it only runs for files that disappeared, never on re-extraction.
- The primary key is `(repo_id, doc_id, symbol_id, mention_type, mention_text)`. **`mention_type` is
  part of the key.** So correcting a mention's label does not update the row; it inserts a second one
  beside a legacy `backtick` row that no re-index can remove, `mode:"full"` included.
- `findStaleDocs` filters `mention_type != 'code_call'`, so it kept matching the legacy row. Five
  hits in, five hits out.

Reproduced in isolation before touching anything — one upsert as `backtick`, one as `code_call`,
against the real schema: two rows survive, and the staleness query still returns one hit.

The consumer's inference — *"Measured after a `mode:"full"` run … so it is not a stale-mention
artefact"* — is exactly inverted: a full re-index was the one thing guaranteed **not** to clear that
table. **And the reason our own verification passed is written in this file, in this entry:**
*"Verified as a pair, on `wec.communication-hub` indexed into a **throwaway DB**: `Parse` went 5 → 0."*
A throwaway DB has no legacy row. The assertion was run on the only database that could not exhibit
the bug. This is the same defect class as MCP-ISSUE-045's append-only `cross_repo_deps` — the second
time in one day that a write-path fix was validated against a table that was never cleared.

**What shipped:**

- `replaceDocsForFileImpl` (`src/repositories/docsStore.ts`) — replace-per-file for the docs lane,
  the counterpart to `replaceSymbolsForFile`. Deletes mentions before docs, since mentions are
  reachable only by joining `docs` on `file_path`. `runIndexPipeline` now calls it instead of the two
  upserts, alongside the four `replace*ForFile` calls it already made.
- `pruneFiles` gained the missing `doc_mentions` delete, ordered before the `docs` delete.
- **Two further parser defects, found while confirming the first and never reported:**
  `extractMentionsFromCode`'s *backtick* branch still emitted `mentionType:"backtick"` — only the
  call branch had been corrected — so a fenced-code identifier could still enter the prose signal
  even on a clean database. That is the defect the consumer believed they were observing; it exists,
  just not on the path they measured. And the heading regex ran regardless of fence state, so a
  `# comment` inside a bash block became a real heading: it published a doc node, reset
  `currentHeadingPath` for every following line, and fed its backticked identifiers to the prose
  extractor. In a repo whose docs are largely command samples that is a steady source of this same
  false positive.

**Regression coverage — the gap mattered more than the bug.** `src/repositories/docsStore.test.ts`
(new) asserts the **second** index pass: a relabel leaves one row and clears the false positive,
while `includeCodeMentions:true` still returns it; a mention dropped from a doc does not survive; and
nothing inside a fence reaches the prose signal. `test-issue-049-shapes.mjs` gained nano identity
assertions for both `get_dependency_graph` branches — it had checked `fromId`/`toId` only at
`compact`, where they were never missing. A single-pass assertion on a fresh DB is what let this
through; that shape of test is not evidence for a write-path fix.

Gate: 4/4 servers build + typecheck, 36/36 harnesses (63 assertions in the 049 harness, up from 59),
84 unit tests (up from 81), `generate:check` and `docs:check` clean.

**043 — the deferred half is load-bearing, not cosmetic.** `refactor_symbol_migration{requiredOwnerType:"ConversationLoopCorrelationCodec"}` now returns `totalMatches:1` plus `rejectedSiteCount:2` naming the rule (`owner_not_allowed`, `inferred owner 'OutboundDeliveryFailedNotifier' != required`) — a real improvement over the silent `0`. But because `findOwnerType` returns the *enclosing* class, `requiredOwnerType` can only ever match sites **inside the declaring type**: 1 of the 3 sites `refactor_replace_preview` finds. That makes the tool's primary use case — migrate a member across its consumers under an owner guard — currently unreachable, with `refactor_replace_preview` (no owner guarantee) as the only path. Worth weighing when the AST work is scheduled. → **Accepted, and promoted:** the assessment is correct — the doc comment on `findOwnerType` already concedes the mechanism. Scheduled as **B-13** in `docs/development/backlog.md`, filed under *P1 — a tool reports something untrue* rather than left as a deferred cosmetic. Not fixed here: it needs real AST resolution of the receiver expression's type. → **Fixed 2026-08-05 (fifth wave)**, exactly that way: `src/services/refactor/ownerResolver.ts` types the receiver from the C# AST, `requiredOwnerType` reaches 3 of 3 sites, and the consumer's judgement that this was load-bearing rather than cosmetic is what got it scheduled. See the *Deferred* section of 043.

**Two other observations, neither worth its own entry:** `cross_repo_deps` now counts `SSNet.sln` as a target (32 rows) alongside the `.csproj` module rows, which is provenance noise rather than a wrong link; and `strategy:"intent"` no longer surfaces migrations but is still weak on relevance — `"send outbound email via crm callback"` returns `ISender.Send` / `SimpleMediator.Send` / `EmailSignatures.Map`, i.e. the mediator, not the outbound delivery path.

---

## MCP-ISSUE-040 — a live server running a replaced build fails every parse, and the run still reports `ok`

- **Status:** **FIXED** 2026-08-03 (three changes, below). Filed from a repository review of
  `mcp-local`; this is the fallback log the MCP-first policy requires for that session.
- **First observed:** 2026-08-03, re-indexing `mcp-local` at HEAD `65c8c8d`.
- **Scenario:** a `codebase-index` server process had been running since before the standard-structure
  move; `dist/` was rebuilt underneath it. `extractionWorkerPool` resolves its worker with
  `new URL("./extractionWorker.js", import.meta.url)`, so the in-memory (pre-move) module resolved
  `dist/extractors/extractionWorker.js`, a path that no longer exists.
- **Expected vs actual:**

  | | previous run (`47d185a`) | the broken run | fresh process, same build |
  |---|---|---|---|
  | symbols | 2097 | **57** | 1167 |
  | edges | 6233 | **0** | 3185 |
  | parse failures / timeouts | 0 / 0 | **217 / 126** | 0 / 0 |
  | elapsed | 2.3 s | **342 s** | 1.2 s |
  | `status` | ok | **ok** | ok |

  Reproduced twice, the second time on an idle machine, ruling out CPU contention. `docsUpserted`
  was **867** in the broken run — the docs lane spawns no worker, which is what localises the fault
  to the worker path rather than to extraction generally.
- **Impact — the reason this is P1.** Nothing in the workspace could see it. `mcp:doctor` reported
  **PASS 4/4** (it spawns a *fresh* process for its `start` check, so it can never observe the
  running one), `health_check` reported the index **fresh at HEAD**, and the broken run had already
  overwritten a good index. Every graph tool then answered from an empty index with no warning.
- **Workaround used:** restart the MCP server, then `index_repository(mode:"full")`. Confirmed: 400
  files, 2180 symbols, 6522 edges, 0 failures, 2.0 s.
- **Fixed by:**
  1. `IndexRunStatus` gains **`degraded`** — `assessRunHealth` (`services/indexing/runFinalize.ts`)
     sets it when ≥10% of attempted files fail to parse, or when a `full` run over ≥10 files
     produces symbols but zero edges. `healthReasons[]` carries one line per failing check. Pinned
     by `runFinalize.test.ts`, whose regression cases are this incident's exact counters.
  2. `mcp:doctor` gains a **`running`** check (`scripts/lib/runningServers.mjs`): any live process
     whose start time predates the newest `dist/**/*.js`. Warning-only and never fatal — after any
     rebuild this is expected and harmless *unless a module moved*, which is the case it exists for.
  3. `docs/reference/folder-convention.md` §8 records the rule; B-12's dist-orphan check covers the sibling
     case (a file on disk with no source) and this covers the other (a process older than the disk).
- **Enhancement not taken:** having the worker pool verify its worker path exists at pool
  construction and fail loudly. Worth doing, but it fixes one symptom of a stale process rather than
  the class — the `degraded` status covers any cause of a graph that did not build.

---

## MCP-ISSUE-041 — `get_call_chain` stopped seeing through DI when a fix was orphaned by a file move

- **Status:** **FIXED** 2026-08-03. Sibling of MCP-ISSUE-022, found during the same review.
- **Scenario:** `get_call_chain(direction:"callers")` on an implementation method missed every caller
  that dispatches through the interface — i.e. all production callers, since only tests construct
  the concrete class. That is the exact symptom ISSUE-022 was filed and fixed for.
- **Root cause:** ISSUE-022 has two defences — resolution-time `interface-dispatch` CALLS edges, and
  query-time interface-sibling frontier seeding. The second lived in
  `services/graph/graphTraversal.ts`. S-41 (`a1d992c`) re-homed the loose `src/` files, inlined the
  traversal into `tools/handlers/impactHandler.ts` **without** the seeding, and left the fixed module
  orphaned and imported by nothing. `store.expandInterfaceSiblings` had exactly one call site in the
  codebase, in that dead file.
- **Why no test caught it:** `test-interface-dispatch.mjs` asserts the resolution-layer half, and
  reaches the query layer only through `getChangeContext`. No harness drove `get_call_chain` across
  an interface, so 35 harnesses stayed green for four commits.
- **Fixed by:** restoring the seeding into `impactHandler.traverseCallGraph` (with a comment naming
  this entry), deleting the dead module, and adding `scripts/test/test-call-chain-interface.mjs` on a
  fixture where *only* sibling seeding can succeed — the CALLS edge lands on the interface method and
  no dispatch edges exist. Proven to fail without the fix: `got 0 edge(s)`.
- **General lesson worth keeping:** when a file move inlines a function, the copy that survives is
  whichever the author had in front of them, not necessarily the fixed one. A dead module that still
  compiles is where a fix goes to die.

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

## MCP-ISSUE-038 — the `very-large` profile silently discarded every unresolved TYPE_REF, so MCP-ISSUE-034's fix was inert on the biggest repo

- **Status:** **FIXED** 2026-07-30. Filed as open because every remedy considered at the time raised edge
  volume on the largest repo. What shipped avoids that trade entirely — see the update at the end: the
  expensive part was never the storage, it was the LINKING, and `dead_code_scan` does not need it.
- **Scenario:** `wec.be` — 7528 files, so `performanceProfile` auto-selects `very-large`.
- **Evidence:** TYPE_REF on `wec.be` is **1112 edges over 67980 symbols, with ZERO unresolved tokens**.
  Compare `wec.communication-hub` (`standard`): 14377 edges, of which 6652 are unresolved tokens. Two
  repos of the same language and shape, differing by two orders of magnitude in the relation that
  `dead_code_scan` depends on.
- **Root cause — a threshold collision, not a decision anyone made:**
  - `getEffectiveEdgeConfidence` gives a `type:` token no explicit confidence, so it defaults to **0.45**.
  - `defaultEdgePolicy("very-large")` sets `minEdgeConfidence: **0.5**`.
  - `applyEdgeConfidenceFilter` therefore drops **all** of them at extraction, before they reach the DB.
    The 1112 survivors are intra-file resolutions, which carry 0.9.
- **Why it went unnoticed:** before MCP-ISSUE-034 the extractor emitted ~148 TYPE_REF edges in total, so
  losing the unresolved ones cost nothing observable. Now TYPE_REF is the primary evidence for "is this
  type referenced anywhere", and on the largest repo all of it is thrown away.
- **Confirming detail that rules out a different explanation:** bare `callee:` tokens default to 0.4 and are
  dropped for the same reason, while *qualified* `callee:Type.Method` carries an explicit 0.75 and survives
  — `wec.be` holds 11086 unresolved CALLS tokens. So the filter is working as written; it is the
  unannotated defaults that fall on the wrong side of the line.
- **Impact:** `dead_code_scan` on `wec.be` still reports type declarations as its top candidates
  (`ConversationReplyPublishRequest`, `ManualCallLogRequest`, `OsbBookingPublishRequest`), the exact class of
  false positive MCP-ISSUE-034 fixed elsewhere. The 48% reduction measured on `wec.communication-hub` does
  not transfer to any repo large enough to trip the profile.
- **Three remedies, each with its real cost:**
  1. Give `type:` tokens an explicit confidence ≥ 0.5. Smallest change, but it makes the profile's own
     threshold meaningless for TYPE_REF rather than stating an intent.
  2. Exempt TYPE_REF from the confidence filter and bound it separately (a per-file cap, as CALLS already
     has via `maxCallEdgesPerFile`). Most honest, most work.
  3. Lower `very-large`'s `minEdgeConfidence`. Cheapest to write, widest blast radius — it would also
     re-admit bare `callee:` tokens, roughly doubling CALLS on a 67k-symbol repo.
- **Estimated cost of admitting them:** `wec.communication-hub` carries 6652 unresolved TYPE_REF tokens for
  4457 symbols (~1.5 per symbol). At that ratio `wec.be` would gain on the order of 100k edges against its
  current 117893 — a near-doubling of the table, plus the resolve-phase work those rows attract. Not a
  detail to decide in passing, which is why this is filed rather than fixed.

### Update 2026-07-30 — FIXED, and none of the three remedies above is what shipped

All three framed this as "how much extra cost do we accept". That framing was wrong. The expensive part is
not storing the edges, it is LINKING them — and `dead_code_scan`, the tool this whole issue is about, does
not need them linked. Its predicate is `to_id = s.symbol_id OR to_id = 'type:' || s.name`, which matches
**unresolved tokens by name**.

So the two halves were separated:

1. **Keep the edges.** TYPE_REF is exempt from the confidence filter and bounded by its own per-file cap
   (`applyTypeRefEdgeCap`, env `CODEBASE_INDEX_MAX_TYPE_REF_EDGES_PER_FILE`). A cap degrades locally — the
   worst file contributes less — where a confidence floor degraded categorically, deleting the relation
   repo-wide. The 0.45 default is now stated at the point of emission rather than inherited from a prefix
   table in another module, which was the real fragility: nobody reading either file could see that one
   number sat 0.05 below the other.
2. **Skip the linking on `very-large`.** The cross-repo provider search and the vector search are gated off
   there. `findProviderSymbolByName` runs three queries per distinct type name, and on `wec.be` 40k tokens
   are framework names with no in-repo target — 105 seconds spent proving nothing.

**Measured on `wec.be` (7528 files, 67980 symbols, `very-large`):**

| | before | keep-edges only | + skip linking |
|---|---|---|---|
| TYPE_REF edges | 1112 | 80931 | **80931** |
| unresolved tokens | 0 | 39937 | 40246 |
| `typeResolveMs` | 1 | 105743 | **1719** |
| run `elapsedMs` | 98801 | 117577 | **100542** |
| falsely-dead class/record/struct | 6251 | — | **2626 (−58%)** |

**72.8x more TYPE_REF and 58% fewer falsely-dead types, for 1.7 seconds.** Skipping the linking costs 309
tokens that would have resolved via fallback, and `dead_code_scan` matches those by name regardless.

Every bound now reports itself, which was the other half of the lesson: the run summary carries
`edgesDroppedByConfidence` / `byCallCap` / `byTypeRefCap`, present only when non-zero. On `wec.be` that
immediately surfaced **37824 edges still dropped by the confidence floor** — bare `callee:` tokens at 0.4, a
separate lane that was equally invisible before. Not addressed here, but now countable rather than merely
absent.

---

## MCP-ISSUE-039 — the vector fallback cost 30s per run and resolved nothing

- **Status:** **FIXED** 2026-07-30 (`edgeResolverCalls.ts`, `edgeResolverRefs.ts`, `vectorStore.ts`).
  A regression introduced by MCP-ISSUE-035's own fix, found while measuring MCP-ISSUE-037.
- **How it was caused:** before MCP-ISSUE-035, 35% of vector queries returned zero rows because `k` was
  consumed by other repos in the shared table, and finding nothing is fast. Making the lane CORRECT made it
  do real work, and the work turned out to be worthless on this data.
- **Evidence:** 968 distinct tokens reach the lane on `wec.communication-hub`, each KNN costs ~31ms, and
  **zero** clear the `distance < 0.35` gate. Confirmed by differencing a full run with
  `CODEBASE_INDEX_VECTOR_ENABLED` on and off: the CALLS `reason` breakdown is **byte-identical**, 11331 rows
  tagged `external boundary` either way. Draining those rows took 27860ms with vectors on against 226ms with
  them off — 123x for no edges.
- **Fix — the lane measures itself.** Neither disabled (it can pay where unresolved tokens are in-repo
  near-misses) nor unbounded. After 100 lookups with no hit it stops, and says so via `indexWarn`: a
  capability switching itself off silently is exactly what produced MCP-ISSUE-038. `vectorSearchSymbols` is
  also memoized, cleared on any vector write.
- **Measured:** `callResolveMs` 30023 -> **4485**, below the 4953 pre-regression baseline. Full-run wall on
  `wec.communication-hub` 62s -> **29.5s**, all nine edge types identical across three runs.
- **Note on the over-fetch:** MCP-ISSUE-035's deterministic tie-break raises k from 3 to 16, and raw KNN cost
  is roughly linear in k (11.7ms at k=3, 28.4ms at k=16, 95ms at k=64). That multiplier stands — it is the
  price of a reproducible cut — but is now paid 100 times per repo instead of once per token.

---

## MCP-ISSUE-037 — abstract/virtual base-class members have no dispatch fan-out, so every override looks dead

- **Status:** **FIXED** 2026-07-30, in two parts — see the update at the end. Found while verifying
  MCP-ISSUE-036: after two false-positive causes were removed, this is what the remaining `dead_code_scan`
  candidates turned out to be.
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

### Update 2026-07-30 — FIXED as two mechanisms, because the candidates are two populations

The entry above treated this as one problem. It is not, and building only the dispatch half would have left
half the false positives standing:

1. **Overriding an in-repo abstract/virtual member** — fixable, and now fixed by `EXTENDS` + fan-out.
2. **Overriding an EXTERNAL virtual member** — `Equals`, `GetHashCode`, `ToString`, `Dispose`,
   `OnModelCreating`. The caller is the BCL or a framework, so no in-repo edge can ever exist. No amount of
   inheritance modelling reaches these; suppression is the correct permanent answer.

**Part 1 — `heuristic_override_member` suppression.** `dead_code_scan` already models "I cannot tell" as
suppression, with `scanPolicy.note` stating that exclusion does not prove a symbol live — exactly the claim
being made. So the honest fix for the second population was a suppression reason, not an edge. Cost, stated:
a genuinely dead override inside a dead subclass is now hidden.

**Part 2 — `EXTENDS` + `base-class-dispatch`.** A distinct edge type rather than reusing `IMPLEMENTS`,
because C# allows one base class and many interfaces, and several tools read `IMPLEMENTS` as "satisfies an
interface contract" — folding them would make "how many interfaces does this implement" answer wrong without
changing its shape. `base:Name` tokens resolve in `resolveExtendsEdges`; unresolvable ones (ControllerBase,
DbContext) are tagged `external boundary`, as unresolvable interfaces already are.

**Two things this got wrong first, both worth recording:**

- **The fan-out was in the wrong phase.** It started inside `resolveCallEdgesBatch`, beside interface
  dispatch, and produced nothing. The template-method shape has the base calling its own abstract member *in
  the same file*, so `resolveIntraFileEdges` links it at EXTRACTION time and the edge never reaches the
  unresolved-token lane the batch resolver iterates. Hooking into that lane misses exactly the case this
  exists for. It is now its own pass over FINAL CALLS edges, covering both shapes without caring which phase
  created the edge.
- **An early return disabled the whole thing.** `if (localMethods.size === 0) return` was correct for the
  method-group branch it was written for and catastrophic beside this one: a FluentValidation validator is
  usually a class whose only member is a constructor. Only a test whose fixture also had no
  `method_declaration` caught it — a fixture with one incidental method would have passed and proven nothing.

**The gate that makes it safe:** only `abstract` and `virtual` members fan out, read off the stored
signature. A non-virtual base method is never overridden, so a same-named subclass method is a `new`/shadow —
a different method — and reaching it would attribute a call to code that cannot run. For `dead_code_scan` a
false "live" hides real dead code, the one direction of error it cannot afford.

**Measured on `wec.communication-hub`:** 136 override false positives suppressed, of which **12 are now
genuinely reachable** through dispatch rather than merely suppressed (matching 12 `base-class-dispatch`
edges). `EXTENDS` = 157. On `wec.be`: `EXTENDS` = 3796, 19 dispatch edges. The remaining 124 suppressions are
the external-override population, where suppression is the answer rather than a placeholder.

Covered by `test:base-class-dispatch`, 8 cases — three of them NEGATIVE, since the failure mode that matters
is over-reaching: a shadow method, a same-named method outside the hierarchy, and the base keeping its own
direct call (the fan-out must ADD reachability, not move it).

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

---

## MCP-ISSUE-042 — `refactor_replace_rollback` restores the files and leaves the graph holding the reverted names, while `health_check` reports "ready"

- **Status:** **FIXED** 2026-08-04 — see *What shipped* below. First observed 2026-08-03; re-verified on `411afe5` from a fresh process before the fix.
- **Scenario (exact repro, `wec.communication-hub` at `8fe717b`, clean tree):**
  1. `refactor_replace_preview{ find:"NormalizeToConversationCode", replaceExpression:"NormalizeToConversationCodeX", scope:{includePaths:["backend/CommunicationHub/src"]} }` → 3 matches / 3 files.
  2. `refactor_replace_apply` → `driftPercent 0`, `appliedReplacementsCount 3`. `git diff --stat` = 3 files, 3 insertions.
  3. `index_repository{ mode:"dirty" }` → graph now holds the new name (`query_graph`: `SELECT name FROM symbols WHERE name LIKE 'NormalizeToConversationCode%'` → `NormalizeToConversationCodeX`).
  4. `refactor_replace_rollback` → `restoredFilesCount 3`, `conflicts 0`; `git status` clean.
  5. **`query_graph` still returns `NormalizeToConversationCodeX`** — a symbol that exists in no file on disk.
- **Expected vs actual:** expected rollback to either re-index the restored files or mark the repo stale. Actual: `health_check` reports `codebaseState.status:"ready"`, `shouldReindex:false`, `reasons:[]`, `actionHints[0].reason:"Index appears up-to-date"`, and `staleness.isStale:false`.
- **Why staleness can't see it:** the check diffs `indexedCommitSha` against HEAD and inspects the working tree. Rollback restores the tree to HEAD, so both signals read healthy — the graph's divergence is invisible to both.
- **Impact:** every graph tool answers from a phantom name after a rollback, with no warning. This is the same failure *class* as MCP-ISSUE-040 (a graph that does not match reality while `status` says otherwise), reached by a supported operation rather than by a stale process.
- **Workaround (verified):** `index_repository{ mode:"incremental" }` immediately after any rollback — restores the correct symbol. `mode:"dirty"` does **not** work: the tree is clean again, so the changed-file set is empty.
- **Enhancement proposal:** have `refactor_replace_rollback` record the restored file list into the same pending-reindex set `dirty` mode consumes (so `mode:"dirty"` becomes sufficient), or have it mark those files' stored content hash invalid so `codebaseState` reports `stale` with `reasons:["files restored by rollback are not re-indexed"]`. Failing either, `refactor_replace_rollback` should return an `actionHints` entry recommending the incremental re-index — the response currently returns only `restoredFilesCount`/`conflicts`.

### What shipped 2026-08-04 — all three, because they are complementary rather than alternatives

A new `pending_reindex_files` table (`repositories/schema.ts`) is the **third staleness signal**. The
other two are both git-derived, and that is precisely why neither can see this: `getRepoStaleness`
compares the indexed commit sha against HEAD, the working-tree check shells out to `git status`, and a
rollback restores the *exact* pre-apply bytes — so HEAD matches and the tree is clean while the graph
still holds the applied names.

1. **Both halves of the refactor lifecycle record their writes.** Rollback writes `touchedFiles`
   (`tools/handlers/refactorApplyHandlers.ts`), apply writes its applied files
   (`tools/handlers/refactorApplyGate.ts`). Apply was survivable before — the tree goes dirty — but
   recording it keeps the two symmetric and survives a later commit/stash that cleans the tree.
2. **`health_check` reports `stale`**, ranked *above* `dirty` on purpose: a clean tree with a non-empty
   pending set is exactly the rollback case, and the one where nothing else in the response would
   report a problem. `reasons` names it, `codebaseState.pendingReindex` lists the files, and the
   `index_repository` action hint switches to `mode:"dirty"` — now the cheaper sufficient fix.
3. **`mode:"dirty"` unions the pending set** into the git changed-file set (`indexRunner.ts`), so the
   documented `mode:"incremental"` workaround is no longer required. The set is cleared once the run
   records, since the graph has now seen those files.
4. **Rollback returns `actionHints`**, so a caller who never runs `health_check` still learns of it.

Note the rollback handler is synchronous, so it structurally cannot await an index run — the
pending-set shape is required, not merely preferred. Round-trip pinned in
`src/repositories/crossRepoStore.test.ts`.

---

## MCP-ISSUE-043 — the guarded-refactor tools refuse work `refactor_replace_preview` does

> **Title corrected 2026-08-04.** It read "the owner-type prover cannot prove any site". That is true
> of Scenario B and **false of Scenario A**, whose sites never reach the prover at all. Both of the
> entry's own candidate root causes were wrong for A; see *Measured cause* below.

- **Status:** **FIXED** — 2026-08-04 for the lane being unusable and the refusal being illegible;
  **2026-08-05 for prover correctness** (B-13, see *Deferred* below, which now records the closure).
  First observed 2026-08-03; every half re-verified.
- **Scenario A — `refactor_symbol_migration` finds nothing where the plain preview finds three:**
  - `refactor_symbol_migration{ migrations:[{ fromSymbol:"NormalizeToConversationCode", toSymbol:"NormalizeToConversationCodeX", requiredOwnerType:"ConversationLoopCorrelationCodec" }], scopePaths:["backend/CommunicationHub/src"], dryRun:true }` → `totalMatches: 0`, `unresolvedOccurrences: 0`, empty `previewSummary`.
  - Same repo, same scope, same identifier via `refactor_replace_preview` → **3 matches**, each with a correctly resolved `ownerType` (`ConversationLoopCorrelationCodec`, `OutboundDeliveryFailedNotifier`, `ProcessOutboundSentConfirmCommandHandler`) and `confidence 0.95`. The declaring site's own owner type *is* the one that was required, so at least one match cannot legitimately be filtered out.
- **Scenario B — `change_value_representation` flags every site ambiguous under either owner type:**
  - `change_value_representation{ property:"HandledBy", requiredOwnerType:"ConversationAssignmentState", valueMap:{ai:"ConversationHandledBy.Ai", human:"ConversationHandledBy.Human"}, dryRun:true }` → `totalMatches 3`, `ambiguousOccurrences 3`, all three hunks `riskFlags:["ambiguous_target"]`.
  - Repeating with `requiredOwnerType:"Conversation"` gives the same 3/3 (recorded 2026-08-03). `ConversationAssignmentState` is the *declaring* type — `find_field_accesses("HandledBy")` reports exactly that in its `declaringType` field — so this is not a caller passing the wrong type.
- **Impact:** the entire guarded-refactor lane is unusable. Apply is blocked by default on `ambiguous_target`, so the safe, AST-based path for string→enum promotion degrades to `refactor_replace_preview` + a hand-written regex — the thing these tools exist to replace (see MCP-ISSUE-029 for what that costs).
- **Workaround:** `refactor_replace_preview` with a zero-width lookahead to constrain context, accepting that it has no owner-type guarantee.
- **Enhancement proposal:** make the prover's failure legible before making it stricter — return, per unmatched/ambiguous site, *which* owner type was inferred and which rule rejected it (`no_enclosing_type`, `inferred:X ≠ required:Y`, `initializer_target_unknown`). Two candidate causes worth checking first: (a) an object-initializer/`with`-expression site has no enclosing type to attribute, and (b) an owned-entity property is attributed to the owning entity in one code path and to the owned type in another — which is the same owner-semantics split filed as MCP-ISSUE-047.

### Measured cause 2026-08-04 — Scenario A never reached the prover

`refactorSymbolMigration.ts` hardcoded `symbolKinds: ["property", "field"]`, and in
`refactorPreviewBuild.ts` the **kind guard runs before the owner guard**. `inferSymbolKind` classifies
any `Name(` as `"method"`, so all three sites of a *method* migration were dropped before the owner
type was ever consulted — producing `totalMatches: 0, unresolvedOccurrences: 0`, indistinguishable
from "the identifier does not appear in scope". The tool was property/field-only by construction and
its description never said so. Neither candidate cause above was involved.

Scenario B *is* the prover, and the entry's proposal was right about what to do first.

### What shipped 2026-08-04

- **`symbolKinds` is now a caller parameter** defaulting to `[]` (any kind). The old behaviour is
  reachable by passing it explicitly. Tool description updated to say so.
- **Every guard rejection is reported.** `buildRefactorPreview` returns `rejectedSites`, each naming
  the rule that fired — `kind_not_allowed`, `no_enclosing_type`, `owner_not_allowed` — with the
  inferred owner and the required one. A silent `continue` is what made a 0-match result undiagnosable.
- **`verifyOwner` returns its rule**, not just a verdict: `receiver_not_identifier` (any nested path
  such as `conversation.Assignment.HandledBy`, which is permanently unprovable),
  `receiver_type_not_in_scope`, `no_enclosing_object_creation` (a bare assignment inside the declaring
  type, and `with` expressions). Surfaced as `ambiguousReasons` on `change_value_representation`.
- **`includeLowConfidence` is exposed** on both guarded handlers, which hardcoded it to `false`.
- **The response now states why apply is still blocked** (`applyBlockedNote`): `ambiguous_target` is a
  *risk flag*, and `isApplyRunnableHunk` rejects any hunk carrying one **regardless of
  `includeLowConfidence`** — which is why the workaround documented in five places (`CLAUDE.md`,
  `.claude/rules/mcp-hard-mode.md`, `orient.ts`, `docs/decision-tree.md`, the skill) works for
  `rename_assist` (mode `"text"`, no flag, merely low confidence) and cannot reach this lane.

### ~~Deferred~~ — `findOwnerType` was a category error → **FIXED 2026-08-05 (B-13, fifth wave)**

> This section described the state between 2026-08-04 and 2026-08-05. It is kept for the diagnosis;
> the closure is immediately below it. Do not read a current limitation out of the paragraph.

`refactorUtils.ts:findOwnerType` fell back to `findEnclosingClassName`, which returns *the class the
code sits in*, not *the type that owns the referenced member*. At a declaration site those coincide; at
a usage site they do not — which is why the three observed `ownerType` values were three different
enclosing classes, and why an `allowOwnerTypes` guard could match at most one of them. It also returned
null for any file with no `class` keyword, i.e. every top-level function.

**Closed by an AST prover, not a patch.** `src/services/refactor/ownerResolver.ts` is now the single
answer to "which type owns this site", and both lanes route through it — `refactorPreviewBuild`
(`refactor_replace_preview`, `refactor_symbol_migration`) and `analysis/valueRepresentation`
(`change_value_representation`), whose three private scope helpers moved into it rather than being
duplicated. `findOwnerType` is renamed `findEnclosingTypeNameByScan` and demoted to what it always
was: the non-C# fallback, labelled `enclosing_type_fallback` in the response so a scan is never
mistaken for a proof.

Rules, all C#: `declaration_site` · `initializer_type_match` · `receiver_type_match` (instance) ·
`implicit_this` (`this.M`, bare `M(...)`) · `base_type_receiver` · `static_type_receiver` (`Codec.M`
— the rule this entry needed) · `qualified_type_receiver` (`A.B.Codec.M`) · `receiver_member_type`
(one nested hop — Scenario B). Two repo-scoped lookups feed the last three
(`listCSharpTypeNames`, `listMemberDeclarations`), both lazy.

**Scenario A — measured live on `wec.communication-hub` @ `8fe717b`**, the repo and commit this entry
was filed from (full re-index, run `48413133`, 475 files / 4413 symbols / 48009 edges / 0 parse
failures, isolated DB). Same call as the repro:

| | as filed | now |
|---|---|---|
| `refactor_symbol_migration{requiredOwnerType:"ConversationLoopCorrelationCodec"}` | `totalMatches:1`, `rejectedSiteCount:2` | **`totalMatches:3`**, `rejectedSiteCount:0`, `unresolvedOccurrences:0` — all three at confidence `0.95` with **no risk flags**, i.e. appliable rather than merely visible |
| the two rejections | `inferred owner 'OutboundDeliveryFailedNotifier' != required` and the equivalent for `ProcessOutboundSentConfirm` — each caller's own class | gone; both sites now resolve to `ConversationLoopCorrelationCodec` via `static_type_receiver` |
| `refactor_replace_preview`'s `ownerType` at the same 3 sites | `ConversationLoopCorrelationCodec`, `OutboundDeliveryFailedNotifier`, `ProcessOutboundSentConfirmCommandHandler` | `ConversationLoopCorrelationCodec` ×3 |

The guarded tool and the unguarded one now agree at 3, which is what "the guard is usable" means.

**Scenario B — the *shape* is fixed; this repo's three sites are a different shape and are not.** Be
precise about this, because the fixture and the live repo disagree for a real reason:

- The two-hop receiver `conversation.Assignment.HandledBy` — the shape this entry named — resolves,
  proven in `scripts/test/test-owner-prover.mjs`: owner `ConversationAssignmentState` via
  `receiver_member_type`, and `requiredOwnerType:"Conversation"` **rejects** it rather than flagging
  it ambiguous.
- The three live sites are **not** that shape. All three are in
  `tests/Application.UnitTests/…/GetCustomerConversationDetailQueryHandlerTests.cs` — two are
  `var smsMap = Assert.Single(…); … smsMap.HandledBy` (a `var` local initialised from a **method
  call**, so no declared type to read) and one is `detail.ChannelConversations[0].HandledBy` (an
  **element access** receiver). Both need return-type / generic-element inference, neither of which
  this prover does. They remain `totalMatches:3, ambiguousOccurrences:3` — unchanged — but now each
  names its rule (`receiver_type_not_in_scope`, `receiver_not_identifier`) instead of being an
  unexplained ambiguity. Worth noting the original repro also asked for the wrong owner: these are
  DTO assertions, so neither `ConversationAssignmentState` nor `Conversation` owns them.

Reverting the static-receiver rule to the enclosing type reproduces `totalMatches:1` and the
`'Notifier'`/`'Handler'` rejections exactly, and fails 4 harness assertions — so the harness is
evidence, not decoration.

**Known gaps, named rather than left to be rediscovered.** A receiver typed only by a method's return
value (`var x = Factory.Make(); x.M`) is `receiver_type_not_in_scope`; an element-access receiver
(`list[0].M`) is `receiver_not_identifier`. Both need inference this prover does not do, both are
reported with their rule, and neither is ever attributed to a wrong type — which is the property that
matters, since a wrong `verified` is what B-13 existed to remove.

**One contract change, deliberate.** An owner that cannot be *proven* is no longer a silent drop. It
is kept, flagged `ambiguous_target` (so `isApplyRunnableHunk` still blocks apply) and explained in a
new `ambiguousReasons` array — the shape `change_value_representation` already used, now shared by the
whole lane. Only a **proven different** owner lands in `rejectedSites`. So `totalMatches` can rise for
a C# caller using an owner guard, with `unresolvedOccurrences` accounting for the delta, and
`refactor_replace_preview` surfaces both arrays where it previously surfaced neither.

---

## MCP-ISSUE-044 — `find_entry_points(kind:"route_handler")` returns a count with empty arrays; `route_map` names the endpoint group, not the handler

- **Status:** **FIXED** 2026-08-04 — all three proposals shipped; see below. First observed 2026-08-03, unchanged until then.
- **Scenario:** `find_entry_points{ repoId:"wec.communication-hub", kind:"route_handler", limit:5 }` → `{"total":5,"runtimeEntryPoints":[],"graphEntryPoints":[]}`. A total of 5 with nothing to show it in; the documented fast-path ("surface C# ASP.NET route handlers from the routes table") returns no rows through this tool.
- **Scenario (second half):** `route_map` and the `repo://wec.communication-hub/routes` resource both return all 34 routes with `handlerSymbolId == controllerSymbolId` — the endpoint **group** class (`Conversations`, `Customers`, `Inbox`), never the delegate that handles the route. `routeTemplate` omits the `MapGroup` prefix (`{conversationId}/reply`, not `/api/conversations/{conversationId}/reply`), and normalization is inconsistent inside one payload: `Conversations.cs` templates have no leading slash while `Inbox.cs` templates do (`/conversations`).
- **Also:** 6 of the 34 routes come from test files (`AuthPolicyIntegrationTests.cs`, `MyAuthTestSupport.cs`, `PlaybookAlignmentIntegrationTests.cs`) with no way to exclude them — see MCP-ISSUE-049.
- **Impact:** "what is this service's API surface" cannot be answered from the index. Every route resolves to the same handful of group symbols, so route → handler → call-graph is a dead end, and the templates cannot be matched against real request paths or against `docs/04-api/ch2-fe-api-contract.md`.
- **Workaround:** `route_map` for the file/line, then `find_symbol_at_line` on that line to get the actual delegate; reconstruct the prefix by reading the `MapGroup` call at the top of the endpoint file.
- **Enhancement proposal:** (1) make `find_entry_points` put the route rows it counted into `runtimeEntryPoints` (a `total` that matches no returned array is worse than an error — nothing downstream can act on it); (2) attribute minimal-API routes to the lambda/method passed to `MapGet`/`MapPost` rather than the enclosing group class; (3) resolve `routeTemplate` against the enclosing `MapGroup` and emit one normalized absolute path.

### What shipped 2026-08-04

1. **The count and the arrays can no longer disagree.** The route fast-path stamps a *third*
   `entryReason` (`"route_handler"`) and returns early, while the handler partitioned on only two
   values — so every route row was counted and none emitted. Route rows now get their own
   `routeEntryPoints` array, and **`total` is derived from what is actually emitted**, with an
   `unclassifiedEntryPoints` catch-all, so a fourth reason cannot reintroduce the same hole.
2. **Handlers are resolved from the delegate argument.** `csharpRoutes.ts` set
   `handlerSymbolId = classSymbolId` for minimal API inside a class. The hub's endpoint files pass
   **method groups** (`groupBuilder.MapPost("{conversationId}/reply", Reply)`), so the delegate resolves
   to a real method symbol for all 34 routes; a lambda falls back to the enclosing registration method,
   and only then to the group class. The top-level lane's `module:<filePath>` placeholder — a literal
   string that could never join `symbols`, hence `handlerName: null` — is replaced by the file's real
   module symbol id.
3. **The group prefix is resolved by convention.** `resolveMapGroupPrefix` only reads a *local*
   `var g = app.MapGroup(...)` declarator, and the hub receives an already-grouped `RouteGroupBuilder`
   **as a parameter**, which has no declarator — hence `{conversationId}/reply` instead of the real path.
   A parameter-typed builder now falls back to the class's declared `RoutePrefix` property
   (`IEndpointGroup`), giving `/api/v1/conversations/{conversationId}/reply`.
4. **Templates are normalized, case-preserved.** A new `normalizeRouteTemplate` collapses separators and
   guarantees one leading slash — deliberately *not* `normalizeEndpointPath`, which lowercases (right for
   a contract id, wrong here: it would turn `{conversationId}` into `{conversationid}`). Applied only
   when the result is genuinely absolute, so a template whose prefix could not be resolved stays
   relative rather than masquerading as a real path.

Route rows are extraction-time, so this needs a re-index to take effect. The test-file routes noted
above remain — that is the MCP-ISSUE-049 test-filter item.

---

## MCP-ISSUE-045 — cross-repo resolution matches bare type names, so `Task` links every repo to one unrelated class

- **Status:** **FIXED** 2026-08-04 — see below. **New** when filed; not previously reported.
- **Scenario:** `query_graph{ sql:"SELECT from_symbol_id, to_repo_id, to_symbol_id, type FROM cross_repo_deps WHERE from_repo_id=:repoId LIMIT 10" }` on `wec.communication-hub` → 7 of 10 rows point at the same `to_symbol_id` (`2e1d3ffff6aa4656e787707d`). Resolving it: `get_cross_repo_impact{ symbolId:"00031af4f1504af45a0e4c0a", direction:"outbound" }` → `relatedName:"Task"`, `relatedFilePath:"src\\SSNet.QueueManagement\\Domain\\Model\\Task.cs"`, `relatedSignature:"public class Task"`, `contractType:"symbol"`, **`resolutionReason:"symbol_id_exact_match"`**.
- **Expected vs actual:** the consuming symbol is a Hub integration test using `System.Threading.Tasks.Task`. Expected: no cross-repo edge (a BCL type is not an ssnet contract). Actual: an edge to an unrelated domain class in `SSNet.QueueManagement`, presented with the highest-confidence reason string the tool has.
- **Impact:** cross-repo counts are noise. `crossRepoLinked: 8` on the full run is mostly this one false target, and the number moves with run mode (`crossRepoResolved` 8 on `full` vs **459** on `dirty` over 3 files — see MCP-ISSUE-048), so it cannot be used as a coverage signal or a data-contract gate. `get_cross_repo_impact` inherits the falsehood.
- **Workaround:** for contract questions use `get_value_contract_impact` (literal-based, verified correct on `"call_log"` across hub+ssnet) or `find_package_consumers` + the `nuget:` edge query, and ignore `cross_repo_deps` type rows whose name is a BCL type.
- **Enhancement proposal:** require more than a name match to cross a repo boundary — namespace agreement (the consumer must `using` a namespace the provider repo actually declares), exclusion of BCL/framework type names, or a provider-side `module` symbol carrying the package contract id (the bridge ISSUE-CR-001 describes). Whatever the rule, `resolutionReason` should distinguish "matched by symbol id" from "matched by bare name", because those are not the same claim.

### What shipped 2026-08-04 — the denylist, plus honest provenance

- **Framework types no longer cross a repo boundary.** `edgeResolverRefs.ts` gates the
  `findProviderSymbolByName` fallback on a new `isKnownExternalTypeName`, which reuses the existing
  `KNOWN_EXTERNAL_TYPE_RECEIVERS` set (it already contained `Task`, `CancellationToken`, `ILogger`,
  `IServiceCollection`). A namespace-qualified raw token is also checked, so
  `System.Text.Json.JsonSerializerOptions` is excluded on its namespace rather than its last segment.
  The gate runs **after** same-repo `pickBestNamedCandidate` has failed, so it cannot affect resolution
  within a repo — and a cross-repo link to a framework type is never correct anyway. The function's own
  doc comment already said the intent was to avoid "cross-repo links to framework types that do not
  exist"; the code did the opposite in a multi-repo DB.
- **Deliberately NOT done: widening `isKnownExternalToken` itself.** The CALLS lane calls it on bare
  *method* names, and that set contains `Log`, `Is`, `Has`, `Type`, `String` and `Mock` — accepting bare
  names there would silently suppress real call edges. Hence a separate, narrowly-scoped export.
- **`resolutionReason` tells the truth.** `get_cross_repo_impact` derived its reason from the related
  symbol's *signature*, so a bare-name guess at confidence 0.65 was reported as
  `symbol_id_exact_match` — the strongest reason string the tool has. The originating edge's `reason` is
  the only place that distinction survives (`cross_repo_deps` has no `reason` column), so the query now
  reads it via a scalar subquery and reports `cross_repo_bare_name_match`. No migration needed.
- **Namespace agreement remains the durable rule** and is not implemented here; the denylist is what
  closes the reported falsehood. See also the phase-ordering fix in MCP-ISSUE-048, which addresses the
  full-vs-dirty count inversion this entry points at.

### Second defect, found by verifying the first: `cross_repo_deps` was append-only

The denylist shipped, a full re-index ran — and `Task` still had **408** links (worse than the
7-of-10 this entry reported, because the sweep sampled only 10 rows). The gate was working; the table
was not being rebuilt.

`cross_repo_deps` is written with `insert … on conflict do nothing` and **had no delete path anywhere
in `src/`**. It was append-only for the lifetime of the database, so every link created by an earlier,
wronger rule survived indefinitely. The run that "fixed" it resolved 123 links while the table held
522 — the arithmetic alone shows it was never rebuilt.

A resolution rule that cannot heal the rows it already wrote is not a fix. A **full** run now clears
this repo's outbound links before re-resolving (`clearOutboundCrossRepoDeps`, called from
`indexRunner`). Scoped two ways on purpose: `from_repo_id = this repo`, because rows pointing *into*
this repo belong to the other repo's run; and full runs only, because a dirty/incremental run
re-extracts a subset and would drop links whose source files it never examined.

**Generalizable lesson:** the same shape exists wherever a derived table is written with
`on conflict do nothing` and no delete — the graph can only ever accumulate, so corrections do not
propagate and no amount of re-indexing heals it. `edges` and `symbols` are rebuilt per file and
`pruneOrphanedEdges`/`pruneStaleFiles` cover the rest; `cross_repo_deps` was the one that had neither.

---

## MCP-ISSUE-046 — `find_package_consumers` returns the files that DEFINE the package, and a wrong name returns 0 silently

- **Status:** **FIXED** 2026-08-04 — both halves; see below. First observed 2026-08-03. Sharpens ISSUE-CR-001, which reported the
  `resolved:false` bridge gap but treated the 8 returned rows as consumers.
- **Scenario:** `find_package_consumers{ packageName:"SSNet.CommunicationHub.Messaging" }` → `consumerCount: 8`, and all 8 are in the **provider** repo: `ssnet` `src\SSNet.CommunicationHub.Messaging\Contracts\{Automation,Campaign,ConversationReply,EmailSent,EmailDeliveryFailed,EscalationRequired}*Contract.cs`, `consumerKind:"module"`, `dependencyReason:"namespace package contract bridge"`, `resolved:false`, backslash paths.
- **Expected vs actual:** the actual consumer is `wec.communication-hub`, which holds **34** `DEPENDS_ON` edges to `nuget:ssnet.communicationhub.messaging` (`query_graph`: `SELECT to_id, COUNT(*) FROM edges WHERE type='DEPENDS_ON' AND to_id LIKE 'nuget:%' GROUP BY to_id`). It appears nowhere in the result. The rows returned are the files that declare the contracts.
- **Second defect in the same call path:** a package name that does not exist returns `{"consumerCount":0,"consumers":[]}` with no diagnostic — `find_package_consumers{ packageName:"SSNet.Messaging.Contracts" }` (a plausible-looking wrong name) is indistinguishable from a real zero. The correct id was only findable via the `edges` query above.
- **Impact:** the tool answers the inverse of the question asked. "Who consumes this contract" is the pre-change gate for a contract bump, and acting on this output would mean reviewing the publisher instead of the consumers.
- **Workaround (verified):** the `nuget:` `DEPENDS_ON` query in `query_graph` — it gives both the exact contract ids and the consuming repos, and is unaffected by the bridge state.
- **Enhancement proposal:** (1) return rows keyed by the repo holding the `DEPENDS_ON` edge (consumer side), and if provider definitions are useful keep them in a separate `providers[]` array rather than mixing them into `consumers[]`; (2) when the normalized `packageContractId` matches no `to_id` in any repo, say so (`unknownPackage: true` plus the nearest known ids) instead of returning an empty success.

### What shipped 2026-08-04 — both proposals, exactly as written

- **The publisher is excluded from `consumers[]`.** Two lanes write the `from_id` side of a
  `DEPENDS_ON` edge and one fires *inside* the publishing repo: `dotnetProjectParser` emits the `.csproj`
  that declares the `PackageReference`, and `csharpSymbols` emits a "namespace package contract bridge"
  edge for every file whose `using` maps to the contract — including the provider's own contract files,
  which `using` their siblings. The publisher is identifiable because `dotnetProjectParser` *also* emits
  a `module` symbol whose `signature` **is** the contract id, so a `not exists` on that (plus `distinct`)
  drops any repo that exports the contract it appears to consume. The fact was already in the DB and
  simply unused.
- **Providers are reported separately** (`providers[]`, `providerCount`), not mixed into `consumers[]`
  where they answer the opposite question.
- **The exclusion is never silent.** `excludedPublisherRows` reports how many rows it dropped.
- **An unknown package says so.** A `packageContractExists` probe drives `unknownPackage: true` with an
  unconditional hint. The old `didYouMean` suggester could not close this gap because it is
  prefix-anchored: a name wrong in its *first* segment yields no suggestions, and the hint was spread
  only when suggestions existed — so `{"consumerCount":0,"consumers":[]}` was byte-identical to a real
  zero. A third message distinguishes "indexed, but only the publisher references it".

**Measured against the live graph.** The entry's `consumerCount: 8` did not reproduce — the index had
moved on, and the contract had 110 `DEPENDS_ON` edges (ssnet 64, `wec.communication-hub` 34, `wec.be` 12)
with the tool returning 100 (limit-capped). With the fix: **46 consumers** — the hub's 34 and wec.be's 12,
i.e. exactly the 34 the entry said "appear nowhere in the result" — and ssnet's 64 excluded. Of those 64,
44 are in the publishing project and 20 in that package's own test project, so nothing legitimate was
dropped here; a monorepo where a *different* project consumes a sibling's package would show up in
`excludedPublisherRows`. Pinned in `src/repositories/crossRepoStore.test.ts`.

---

## MCP-ISSUE-047 — `get_persistence_mapping` dumps every CHECK constraint in the repo, ignores `profile`, and disagrees with `find_field_accesses` about "owner"

- **Status:** **FIXED** 2026-08-04 — all three; see below. Constraint dump first observed 2026-08-03; the `profile` and owner-semantics halves were **new** when filed.
- **Scenario A — unfiltered constraints:** `get_persistence_mapping{ property:"HandledBy", ownerType:"Conversation" }` returns the correct mapping (`handled_by`, `hasConverter true`, `maxLength 16`) **and all 24 `HasCheckConstraint` rows in the repository** — `ck_tenant_configs_timeout_hours`, `ck_outbox_status`, `ck_customer_inbox_status_logs_*`, … — none of which involve `HandledBy` or `Conversation`. This is the largest single token payload of the 43-tool sweep, and it is the same list for every property queried.
- **Scenario B — `profile` ignored:** the same call with `profile:"nano"` returns the identical full payload. Every other profile-aware tool trims; this one does not.
- **Scenario C — two tools, two definitions of "owner":** `find_field_accesses{ name:"HandledBy" }` reports `declaringType:"ConversationAssignmentState"` (correct: the property is declared on the owned type). Passing that value back in — `get_persistence_mapping{ property:"HandledBy", ownerType:"ConversationAssignmentState" }` — returns `mappings: []` while still dumping all 24 constraints. Only `ownerType:"Conversation"` (the EF-configured owner) yields the mapping. An agent chaining the two tools, which is the natural workflow, gets an empty answer that looks like "not persisted".
- **Impact:** A: token waste plus a real risk of misreading an unrelated constraint as the property's. C: silent false negative on the exact question the tool exists to answer, and the same owner-semantics split is a candidate root cause for MCP-ISSUE-043.
- **What still works well (not a regression):** the projection-trap detector — `DB_TRANSLATED_PROJECTION` at `GetCustomerConversationDetail.cs:89` with the correct explanation. Keep it.
- **Enhancement proposal:** (1) filter `checkConstraints` to constraints whose expression names the mapped column (or the owner's table), and put the repo-wide list behind `profile:"verbose"`; (2) honour `profile`; (3) accept either the declaring type or the EF owner for `ownerType`, resolving owned-entity relationships, and when a requested owner yields no mapping say which owners *do* have one instead of returning `[]`.

### What shipped 2026-08-04 — all three proposals

**A — constraints.** Three compounding defects in `efPersistence.ts`, all fixed:
`columns` was derived from the property matches *without* the owner filter (the mappings right beside it
*were* owner-filtered); an empty set meant **"surface all"**, so a property with no explicit
`HasColumnName` returned every constraint in the file — which for a single large `DbContext` is every
constraint in the repository, identical for every property queried; and matching was
`expression.includes(column)`, so `status` matched inside `inbox_status_logs`. Now: owner-filtered
columns, the property name as EF's *implicit* column instead of a wildcard, and a word-boundary
case-insensitive test. Non-matching constraints appear as `unrelatedCheckConstraints` at
`profile:"verbose"` only.

**B — `profile`.** This was the only read handler in `tools/handlers/` with no `nano`/`compact` branch,
so `nano` returned the full payload including every 160-char snippet and prose `detail`. Both branches
added, modelled on `find_field_accesses`.

**C — owner semantics.** The two tools disagreed because `find_field_accesses` resolves a name through
`getSymbolCandidates` (case-insensitive **substring** LIKE) while this one matched exactly and
case-sensitively, twice. Now: case-insensitive property matching with `resolvedProperty` echoed, and
`ownersWithMapping` listing every owner that maps the property. When a requested owner yields nothing but
others do, the response says so explicitly rather than returning `mappings: []` — which read as "not
persisted" and is the failure an agent chaining the two tools hits. `find_field_accesses` also now echoes
`nameResolution` when the name it resolved differs from the one asked for, so a substitution
(`owner` → `Owner`/`OwnerId`) is visible.

**Kept:** the projection-trap detector, unchanged, per the entry's note.

---

## MCP-ISSUE-048 — index-run counters contradict the database and each other

- **Status:** **FIXED** 2026-08-04 — all five; see below. The internal contradictions were first observed 2026-08-03, the DB mismatch was **new** when filed.
- **Scenario:** one `index_repository{ mode:"full" }` on `wec.communication-hub` (run `f4119319`), then reading the same numbers back from the graph.

  | claim | run report | `query_graph` / resource |
  |---|---|---|
  | edges | `edgesUpserted: 49582` | **47998** (sum of `SELECT type, COUNT(*) FROM edges GROUP BY type`, and `repo://…/schema` `edgeCount`) |
  | wall clock vs phase | `elapsedMs: 15924` | `resolvePhaseMs: 22270` — a phase longer than the run that contains it (dirty run: **1055** vs **22241**) |
  | call coverage | `resolveCallsCoverage: 1.0446` | a ratio above 1.0 |
  | unresolved calls | `callEdgesUnresolved: 0` | `unresolvedCallsTotal: 14420` in the same object |
  | cross-repo | `crossRepoResolved: 8` (full, 521 files) | **459** (dirty, 3 files) — fewer files, 57× more links |

- **Impact:** these are the numbers a reviewer uses to decide whether an index run is trustworthy, and MCP-ISSUE-040's fix (`degraded` when a run produces symbols but zero edges) is built on the edge counter. A counter that disagrees with the table it wrote cannot support that gate. `symbolsUpserted` (4457) and `filesIndexed` (521) do match the DB, so the problem is specific.
- **Workaround:** treat `query_graph` / the `schema` resource as the source of truth for graph size; ignore `elapsedMs`, `resolveCallsCoverage` and the cross-repo counters entirely.
- **Enhancement proposal:** name each counter for what it counts — `edgeUpsertAttempts` vs `edgesStored` (the delta is presumably deduped/replaced rows, which is fine, but not what `edgesUpserted` reads as); make `elapsedMs` span the resolve phase or rename it `extractionMs`; clamp/rebase `resolveCallsCoverage` on the same denominator as `callEdgesAttempted`; and make `callEdgesUnresolved` agree with `unresolvedCallsTotal` or explain the difference in the field name. The cross-repo full-vs-dirty inversion is probably a scoping bug worth its own investigation (see MCP-ISSUE-045, which suggests the links themselves are unsound).

### What shipped 2026-08-04 — new fields alongside the old names, nothing renamed

Renaming would have changed the `index_repository` response contract, so each misleading number keeps
its name and gains an honest neighbour. Per-claim:

| claim | fix |
|---|---|
| edges 49582 vs 47998 | `edgesUpserted` counts `extracted.edges.length` at **extraction** time, so it can never equal the table. Added `symbolsInGraph`/`edgesInGraph` (read back after the run), plus `edgesDeduplicated`, `edgesPruned` and `filesPruned` — which were already computed, logged, and thrown away. Those two deletions are what made the delta unaccountable. |
| `elapsedMs` < `resolvePhaseMs` | `elapsedMs` came from the pipeline and stopped before the post-phase; `indexRunner` copied it through. It now spans the whole run (`runStartedMs`, already in scope), and the pipeline's figure is preserved as `extractPhaseMs`. Containment now holds: measured `elapsedMs 1411 > extractPhaseMs 1151 > resolvePhaseMs 136`. The near-equality of the full and dirty figures was **not** a shared counter — the post-phase is repo-wide in every mode, so a 3-file dirty run pays the same resolve bill. |
| `resolveCallsCoverage` 1.0446 | Root cause was the **numerator**, not the ratio: `resolveCallEdgesBatch` returned `result.changes` (rows — and `edges` has no unique index, so one pair can be several rows) **plus** `+1` per newly inserted interface-dispatch edge, while the denominator was `select distinct from_id, to_id`. It now returns **pairs**; rows and dispatch inserts are reported separately as `callRowsUpdated`/`dispatchEdgesInserted`. The ratio is clamped as a backstop only. |
| `callEdgesUnresolved: 0` vs `unresolvedCallsTotal: 14420` | A consequence of the numerator above: `max(0, attempted − resolved)` went negative and clamped. With a pair-level numerator the partition holds arithmetically. The measured remainder is reported separately as **`callEdgesUnresolvedInGraph`** — deliberately a different name, because it is *not* a partition of `attempted`: on the smoke repo it is 2082 against 236 attempted, since most `callee:` placeholders are external/BCL targets that were never resolution candidates. (An earlier attempt redefined `callEdgesUnresolved` to this measured value; `scripts/smoke-test.mjs` caught it by asserting the partition, which is why the invariant is worth keeping.) |
| crossRepo 8 (full, 521 files) vs 459 (dirty, 3 files) | Two causes, both fixed. The population query excluded only `import:`/`callee:`, so `type:`/`iface:`/`property:`/`base:` placeholders flooded its `limit 5000` window — on a full run the graph is full of freshly extracted ones, so the sample was spent on tokens that cannot cross a repo boundary. All four are now excluded. And `safeCrossRepoResolve` ran **before** the call/type/implements resolvers; it now runs last, so its population is what genuinely could not be resolved locally — which is the only population where a cross-repo bridge is the right answer. |

**Persistence gaps** (the "contradict each other" half): counters the response reported and `index_runs`
never stored, so `health_check.latestRun` disagreed with the run's own report — `parse_timeouts`,
`edges_dropped_by_confidence`/`_call_cap`/`_type_ref_cap`, `health_reasons`, `skip_reason`, and
`index_version` now have columns and are written. `vector_symbols_indexed` had a column that `recordRun`
never wrote. `getLatestRun` stops aliasing one column to two names and re-deriving the unresolved count
with the same broken subtraction; a pre-fix row falls back to the legacy alias. Pinned in
`src/repositories/runStore.test.ts`.

`index_version` turned out to be a **separate live defect**, filed as MCP-ISSUE-050.

---

## MCP-ISSUE-049 — ten papercuts found by the same sweep

- **Status:** **FIXED** 2026-08-04 — all of them, plus the two adjacent defects the triage notes had
  left open (`groupBy` ignored under `view:"surface"`, and the intent-ranking correction). One item
  stays **refuted**; the stale example that caused it was already corrected. See *What shipped* below.
  **Two sub-items survived** the consumer's re-verification against `dist` 16:40:22 and were **fixed
  in a fourth wave the same day**: nano `topEdges` now carries `fromId`/`toId`, and `mode:"stale"`
  clears — but *not* for the reported reason. The relabelling fix below was already correct in that
  build; `doc_mentions` was an **append-only table** whose primary key includes `mention_type`, so
  the correction inserted a row instead of replacing one and the legacy `backtick` row outlived every
  re-index. It is now replace-per-file, and `pruneFiles` gained the delete it never had. Two further
  parser defects surfaced while confirming it — see *Fourth wave* in the Index section for the
  mechanism, the two-pass regression tests, and why the original verification could not have caught
  this.
- **Original status:** PARTLY OPEN 2026-08-04. Grouped deliberately: each is small, none is a wrong answer to a
  correctness question, and they share two roots — response shaping and the absence of a test filter.
  Split any of them out if it gets picked up.
- **Triage 2026-08-04:** nine of the ten were reproduced against the code; **one is refuted** (see the
  struck item below). Two were addressed in passing by other fixes in the same change set: the
  `route_map` test-route noise is bounded by MCP-ISSUE-044's re-extraction, and the path-style item's
  `rename_assist` half is unchanged. The rest are open — they are response-shaping work with no
  correctness consequence, and are the third wave of this triage.
- **Identity dropped by profile (2):** `get_call_chain{ profile:"nano" }` returns `chainLength: 10` with `path:[{confidence:0.75}, {via:"interface", confidence:0.7}, …]` — no name, file or id on any hop, so the response cannot be acted on. At `profile:"compact"` the same tool returns only `fromId`/`toId`, forcing a second call to resolve names, while `get_dependency_graph` compact resolves names for the same edges. Note the fix is per-handler, not global: `get_symbol_context_pack{ profile:"nano" }` keeps full identity and is the model to copy.
- **Duplicate rows (3):** `trace_execution_flow{ profile:"nano" }` → `topCallees:["Equals","NotifyAsync","TryResolveByBridgeMessageIdAsync","Failure","NotifyAsync","NotifyAsync","SaveChangesAsync","Success","NotifyAsync","SaveChangesAsync"]` (NotifyAsync ×4). `get_dependency_graph{ filePath }` emits self-TYPE_REFs (`OutboundDeliveryFailedNotifier → OutboundDeliveryFailedNotifier`) and lists every ctor-injected interface twice, once from the constructor symbol and once from the class. `find_impact_files` lists each caller once per edge type (`Resolve` appears as CALLS and as TYPE_REF).
- ~~**`view:"surface"` ignored (1):** `find_impact_files{ view:"surface" }` returns the `files`-view shape (a `callers[]` array), not the external-symbol surface the schema documents.~~
  **REFUTED 2026-08-04.** The handler *does* branch on `args.view === "surface"`, and its payload is the
  documented surface: `callers[]` of `{callerName, callerFile, callerLine, symbolAffected, edgeType,
  confidence}`, filtered `where sf.file_path != s.file_path` — external symbols calling into this file,
  which is what `tools/graphImpact.ts` promises. It is also *not* the files shape, which returns
  `impactedFiles[]`. A `callers[]` array **is** the surface view, not the files view.
  The real defect was a stale example response in `docs/examples.md` showing
  `{ files: [{ filePath, callerSymbols }] }` — keys that exist nowhere in the code, and the likely origin
  of this report. That example is now corrected. No handler change was needed.
  *(Adjacent, genuine, and still open: `groupBy` is silently ignored when `view:"surface"` — the surface
  branch returns before `args.groupBy` is ever read, so `find_impact_files{view:"surface",
  groupBy:"module"}` returns an ungrouped list with no note.)*
- **No way to exclude tests (1, six tools):** `find_implementations` (2 of 3 results are test doubles), `route_map` (6 of 34 routes), `search_literals`, `get_symbol_context_pack` callers (5 of 6), `get_value_contract_impact` (3 test files classified as producers), and `get_feature_bundle` — which put `ConversationNotesCommandHandlerTests` in the `command` role and resolved `dbSet` to `TestDbContext` in a test file. `search_symbols` already has `excludeTests`; the flag needs to reach these.
- **`query_docs` envelope varies by mode (1):** `mode:"search"` returns an object (`repoId`, `mode`, `count`, `results`); `mode:"coverage"` and `mode:"stale"` return bare arrays. Same tool, three shapes.
- **`query_docs` precision (1):** `mode:"search"` returns `contentType:"symbol"` rows whose `text` is a file pointer (`"0004-autoreply-confidence-threshold.md @ line 1"`) rather than the matching doc section, and mixes code symbols into doc results. `mode:"stale"` still matches bare identifiers: symbolId for `ConversationLoopCorrelationCodec.Parse` → 5 hits, all in `docs/02-flows/_archive/*`, matched on the word `Parse` inside quoted C# in an archived doc.
- **Path style is split (1):** tool responses normalize to forward slashes, but the `repo://…/routes` resource, raw `query_graph` rows, `find_package_consumers.consumerFilePath`, `get_cross_repo_impact.relatedFilePath` and `rename_assist.hints` return backslashes — `rename_assist` returns both conventions in one payload (`affectedFiles` forward, `hints` back).
- **`health_check` without `repoId` reports misleading zeros (1):** `vectorIndex.symbolsIndexed: 0` and `codebaseState.status:"unknown"`; the same call with `repoId` gives `2664` / `"ready"`. The zero reads as "the vector index is empty", which is what it looked like at the start of this sweep.
- **Intent ranking is dominated by EF migrations (1):** `search_symbols{ query:"send outbound email via crm callback", strategy:"intent" }` → the top 5 are all migration `Up`/`Down` methods (`AddSenderEmailToCrmRefs`, `AddOutboundConfirmTrackingConsolidated`, …). `orient{ intent:"what breaks if I change the HandledBy property on Conversation", seed:"HandledBy" }` classifies correctly (blast-radius → `find_impact_files`/`change_impact`) but seeds the same way: migration `Up`/`Down` above `ConversationHandledByValues.ToStorageValue` and `Conversation.MarkHandledByHuman`. Migration class names carry the vocabulary of every schema change ever made; they should be down-weighted the way test paths already are.
- **Two tools, two symbol counts (1):** `get_file_context` reports `symbolCount: 7` and `get_file_summary` `symbolCount: 6` for `ConversationLoopCorrelationCodec.cs`; the module pseudo-symbol is counted in one and not the other.
- **`rename_assist` advisory omits the declaring file (1):** `affectedFileCount: 2` (the two caller files) where `emitPreview:true` correctly includes the declaring file as well — 3 files. The advisory understates the blast radius of the rename it is advising on.

- **Correction to the intent-ranking item:** down-weighting migrations "the way test paths already are"
  would be **inert**. `TEST_PATH_PENALTY` only feeds `confidenceRaw`, which is the *second* sort key,
  while the primary key is raw `matched` — so the existing test penalty lowers the reported score
  without moving the row. The actual discriminator is the name-length tie-break: `Up` and `Down` are the
  shortest method names in any EF repo, so migrations win every coverage tie. A fix has to make
  demotion the primary key, which repairs the latent test-path no-op at the same time. Also note the
  pool query itself is `order by length(s.name) limit fetchLimit`, so long relevant names can be
  discarded before scoring runs, and `search_symbols` reproduces this only with `ranked:true` (`orient`
  is affected unconditionally).

  **Correction to that correction (2026-08-04, while fixing it):** "lowers the reported score without
  moving the row" is **too strong**. `confidenceRaw` *is* the second sort key, so within a tie on
  `matched` the test penalty does reorder — and coverage is identical across a `matched` tie, which
  makes `kindBonus` and `testPenalty` the only terms that differ there. What is true, and is the real
  defect, is that the penalty is **powerless across** a `matched` difference: a migration matching one
  more token than the production symbol outranks it however heavily it is penalized, and a business
  phrase matches migration class names on *more* tokens than anything else precisely because those
  names are a log of every schema change ever made. Measured on the fixture now pinned in
  `test-search-ranking.mjs`: the migration matches **4** tokens of
  `"conversation assigned outbound email"`, the production notifier **3**. The rest of the correction
  holds and both halves of it were fixed.

### What shipped 2026-08-04 — per item

| item | fix |
|---|---|
| identity dropped at nano/compact (2) | Root cause was the **query**, not the shaping: `getCallEdges`/`getDependencies` selected ids only, while `getModuleFlow` — same table, same join — selected names, which is why `get_dependency_graph` could label edges and `get_call_chain` could not. Both now resolve endpoints through one shared SQL fragment (`RESOLVED_ENDPOINT_COLUMNS`/`_JOINS`), typed as the new `ResolvedEdgeRecord`. The join is LEFT, so an unresolved `callee:` hop still appears with null identity rather than vanishing. nano hops gained `symbolId`; compact stopped emitting raw rows. |
| duplicate rows (3) | `trace_execution_flow{nano}`: dedupe moved **before** the 10-item slice — the cap was being spent on repeats, so distinct callees never made the list. `getModuleFlow`: self-references (`fromId === toId`) dropped and endpoints deduped on `(source file, target, type)` — keyed on the *file*, not `fromId`, because the two rows differed only in whether the edge hung off the constructor or its class. Both report what was collapsed (`collapsed.selfReferences`/`.duplicateEndpoints`) rather than shrinking silently. `find_impact_files{view:"surface"}`: merged to one row per caller→symbol pair, `edgeType` → **`edgeTypes[]`**, confidence = max, `reason` = the winning edge's. The low-confidence `PROPERTY_REF` filter runs *before* the merge, or a filtered type would survive as a string inside `edgeTypes`. |
| `view:"surface"` ignored (1) | Stays **REFUTED**. The adjacent genuine half — `groupBy` unreachable in that branch — is fixed and the response now echoes `groupBy`, so an ignored parameter cannot hide again. |
| no way to exclude tests (1, six tools) | `excludeTests` (default `false`, matching `search_symbols`) on all six, filtered through the existing `isTestPath`. Two needed more than a post-filter: `get_symbol_context_pack` had to filter callers/callees/importers as well as candidates, and `get_feature_bundle` gates inside `addMember` — the one choke point all three of its resolution passes funnel through — plus its `DbContext` lookup, which was resolving to `TestDbContext`. |
| `query_docs` envelope (1) | All three modes return `{ repoId, mode, count, results }`, plus `documented` for coverage. This is a **breaking** shape change for `stale`/`coverage`, taken deliberately over an additive wrapper. |
| `query_docs` precision (1) | Two halves. **`contentType:"symbol"` rows** were `symbols_fts` **padding**: when the doc lane returned fewer rows than `limit`, the remainder was filled with code symbols, and the nonsense `text` values were *module* pseudo-symbols standing in for doc files. Padding is now opt-in (`includeSymbols`, default off) and excludes `kind='module'`. **`mode:"stale"` matching bare identifiers** — see the root-cause correction below; the answer was `extractMentionsFromCode`, not the suffix maps. |
| path style split (1) | Three distinct causes, not one. `PATH_KEYS` was missing `consumerFilePath`/`relatedFilePath` and the snake_case aliases that `query_graph` echoes verbatim (`file_path`, …). The `repo://` resources serialize through `@mcp/sdk` and so had **never** passed through the normalizer — now `normalizeResourcePayload` in their `serialize` hook. And `rename_assist.hints` splices a path into a sentence, which a key-scoped normalizer cannot reach by design, so it is normalized at the source. |
| `health_check` misleading zeros (1) | `scope: "server"|"repo"`; repo-scoped counters omitted rather than zeroed (compact strips nulls, so `null` would not have been enough) and a `note` saying `repoId` is what unlocks them. `vectorIndex.enabled` stays unconditional — that one genuinely is server-wide. |
| intent ranking (1) | `isMigrationPath`/`isMigrationSymbol` beside `isTestPath`, feeding a `demotionTier` (0 production, 1 test, 2 migration) that is the **primary** sort key — which is what makes demotion move a row at all, and repairs the test penalty's same weakness. The pool query's `order by length(s.name)` was equally at fault: it decided the candidate window before scoring, so `Up`/`Down` crowded out long relevant names; it now orders demoted paths last. Fixes `orient` too — it seeds through the same `getSymbolCandidates(..., "intent")`. Demoted, not removed: an explicit name query still finds a migration. |
| two symbol counts (1) | `getFileContextImpl`/`getBatchContextImpl` exclude the module pseudo-symbol from what they **report**, matching `getFileSummaryImpl` and `findDocCoverageImpl`. It is deliberately **kept** in the edge query: IMPORTS edges hang off that symbol, so filtering it from `symbolIds` too would have silently emptied every import list — pinned by an assertion. |
| `rename_assist` advisory (1) | `affectedFiles` leads with the declaring file and `affectedFileCount` derives from that list, so the advisory and `emitPreview:true` now report the same blast radius. |

### Root-cause correction: `mode:"stale"` matching bare identifiers

The first fix for this sub-item **did not work**, and the registry's own diagnosis pointed at the
wrong code. Recorded because the wrong theory is plausible enough to be re-attempted.

- **The theory:** a bare backtick `` `Parse` `` resolved through `resolveMentionsImpl`'s unqualified
  `nameSuffixMap`, which maps the suffix of a dotted symbol name (`Type.Parse` → `parse`). Fix: gate
  that fallback on uniqueness and a minimum token length.
- **Why it was wrong:** C# members are stored in `symbols.name` under their **bare** name — the
  qualified `ConversationLoopCorrelationCodec.Parse` is *derived* at query time from
  `parent_symbol_id`, and never written to `name`. So `nameMap.get("Parse")` matched **exactly**, on
  the first line of the resolver, and the suffix fallback was never reached. Gating it changed
  nothing: re-indexing all 521 files into a throwaway DB still returned the same 5 hits.
- **The actual cause:** `extractMentionsFromCode` (`services/extractors/markdownParser.ts`) harvests
  every `identifier(` inside a **fenced code block** and recorded it as `mentionType: "backtick"` —
  under a comment that conceded *"Treat as backtick-level confidence since it's code"*. So a `Parse(`
  in a pasted C# snippet, in an archived document about sender-email caching, was indistinguishable
  from an author writing `` `Parse` `` in prose to document that method. Measured on
  `wec.communication-hub`: **1292** prose mentions (349 resolved) against **488** code-block mentions
  (70 resolved).
- **The fix:** a fourth `mentionType`, `code_call`, at confidence 0.5. It still resolves — "where is
  this symbol illustrated" is a real question — but `findStaleDocs` excludes it, because "this doc is
  now stale" is a strong enough claim to need the prose signal. `includeCodeMentions:true` opts back in.
- **Verified as a pair**, on `wec.communication-hub` indexed into a throwaway DB: `Parse` went 5 → **0**,
  `includeCodeMentions:true` returns the same 5 (all labelled `code_call`), and the control symbol
  `TenantId` — prose-mentioned — still returns its **10**. Asserting only that the count fell to zero
  would have been satisfied equally well by breaking the docs lane outright.
  > ⚠️ **This verification was worthless, and the word "throwaway" is why.** The consumer repo re-ran
  > the same call on a real database and got the same 5 hits back. `doc_mentions` had no delete path
  > and a primary key containing `mention_type`, so the relabel *added* a row and the legacy
  > `backtick` row survived every re-index — a fresh DB is the one database with no legacy row to
  > survive. Fixed in the fourth wave; the pairing instinct was right, the fixture was not. Full
  > mechanism in *Fourth wave* in the Index section.
- **Kept from the wrong fix:** the suffix-map uniqueness guard, which is correct on its own terms
  (picking an arbitrary first entry when several symbols share a suffix is a guess reported as a
  fact). The minimum-length threshold was dropped — it was pure consequence of the wrong theory.
- **Note this only takes effect on re-index.** Unlike every other item here, which is read-path,
  this changes how mentions are *written*. An existing database keeps its old `doc_mentions` rows
  until the repo is re-indexed with `docsMode:"on"` — and **before the fourth wave it kept them even
  then**, which is exactly what this note failed to anticipate. A re-index now replaces a file's
  mentions rather than adding to them, so one run with `docsMode:"on"` is genuinely sufficient.
- **Incomplete as first shipped:** only the *call* branch of `extractMentionsFromCode` was corrected.
  Its backtick branch kept emitting `mentionType:"backtick"` for identifiers inside fences, and the
  heading regex ran regardless of fence state, so `# comment` lines in bash samples became headings
  and fed the prose extractor. Both closed in the fourth wave. Everything harvested from inside a
  fence is now `code_call`: the mention type records where the text came from, not what shape it had
  once it got there.

**Two adjacent contract defects found while fixing this**, both "zod accepts a parameter that
`tools/list` does not advertise", which an `additionalProperties: false` client must reject:
`find_implementations` and `query_docs` never advertised `profile`. Both fixed here because their
`inputSchema` was already being edited. Four more have the same gap and are **not** fixed —
`get_symbol_detail`, `find_symbol_at_line`, `get_folder_summary`, `find_entry_points` — filed as
MCP-ISSUE-051 rather than silently widening this change.

**Residual, accepted:** `getFileSummaryImpl` caps `exports` at `limit 50`, so `symbolCount`
under-reports for a file with more than 50 symbols and the two tools' counts agree only below that
cap. The harness picks a file under the cap *from the graph* rather than hardcoding one, so the
assertion cannot quietly stop testing anything.

**Verification.** `scripts/test/test-issue-049-shapes.mjs` (new, 59 assertions over a real stdio
handshake) plus additions to `test-profile-responses.mjs`, `test-search-ranking.mjs`,
`graphQueries.test.ts` and `fileFilter.test.ts`. Two lessons from this issue are built into how they
assert: **never skip** — the identity gap survived `test-profile-responses.mjs` for as long as it did
because the fixture symbol happened to have no callers, so the assertions silently skipped, and the
harness now asks the graph for a symbol that *has* a caller; and **assert the absence** — "no
duplicate rows", "no backslash", "the old scalar key is gone" are the actual defects, and a test that
only checked a field exists would have passed before the fix. Gate: 36/36 suites, `verify:all` clean,
`benchmark:plan:check` at **68.4%** compact savings against a 40% floor (adding identity to compact
cost less than removing the duplicate rows saved).

---

## MCP-ISSUE-050 — `index_version` was never persisted, so `mode:"incremental"` could never fast-skip

- **Status:** **FIXED** 2026-08-04. Found while fixing MCP-ISSUE-048's persistence gaps; not from the sweep.
- **Scenario:** `evaluateIncrementalSkip` (`services/indexing/runPolicy.ts`) gates the incremental
  fast-skip on `latestRun.indexVersion !== INDEX_VERSION` — re-index if the engine version moved. But
  `index_runs` had **no `index_version` column**: `recordRun` accepted the field and dropped it, and
  `getLatestRun` never selected it. So the left side was always `undefined`, the comparison was always
  true, and the version gate always fired.
- **Expected vs actual:** expected `mode:"incremental"` on an unchanged, clean, already-indexed repo to
  fast-skip. Actual: it re-scanned every time, silently — the run reported `ok` and did real work, so
  nothing looked wrong. This is a pure cost defect, which is why it survived: no output was ever untrue.
- **Impact:** the documented "incremental may fast-skip when indexed commit equals HEAD and the tree is
  clean" (`.claude/rules/mcp-hard-mode.md`) could not happen. Every incremental run paid a full scan.
- **Fix:** `index_version` added via the existing `ensureRunColumnText` migration, written by `recordRun`,
  selected by `getLatestRun`. Round-trip pinned in `src/repositories/runStore.test.ts` — the assertion
  is on the stored value specifically, because the failure mode is invisible in run status.
- **Note:** the skip also requires a clean tree and a matching commit sha, so the effect is only visible
  on a repo in that state; a dirty working tree still re-indexes, correctly.

---

## MCP-ISSUE-051 — four tools accept `profile` in code but never advertise it

- **Status:** **FIXED** 2026-08-04 — the four `inputSchema` blocks, **and the parity check the entry
  named as the real deliverable**. See *What shipped* below.
- **Original status:** OPEN 2026-08-04. Found while adding `excludeTests` to six tools for
  MCP-ISSUE-049; filed separately rather than widening that change.
- **Scenario:** every tool here declares its input **twice** — a zod schema (`types/schemas/*.ts`,
  what the handler actually validates against) and a hand-written JSON Schema (`tools/*.ts`, what
  `tools/list` advertises). For four tools the two disagree: the zod schema has
  `profile: responseProfileSchema.default("compact")` and the advertised `inputSchema` has no
  `profile` property at all, while declaring `additionalProperties: false`.

  | tool | zod accepts `profile` | `tools/list` advertises it |
  |---|---|---|
  | `get_symbol_detail` | yes | **no** |
  | `find_symbol_at_line` | yes | **no** |
  | `get_folder_summary` | yes | **no** |
  | `find_entry_points` | yes | **no** |

- **Expected vs actual:** expected the advertised contract to describe what the tool accepts. Actual:
  a client that validates against `tools/list` must reject `profile` as an additional property, while
  a client that ignores `tools/list` finds it works — so the same call is valid or invalid depending
  on how strictly the caller reads the contract. Neither behaviour is wrong; the contract is.
- **Impact:** cost and confusion, not a wrong answer. These four always respond at their zod default
  (`compact`), so an agent that wants `nano` on `get_folder_summary` — a session-orientation tool,
  where payload size is the whole point — has no advertised way to ask, and `README.md` has to
  document the contradiction instead of a rule.
- **Not affected:** `index_repository`, `watch_repo`, `refactor_replace_rollback` and
  `refactor_symbol_migration` also omit `profile` from `inputSchema`, but their zod schemas have no
  `profile` either. Those five are consistent and correct. `find_implementations` and `query_docs`
  had this same gap and were fixed under MCP-ISSUE-049 because their `inputSchema` was already being
  edited there.
- **Fix:** add `profile: PROFILE_PROP` to the four `inputSchema` blocks, then
  `npm run contracts:update`. One line each; the handlers already resolve the profile.
- **Enhancement proposal:** the dual declaration is the root cause — nothing checks that the zod
  schema and the advertised JSON Schema describe the same parameter set, so a drift like this is
  invisible to `typecheck`, to `contracts:check` (which pins the advertised schema against itself,
  not against zod) and to `docs:check`. A test that compares each tool's zod key set against its
  advertised `properties` would have caught all six instances at once, and would prevent the next one.
  That check is the real deliverable here; the four one-line additions are the symptom.

**What shipped 2026-08-04:**

- `profile: PROFILE_PROP` on all four `inputSchema` blocks (`tools/search.ts`,
  `tools/readMetadata.ts`), plus `npm run contracts:update`. The snapshot diff is **purely additive**
  — four `profile` properties, nothing removed — so no client that worked before can break.
- **`src/tools/schemaParity.test.ts`** — the check the entry asked for. It builds all 43 tools and
  compares each one's zod key set against its advertised `properties`, **in both directions**,
  because the two failures mean different things: an advertised key with no zod key is a parameter
  the server will reject as unknown; a zod key with no advertised key is a parameter a conformant
  client cannot send. A third test asserts that a tool declaring `additionalProperties:false`
  advertises every key it marks `required` — that combination is unsatisfiable, and nothing else
  looks for it.
- The check is guarded against going vacuous (`compared >= 40`) and pinned by a named test for the
  four tools in this entry, so deleting the general check cannot quietly un-fix the filed issue.
- **Proven by mutation**, per B-06's standard: removing the `profile` line from
  `find_symbol_at_line` fails both the general check and the named one, and the failure message
  names the tool and the direction — `find_symbol_at_line: accepts "profile" but never advertises it`.

Why this was invisible: `typecheck` sees two unrelated object literals; `contracts:check` pins the
advertised schema against a snapshot of *itself*, so a parameter missing from both stays missing; and
`docs:check` reads only the advertised side. Six instances existed before anyone looked, and all six
were found by hand while editing something else.
