## MCP-ISSUE-060 — `find_impact_files` returns an empty blast radius for interface-mediated callers, and four defects found beside it

- **Status:** ✅ FIXED 2026-08-25 (filed 2026-08-25, was **P0**). Found by a six-agent read-only audit of the whole tool surface; every claim below was checked against the files on disk with `grep`/`cat` before it was written down.
- **Scenario:** `find_impact_files(repoId:"wec.be", filePath:".../Messaging/SmsConversationService.cs", view:"files")` → `totalImpactedCount: 0`, `impactedFiles: []`, `graphHealth.note: "graph data complete"`, `reliabilitySummary.medianConfidence: 1`. In the same session, `get_symbol_context_pack(name:"SmsConversationService")` → `callerCount: 14`.
- **Why this matters:** an agent asking "what breaks if I change this file" is told nothing breaks, at full confidence. A zero is the answer an agent stops on — this is strictly worse than an error.

### (a) The impact CTE never saw interface siblings — a dead import, not a missing feature

`expandInterfaceSiblingsImpl` was imported by **four** modules in `src/services/impact/` and called by **none** of them: `impactSurface.ts:11`, `impactShared.ts:11`, `impactRepoSummaries.ts:11`, `impactRenameTrace.ts:11`. It survives `npm run typecheck` because `codebase-index-mcp/tsconfig.json` does not set `noUnusedLocals` (only the root `tsconfig.base.json`, which governs `packages/*`, does).

This is the identical failure already recorded at `src/tools/handlers/impactHandler.ts:645` — *"S-41 … inlined the traversal here without it, and left the fixed module orphaned. … do not drop it again."* It happened a second time, in four files, and nothing caught it. **Both** views of `find_impact_files` were affected; the audit only noticed `view:"files"`.

**Fix (2026-08-25).** New `buildImpactSeed` in `src/services/impact/impactShared.ts`: loads the file's symbols (module pseudo-symbol included — IMPORTS edges target it), expands them through `expandInterfaceSiblingsImpl`, and materialises the union into a `temp table _impact_seed`. `getImpactFilesImpl` and `getImpactSurfaceImpl` pass `s.symbol_id in (select sid from _impact_seed)` as the CTE's `symbolFilter`.

A temp table rather than `in (@s0…@sN)` because `symbolFilter` is interpolated once per branch of a six-branch union — a 100-symbol file × 20 implementors would bind ~12 000 parameters. **Not** a seventh union branch: the header at `impactShared.ts:74-86` records that this CTE replaced a 216 s form with a 0.5 s one precisely by keeping every branch index-drivable, and a two-hop `IMPLEMENTS` join re-introduces the shape it escaped. Expansion seed capped at 60, type-kinds first.

- **Measured, `wec.be`, same file, same index:** `0` → `11` caller rows across `2` files. All 11 matched through a **resolved symbol id**, not a bare-name token — no name-match inflation. `view:"surface"`: `0` → `11` callers.
- Takes effect on the **existing** index. No re-index, for any repo.

### (b) Self-exclusion compared the wrong file — the way to ship (a) wrong

Both queries excluded the queried file with `sf.file_path != s.file_path`. Once the seed can hold siblings living in other files, `s` may be the *interface*, so that predicate stopped meaning "not the file I asked about": it admitted the interface's own declaring file as impacted, and dropped genuine callers that happen to live in it. Changed to `sf.file_path != @filePath` in `getImpactFilesImpl` (pass 1 and the detail pass) and `getImpactSurfaceImpl`.

### (c) A bare-name match that landed on an interface was relabelled as receiver-proven

`resolveCallEdgesBatch` sets `dispatchMethodName` on two paths: `edgeResolverCalls.ts:350-367`, where extraction handed it a receiver that named an interface, and `:416-419`, where a bare **name** match merely happened to land on a method whose parent is an interface. Both emitted `reason: "resolved interface method"` at `confidence: 0.8`, and because the reason ternary tested `dispatchMethodName` **before** `nameAmbiguous`, the ambiguity branch was unreachable for the second path. `nameAmbiguous` was computed and discarded.

**Measured on `wec.be`:** 2070 `resolved interface method` edges, of which **986 (47.6%)** target a method name declared by two or more *different* interfaces — `CreateAsync` by **35** of them, `GetDetailAsync` by 31, `GetAsync` by 12. Concrete instance: `EmailOnAcidService.GetListClientAsync` holds a `confidence: 0.8` CALLS edge into `ISmsConversationService.GetAsync`.

