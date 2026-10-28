# MCP Codebase-Index — Issue Registry (server-side bugs)

Bug/enhancement reports for the `codebase-index-mcp` server, raised from consuming repos (e.g.
`wec.communication-hub`). Each entry: Scenario · Tool/query attempted · Expected vs actual · Impact ·
Workaround · Enhancement proposal. Filed here so the MCP server team can triage and fix at the source.

> Note: consumer repos keep their own *fallback log* (when they drop to Grep/Read) separately; this
> file tracks defects/limitations of the MCP server itself.


## Index

**31 entries — 29 resolved, 1 re-opened (`054`), 1 open (`061`).** `061` is the 2026-09-16 docs-lane
sweep: the docs lane stores **no prose rows**, so `query_docs{mode:"search"}` answers from heading text
alone — a regression introduced by the 2026-08-10 `contentTypes` fix, which added a `prose` slot no
writer populates and dropped `code_block` from the default. Eleven defects, plus **four claims that
were investigated and refuted** — read that table before re-proposing a vector-lane shutdown or a
tool-count consolidation on token grounds; both rest on numbers that do not hold.

The last 8 (`052`–`059`) were filed by the
2026-08-05 consumer sweep — see *Sweep 2026-08-05* near the end of this file, which also records the
independent re-verification that **every one of the 042–051 fixes held**, and lists the symptoms that
turned out to be consumer misuse so they are not re-triaged as defects. All eight were reproduced and
fixed on 2026-08-10 (`052`–`059`), verified by a full re-index of `wec.communication-hub` plus a new
regression harness (`test:issue-052-qualified-call`) and unit tests for the risk scorer.

**The consumer then re-verified that wave the same day, and `054` did not survive it.** Seven of the
eight hold under independent repro; `054`'s disclosure fields hold but its central claim — that the
risk score is invariant under `impactLimit` — is false in the pipeline, because the cap moved from the
denominator to the numerator rather than being removed. Its unit test passes because it exercises
`scoreChangeRisk` in isolation, where the truncation cannot be observed. **Read `054` → *Re-open*
before closing it again; it names the end-to-end assertion that would have caught this.**

Two of the eight were filed with the **wrong root cause**, and the corrected mechanism is recorded in
each entry — read those before treating either as a regression baseline:

- **`052`** — the report said 036's receiver-as-class branch "never fired". It fired. The extractor emits
  a bare *and* a qualified token per call site and relied on the unique index to collapse them; once 036
  taught the qualified half to resolve correctly the two stopped agreeing, so both survived.
- **`055`** — nothing to do with `.WithName()`. `Customers` is a **partial class** and its handlers are
  declared in sibling files, which the file-local symbol lookup could not see.

**`054` was also worse than filed:** it does not merely flatten the risk signal, it inverts the verdict —
the same file scores 78/high or 30/low on the same diff depending on `impactLimit`. **The inversion
still reproduces after the fix**, in the opposite direction (49/medium at the default, 75/high at any
wider page) — hence the re-open. Two further items are knowingly **left undone** and are marked as such
in their entries: `strict-review`'s threshold has not been re-calibrated against the new scale (`054`),
and the `.sln`/`.csproj` double-count plus the `query_graph` path-style split remain open (`058(f)`).
Note the `.sln`/`.csproj` half of `058(f)` no longer reproduces on `wec.communication-hub` — the graph
holds zero such edges — so it may be closable on measurement rather than work.

Statuses and dates are copied from each entry's own
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
| `MCP-ISSUE-060` | `find_impact_files` reports an empty blast radius for any class reached through its interface — `expandInterfaceSiblingsImpl` was imported by four impact modules and called by none; plus four defects found alongside it | ✅ FIXED 2026-08-25 · was P0 · found by the six-agent audit |
| `MCP-ISSUE-052` | a qualified static call produces the correct edge **and** a wrong same-named one, and `trace_execution_flow` reports 7 of 9 false nodes at `confidence:"high"` | ✅ FIXED 2026-08-10 · was P0 · follow-up to 036 |
| `MCP-ISSUE-053` | unresolved edges surface as nameless rows / synthetic ids, inflating `calleeCount` and eating the `limit` budget | ✅ FIXED 2026-08-10 · was P1 |
| `MCP-ISSUE-054` | `detect_changes` applies the default `impactLimit: 20` before breadth normalization, so the risk model is a constant; a policy preset can empty the result silently | ✅ FIXED 2026-08-10 (2nd attempt) · re-opened same day, cap moved out of the NUMERATOR · was P1 |
| `MCP-ISSUE-055` | `route_map` takes `handlerName` from `.WithName()`, so a string-literal endpoint name collapses every route onto the group method | ✅ FIXED 2026-08-10 · was P2 · follow-up to 044 · rebind hardened 2026-08-10 (review) |
| `MCP-ISSUE-056` | `excludeTests` still missing on the seven call-graph tools, where interface dispatch fans hardest into test doubles | ✅ FIXED 2026-08-10 · was P2 · follow-up to 049 · filters moved into SQL 2026-08-10 (review) |
| `MCP-ISSUE-057` | `get_feature_bundle` misses endpoints living in a shared file, and lists class + constructor separately in every role | ✅ FIXED 2026-08-10 · was P2 |
| `MCP-ISSUE-058` | five ways a zero or positive result misleads: scan cap, fuzzy name match, ignored scope, over-fuzzy doc search, non-code residual risk | ✅ FIXED 2026-08-10 · was P3 · (f) follow-up to 045 |
| `MCP-ISSUE-059` | advertised descriptions understate or contradict actual behaviour (4 items) | ✅ FIXED 2026-08-10 · was P4 |
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

