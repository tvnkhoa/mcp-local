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