This is MCP-ISSUE-052's defect one lane over, and the house already had the vocabulary for it: `resolved property by name (unproven owner)`.

**Fix (2026-08-25).** New `dispatchVia` discriminates the two paths. The name-derived one emits `resolved interface method (unproven receiver)` at the name-guess confidence ladder (`0.75`, `0.7` when ambiguous) and is added to `NAME_ONLY_EDGE_REASONS` in `src/types/index.ts`, so `summarizeEdgeProvenance` counts it and `buildCoverageBlock` can no longer report `high` on a traversal standing on it. The receiver-proven path is unchanged at `0.8` — flagging it too would train agents to discount good answers. The ISSUE-022 interface fan-out is retained on both paths. **Applies on the next index run**, not to existing rows.

### (d) `detect_changes` answered "nothing changed, zero risk" for a ref that does not exist

`runGit` (`gitHelpers.ts:5`) is the only unbounded synchronous wait on the read path and had **no `timeout`, no `maxBuffer`, no `windowsHide`**. `runGitLines` wrapped it in `catch { return [] }`, so `git diff typo..HEAD` — which exits non-zero — was indistinguishable from a clean diff, and the release-gate tool reported `changedFileCount: 0`, `highRiskCount: 0`, `note: "using git range diff"`, asserting the diff had run.

The 1 MB default `maxBuffer` was a second, quieter bug: `git status --porcelain` on a large dirty repo throws `ENOBUFS`, swallowed by `runGitStatusPorcelain:46-48`, so `health_check` reported *"non-git repo or unable to read working tree status"* for a repo that was merely dirty.

**Fix (2026-08-25).** `runGit` now passes `timeout: 5000`, `maxBuffer: 16 MiB`, `windowsHide: true`. New `runGitLinesOrNull` returns `null` on failure and `[]` on success-with-no-output; only the four call sites in `changeAnalysis.ts` move to it, because `[]`-on-failure is genuinely right for a non-git directory and an unborn HEAD. An unresolvable ref now throws `ChangeAnalysisError("UNRESOLVED_REF")`, mapped to `InvalidParams` by `asInvalidParamsOnBadRef` in `indexHandler.ts` — matched by `error.name`, not `instanceof`, per ADR 0001.

### (e) Three response-honesty defects fixed in the same pass

1. **`changedFileCount` was the post-cap page length.** `git diff` reported 300 changed files in `mcp-local`; `detect_changes` at its default `maxFiles` reported `100`, with no truncation field — and because the cap slices an alphabetically ordered set, every file of the newly added `sqlserver-mcp` server (29 files, initial `s`) was invisible. The true count was computed one expression earlier in `changeAnalysis.ts` and discarded. Now `totalChangedFileCount` is carried through, `changedFileCount` is the truth, and `changedFilesReturned` / `changedFilesDroppedByLimit` describe the page — the shape `impacts` already had via `filter.droppedByLimit`. `summary.filesCapped` was an equality heuristic that false-positives on a diff of exactly `maxFiles`; it now reads the real number.
2. **`search_symbols` dropped `symbolId` at `compact`** (`searchHandler.ts:112`), which is both the documented default profile and the documented first step of the standard flow — while `get_call_chain`, `get_dependency_graph` and `trace_execution_flow` all require a `symbolId`. The golden path could not feed its own second step. `symbolId` is now present at every profile; it is 24 hex characters per row.
3. **Dot-directories were invisible to `search_regex` in every mode, `scanAll` included.** `glob.sync` in `regexSearch.ts:163` lacked `dot: true` — while the exclusion side of the same function already passed it, so the tool could exclude dotfiles it could never include. `.claude/rules/*.md` and `.github/workflows/*` were unsearchable. Fixed there **and** in the indexer's own walk (`fileScan.ts:50`), deliberately together: fixing one alone desynchronises search scope from index scope. Measured on `mcp-local`: 556 → 600 files walked, `.git` still fully excluded (0 leaked), `.vscode` still dropped downstream by `EXCLUDED_PATH_SEGMENTS`. The indexer half **takes effect on the next index run** per repo.

### (f) `get_symbol_context_pack` pooled callers across every same-named symbol