<!-- BEGIN GENERATED: issue-files -->

## Entries (one file each, `docs/issues/`)

- [ISSUE-CR-001 — Package bridge resolves 0/257 (cross-repo provider linkage)](issues/ISSUE-CR-001.md)
- [ISSUE-CR-002 — `find_package_consumers` double-prefixes `nuget:`](issues/ISSUE-CR-002.md)
- [MCP-ISSUE-031 — `dead_code_scan` suppresses every method in an `i`-prefixed C# file](issues/MCP-ISSUE-031.md)
- [MCP-ISSUE-032 — an index run is not reproducible: edge counts vary between identical runs](issues/MCP-ISSUE-032.md)
- [MCP-ISSUE-033 — `dead_code_scan` returned an empty result for every repo, always](issues/MCP-ISSUE-033.md)
- [MCP-ISSUE-034 — C# `TYPE_REF` edges are almost never produced, so every C# type looks dead](issues/MCP-ISSUE-034.md)
- [MCP-ISSUE-035 — vector KNN applied `k` across all repos, then filtered, so resolution lost its fallback](issues/MCP-ISSUE-035.md)
- [MCP-ISSUE-036 — a qualified static call resolved to the WRONG same-named method](issues/MCP-ISSUE-036.md)
- [MCP-ISSUE-037 — abstract/virtual base-class members have no dispatch fan-out, so every override looks dead](issues/MCP-ISSUE-037.md)
- [MCP-ISSUE-038 — the `very-large` profile silently discarded every unresolved TYPE_REF, so MCP-ISSUE-034's fix was inert on the biggest repo](issues/MCP-ISSUE-038.md)
- [MCP-ISSUE-039 — the vector fallback cost 30s per run and resolved nothing](issues/MCP-ISSUE-039.md)
- [MCP-ISSUE-040 — a live server running a replaced build fails every parse, and the run still reports `ok`](issues/MCP-ISSUE-040.md)
- [MCP-ISSUE-041 — `get_call_chain` stopped seeing through DI when a fix was orphaned by a file move](issues/MCP-ISSUE-041.md)
- [MCP-ISSUE-042 — `refactor_replace_rollback` restores the files and leaves the graph holding the reverted names, while `health_check` reports "ready"](issues/MCP-ISSUE-042.md)
- [MCP-ISSUE-043 — the guarded-refactor tools refuse work `refactor_replace_preview` does](issues/MCP-ISSUE-043.md)
- [MCP-ISSUE-044 — `find_entry_points(kind:"route_handler")` returns a count with empty arrays; `route_map` names the endpoint group, not the handler](issues/MCP-ISSUE-044.md)
- [MCP-ISSUE-045 — cross-repo resolution matches bare type names, so `Task` links every repo to one unrelated class](issues/MCP-ISSUE-045.md)
- [MCP-ISSUE-046 — `find_package_consumers` returns the files that DEFINE the package, and a wrong name returns 0 silently](issues/MCP-ISSUE-046.md)
- [MCP-ISSUE-047 — `get_persistence_mapping` dumps every CHECK constraint in the repo, ignores `profile`, and disagrees with `find_field_accesses` about "owner"](issues/MCP-ISSUE-047.md)
- [MCP-ISSUE-048 — index-run counters contradict the database and each other](issues/MCP-ISSUE-048.md)
- [MCP-ISSUE-049 — ten papercuts found by the same sweep](issues/MCP-ISSUE-049.md)
- [MCP-ISSUE-050 — `index_version` was never persisted, so `mode:"incremental"` could never fast-skip](issues/MCP-ISSUE-050.md)
- [MCP-ISSUE-051 — four tools accept `profile` in code but never advertise it](issues/MCP-ISSUE-051.md)
- [MCP-ISSUE-052 — a qualified static call now produces the CORRECT edge **and** a wrong same-named one, and every traversal built on it reports `confidence:"high"`](issues/MCP-ISSUE-052.md)
- [MCP-ISSUE-053 — unresolved edges surface as nameless rows and synthetic ids, inflating counts and consuming the `limit` budget](issues/MCP-ISSUE-053.md)
- [MCP-ISSUE-054 — `detect_changes` applies the default `impactLimit: 20` before breadth normalization, so the risk model is a constant; and a policy preset can filter every row without saying so](issues/MCP-ISSUE-054.md)
- [MCP-ISSUE-055 — `route_map` takes `handlerName` from `.WithName()`, so a string-literal endpoint name collapses every route onto the group method](issues/MCP-ISSUE-055.md)
- [MCP-ISSUE-056 — `excludeTests` is still missing on the seven call-graph tools, where interface dispatch fans hardest into test doubles](issues/MCP-ISSUE-056.md)
- [MCP-ISSUE-057 — `get_feature_bundle`: the `endpoint` role misses endpoints that live in a shared file, and every role lists the class and its constructor separately](issues/MCP-ISSUE-057.md)
- [MCP-ISSUE-058 — five ways a zero or a positive result misleads: scan cap, fuzzy name match, ignored scope, over-fuzzy doc search, non-code residual risk](issues/MCP-ISSUE-058.md)
- [MCP-ISSUE-059 — advertised descriptions understate or contradict actual behaviour (4 items)](issues/MCP-ISSUE-059.md)
- [MCP-ISSUE-060 — `find_impact_files` returns an empty blast radius for interface-mediated callers, and four defects found beside it](issues/MCP-ISSUE-060.md)
- [MCP-ISSUE-061 — the docs lane stores no prose, and the 2026-08-10 `contentTypes` fix narrowed the default search to headings alone](issues/MCP-ISSUE-061.md)
- [MCP-ISSUE-062 — `query_graph` repo isolation was a text check: `OR 1=1`, a UNION arm or a second table read every other repo](issues/MCP-ISSUE-062.md)
- [MCP-ISSUE-063 — incremental re-index left resolved edges pointing at symbols that no longer exist; the size/mtime quick check never fired](issues/MCP-ISSUE-063.md)
- [MCP-ISSUE-064 — every `McpError` reached the wire as `MCP_ERROR`, so a caller's bad input read like a server fault](issues/MCP-ISSUE-064.md)
- [MCP-ISSUE-065 — every `.csproj` `ProjectReference` edge pointed at a symbol id that does not exist](issues/MCP-ISSUE-065.md)
- [MCP-ISSUE-066 — IDE state under `.vs/` consumed the whole 20 000-file scan budget: `filesIndexed: 1`](issues/MCP-ISSUE-066.md)
- [MCP-ISSUE-067 — `find_field_accesses` answered a Zod field with an unrelated function and `coverage: "high"`](issues/MCP-ISSUE-067.md)
- [MCP-ISSUE-068 — a 1.41 MB decision log was invisible to every docs mode, and `filesSkipped` could not say why](issues/MCP-ISSUE-068.md)
- [MCP-ISSUE-069 — a deleted or reverted dirty file survived as a phantom, reported as current](issues/MCP-ISSUE-069.md)
- [MCP-ISSUE-070 — gitignored build output was indexed, so symbols appeared twice](issues/MCP-ISSUE-070.md)
- [MCP-ISSUE-071 — `search_symbols` padded an exact name match with 49 vector near-neighbours](issues/MCP-ISSUE-071.md)
- [MCP-ISSUE-073 — R3 exact: TS/JS fields answered by the TypeScript LanguageService, not a lower bound](issues/MCP-ISSUE-073.md)
- [MCP-ISSUE-074 — R2 Vue: `.vue` files were skipped, so no tool could say who renders a component](issues/MCP-ISSUE-074.md)
- [MCP-ISSUE-075 — CSS lane: design tokens and classes were invisible to the graph](issues/MCP-ISSUE-075.md)
- [MCP-ISSUE-076 — Text and JSON lanes: configs, data files and package manifests were invisible](issues/MCP-ISSUE-076.md)
- [MCP-ISSUE-077 — HTML entry pages and SVG assets were not nodes, so "who uses icon.svg" had no answer](issues/MCP-ISSUE-077.md)
- [MCP-ISSUE-078 — the `bin` path segment dropped Node CLI source (git now decides)](issues/MCP-ISSUE-078.md)
- [MCP-ISSUE-079 — stored paths mixed `\` and `/`](issues/MCP-ISSUE-079.md)
- [MCP-ISSUE-080 — R11: no tool answered "which tests does my uncommitted change need, and how do I run them"](issues/MCP-ISSUE-080.md)
- [MCP-ISSUE-081 — R9: no edge said which wec.be controller action an Aria tool calls](issues/MCP-ISSUE-081.md)
- [MCP-ISSUE-082 — SQL lane: migrations were skipped, so "who touches table X" had no answer](issues/MCP-ISSUE-082.md)
- [MCP-ISSUE-083 — `orient` sent the R4 / R5 / R9 / R11 questions to the wrong first tool](issues/MCP-ISSUE-083.md)
- [MCP-ISSUE-084 — the resolver's vector fallback bound unmatched tokens to near-name guesses](issues/MCP-ISSUE-084.md)
- [MCP-ISSUE-085 — a dirty or incremental refresh did not land on the graph a full run builds](issues/MCP-ISSUE-085.md)
- [MCP-ISSUE-086 — `health_check` ran `git status` twice, synchronously, on the server thread](issues/MCP-ISSUE-086.md)
- [MCP-ISSUE-087 — `detect_changes` loses the old path of a rename](issues/MCP-ISSUE-087.md)
- [MCP-ISSUE-088 — a refreshed answer waits ~2.3 s around a 0.35 s run](issues/MCP-ISSUE-088.md)
- [MCP-ISSUE-089 — a doc mention several symbols matched equally was bound to the first by path](issues/MCP-ISSUE-089.md)
- [MCP-ISSUE-090 — a superseded SQL definition stayed a doc-mention candidate beside the current one](issues/MCP-ISSUE-090.md)
- [MCP-ISSUE-091 — `query_docs stale` was flooded by one ambiguous same-named pair](issues/MCP-ISSUE-091.md)
- [MCP-ISSUE-092 — an EF Core repo had no tables in the graph](issues/MCP-ISSUE-092.md)
- [MCP-ISSUE-093 — a C# namespace import's confidence depended on which rows the run resolved](issues/MCP-ISSUE-093.md)
- [MCP-ISSUE-094 — C# dispatch fan-out differed between a scoped run and a full run](issues/MCP-ISSUE-094.md)
- [MCP-ISSUE-095 — an incremental run fast-skipped over a deleted file that an earlier run indexed from a dirty tree](issues/MCP-ISSUE-095.md)
- [MCP-ISSUE-096 — the EF lane turned bound doc mentions ambiguous in other C# repos, and over-reported gaps](issues/MCP-ISSUE-096.md)
- [MCP-ISSUE-097 — a dropped SQL object read as a live definition](issues/MCP-ISSUE-097.md)
- [MCP-ISSUE-098 — raw SQL in EF migrations was invisible (`migrationBuilder.Sql`)](issues/MCP-ISSUE-098.md)
- [MCP-ISSUE-099 — `index_runs` and the WAL file grew without bound](issues/MCP-ISSUE-099.md)
- [MCP-ISSUE-100 — a capped `search_regex` looked complete](issues/MCP-ISSUE-100.md)
- [MCP-ISSUE-101 — every query on a dirty tree re-ran the refresh](issues/MCP-ISSUE-101.md)
- [MCP-ISSUE-102 — a linked git worktree beside its main checkout could not be indexed](issues/MCP-ISSUE-102.md)
- [MCP-ISSUE-103 — a server restart dropped every client's HTTP session](issues/MCP-ISSUE-103.md)
- [MCP-ISSUE-104 — an unset approval secret fell back to a constant, so anyone could mint an apply token](issues/MCP-ISSUE-104.md)
- [MCP-ISSUE-105 — a registered repo could not be dropped from the index](issues/MCP-ISSUE-105.md)
- [MCP-ISSUE-106 — an incremental run after a HEAD move read and hashed every file](issues/MCP-ISSUE-106.md)
- [MCP-ISSUE-107 — a repo registered at a subdirectory of its git root answered "fresh" on stale content](issues/MCP-ISSUE-107.md)
- [MCP-ISSUE-108 — a new session of the same client lost its pre-restart previews](issues/MCP-ISSUE-108.md)
- [MCP-ISSUE-109 — a 0-line apply minted an applyId / rollbackId and stored a rollback row](issues/MCP-ISSUE-109.md)
- [MCP-ISSUE-110 — two harnesses failed under machine load: freshness budget did not bound the tree check; HTTP start-up outran the harness; an unresolved client identity is suspected](issues/MCP-ISSUE-110.md)
- [Confirmed fixed — 2026-08-05 re-verification of the 042–051 wave](issues/confirmed-fixed-2026-08-05-re-verification-of-the-042-051-wave.md)
- [MCP-ISSUE-101 follow-ups (row 5: F2–F4)](issues/mcp-issue-101-follow-ups-row-5-f2-f4.md)

<!-- END GENERATED: issue-files -->