`getContextByNameImpl` built `targetIds` from **all** candidates and matched `e.to_id in (targetIds ∪ siblings)`, so every homonym in the repo contributed its callers to one undifferentiated list. The non-FTS fallback compounds it by selecting `name = ? or name like '%name%'` — a substring is enough to join the pool — and the FTS branch tokenises, so `CreateMessageAsync` matched **12** candidates rather than the 3 an exact-name query finds.

Reproduced against the live index, before and after in one process:

| | callers |
|---|---|
| pooled across all candidates (before) | **16** |
| scoped to the selected symbol (after) | **1** |
| graph truth for the selected symbol | **1** |

The 15 dropped are the ones the audit named: `BmwTeleserviceSendCrcConsumer.Consume`, `CreateLeadConsumer.ProcessAsync`, `SendExternalEmailHandler.Handle`, `TeleserviceFeedbackService.*`, `ZnsSendProcessor.*`, `SmsService.HandleIncomingMessageAsync`. `grep -c CreateMessageAsync` over four of those files returns 0 for all four.

**Fix (2026-08-25).** Callers and `importedByFiles` are seeded from `symbol.symbolId`, matching what `callees` in the same function always did and what `getChangeContextImpl` already does. The ISSUE-022 interface-sibling expansion is kept — a caller reaching the implementation through a DI interface must stay visible — but seeded from the selected symbol rather than from every homonym. `candidates` is still returned in full, so a wrong selection remains visible. `excludeTests` now also reaches this candidate query: the handler filtered `candidates[]` by it and then reported `selectedSymbol` from an unfiltered query, so the symbol whose callers were shown could be a test double absent from the list beside it.

### (g) An unknown `repoId` is refused once, at the seam every call passes

Seven handlers had grown their own repo check and roughly twenty had not — the tools that skipped it are not the ones anyone chose to skip. A `defineGuard("repo_indexed", …)` is now attached in `buildTools` to every tool that advertises `repoId`, except `index_repository` (which registers the repo), `health_check` (designed to answer for an unregistered one) and `watch_repo`.

A **guard**, not a `wrapCall` hook. The first attempt put it in `wrapCall`, which runs *before* zod, and `test:server-envelopes` caught the inverted precedence: a structurally invalid call started answering "unknown repoId" instead of `VALIDATION_ERROR`. Guards run after validation (`dispatch.ts`: resolve → profile → validate → guards → handle), which is the correct order.

Separately, `find_impact_files` now emits `fileIndexed: false` plus a note when the path has no rows in `files`, so "not indexed" stops rendering as "no dependents". New `GraphStore.isFileIndexed` backs it.

### (h) Truncation is profile-invariant for `get_call_chain` and `route_map`

`get_call_chain` emitted `chainLength`/`truncated` only in its nano branch; `route_map` emitted `hasMore` only in nano. Both now carry the signal at every profile — `route_map`'s computed from `routesRaw.length >= limit`, before `excludeTests` shrinks the page, because that filter changes the page without changing whether the query hit its cap.

### (i) `search_symbols({ranked:true})` with no `repoId` returned 0 for every query

`searchHandler.ts` passed `args.repoId ?? ""` into a `where s.repo_id = ?`, which matches no row in any repo. Dropping `ranked` made cross-repo search work and adding `repoId` made `ranked` work; only the combination failed, and it failed as a well-formed empty result. `getSymbolCandidatesImpl` now takes `string | null` and omits the predicate when absent. Measured on the live index: `HandlerContext` 0 → 7, `Startup` 0 → 10, `buildRefactorPreview` 0 → 2. An unknown repoId still returns nothing — the fix must not turn a typo into an authoritative repo-wide search.

### (j) `get_file_context` edges get their own budget

Edges and symbols shared one `limit`, so a file with few symbols and a dense domain model got no edge bound in practice. Edges now take `min(limit, 40)` independently, `PROPERTY_REF`/`PROPERTY_WRITE` are excluded (they were 109 of 200 on the measured file, and `find_field_accesses` is the tool for property access), and the remainder is ordered structure-first so the cap cannot starve the informative types.

Measured on `SmsConversationService.cs` (22 symbols):

| | edges | payload |
|---|---|---|
| before | 200 — `PROPERTY_REF` 102, `PROPERTY_WRITE` 7, CALLS 61, IMPORTS 26, … | **70 526 chars** |
| after | 40 — IMPLEMENTS 1, EXTENDS 1, IMPORTS 26, DEPENDS_ON 2, CALLS 10 | **21 070 chars** |

`edgesTruncated: true` says so. Without the ordering the first cut kept 40 CALLS and starved all 26 IMPORTS — structure answers "what IS this file" before behaviour answers "what does it do".

### (k) `dead_code_scan` no longer answers for a language whose lane records no calls

`wec.rag` is a registered, in-use repo that is 45% Python, and `pythonExtractor.ts` is a ~89-line regex stub: every edge from a `.py` symbol is an IMPORT — 449 of them, zero CALLS, zero TYPE_REF, zero PROPERTY_REF. `dead_code_scan` reported the program's own `main` as a candidate with `suppressed.total: 0`, because every heuristic here is C#-shaped. A `BOOTSTRAP_FILE_NAMES` entry would not have helped: that `main` lives in `chat.py`.

Candidates whose language has no CALLS edges anywhere in the repo are now suppressed as `language_lane_has_no_call_edges`. Measured: `dead_code_scan(wec.rag, language:"python")` goes from reporting Python symbols as dead to **0 candidates, 294 suppressed**.

The rule is deliberately comparative — extraction demonstrably works in *this* repo and produces nothing for *this* language. A first attempt suppressed any language with no CALLS edges full stop, which is true of every unit fixture and of any repo indexed moments ago; it turned four existing tests red by replacing a wrong answer with no answer. Absence of data is not evidence.

### Verification of the full change

`npm run test` **41/41** harnesses (one new: `test:unknown-input-honesty`, 45 assertions) · `test:unit` **162/162** (19 new) · root `npm run verify:all` green, including `contracts:check`, `generate:check` and `docs:check`. The contract diff is exactly four lines — two hints on each of the two re-annotated tools — confirming no input schema drifted.

New test files: `src/services/impact/impactSurface.test.ts`, `src/services/search/symbolSearchContextPack.test.ts`, `src/services/search/symbolSearchCandidates.test.ts`, `scripts/test/test-unknown-input-honesty.mjs`. Cases appended to `edgeResolverCalls.test.ts`, `changeAnalysis.test.ts`, `staticAnalyzerDeadCode.test.ts`, `schemaParity.test.ts`.

### Evidence for the concurrent-dispatch hang, found while fixing CI

Not a fix, but the first hard data point on the open item. `scripts/verify-enhancements.mjs` spawns
the server with `stderr: "pipe"` and never read it. On Windows a pipe write blocks once the 64 KB OS
buffer fills, so as soon as a run produced enough server logging the server blocked mid-write and the
client reported `MCP error -32000: Connection closed`. Isolated by changing one thing: adding
`transport.stderr?.on("data", () => {})` makes it pass, repeatably, with `stderr` still piped.

It only fired when the working tree was dirty — step 5 indexes changed files in `mode:"dirty"`, and an
empty change set logs almost nothing. A clean CI checkout has zero dirty files, which is why it passed
on every push and failed locally.

This is the H2 shape from the audit's diagnosis plan — a blocked write on a pipe nobody is draining —
demonstrated end to end on this machine, on stderr rather than stdout. It does not prove the
concurrent-call hang has the same cause, and stdout is drained by the client where stderr was not. But
it moves H2 from "structurally possible" to "observed here", and the diagnosis harness should measure
response bytes and pipe backpressure before anything else.

### Still open after this change

The concurrent-dispatch hang — mechanism **not** established, and three of the audit's hypotheses argue against fixing it blind (it may be cold-cache, host-side, or in the response write path, and a queue would make two of those worse). A diagnosis harness is designed but not run. `rename_assist`'s 17–22% preview recall. The missing `approvalToken` on `refactor_symbol_migration` / `change_value_representation` — the annotation is now correct, which is what protects a host, but these two still preview-and-apply in one round trip where the `refactor_replace_*` trio requires an HMAC. The remaining P2 extractor work (receiver-typed calls, object-literal arrow attribution, `@mcp/*` package links, DI-bound dispatch, config-file indexing). And the `noUnusedLocals` gap that let (a) survive: `impactRenameTrace.ts` and `impactRepoSummaries.ts` still carry the unused import, left in place deliberately as evidence until each is resolved on its merits.

---

