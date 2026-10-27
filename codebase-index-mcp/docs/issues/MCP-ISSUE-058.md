## MCP-ISSUE-058 — five ways a zero or a positive result misleads: scan cap, fuzzy name match, ignored scope, over-fuzzy doc search, non-code residual risk

- **Status:** ✅ FIXED 2026-08-10 (filed 2026-08-05, was **P3**). Grouped as papercuts in the style of
  `MCP-ISSUE-049`; each is independently reproducible. Sub-item **(e)** is a follow-up to
  `MCP-ISSUE-045`.

**(a) `search_regex` silently caps at 5000 files scanned, so `count: 0` is indistinguishable from "absent".**
`search_regex(repoId:"wec.be", pattern:"ManualOutbound")` on a repo with 7528 indexed files:
```json
{"count":0,"filesScanned":5000,"truncated":true,"truncationReason":"files_cap_reached"}
```
2528 files were never scanned. `coverage.knownGaps` carries only the generic *"0 results may mean the
wrong search strategy, a too-narrow filter, or a stale index"* — it does not mention the cap.
**Ask:** when `truncated && count === 0`, add an explicit `knownGaps` entry naming the cap and the
unscanned count; optionally expose the cap as a parameter. This one cost real time: the 0 was read as
"the symbol does not exist in that repo".
**Fixed 2026-08-10.** `searchRegex` returns `filesEligible` (in-scope before the cap), so the handler can
say how many files were never opened, in words: *"scan cap reached: 5000 of 7528 in-scope file(s) were
read, 2528 were NOT searched. A count of 0 here does not mean the pattern is absent."* Confidence drops
to `medium` and a scoping fallback is suggested. `truncation` now also carries `filesEligible` +
`filesUnscanned`. Note the second half of this bug: at `profile:"nano"` `coverage` collapses to a bare
confidence string, which threw the gap text away exactly when it mattered — nano now keeps the full block
whenever there is a gap. The cap is not yet a parameter.

**(b) `search_symbols(strategy:"name")` returns fuzzy near-misses with `count > 0` and `confidence:"high"`.**
`search_symbols(repoId:"wec.be", query:"ManualOutboundHandler", strategy:"name")` →
`count: 5`: `GlobalCRCOutBoundHandler`, `GlobalInBoundHandler`, `ExportOutboundAsync`, `GetHandler`,
`ReviewGMHandler`, with `coverage:{confidence:"high",knownGaps:[]}` and no score or `matchType` field
in that response shape. The symbol does not exist in that repo. The same query with `ranked:true`
elsewhere honestly returns `count: 0`. **Ask:** tag results `matchType:"exact"|"fuzzy"`, or make
`strategy:"name"` exact by default with the fuzzy fallback behind a flag — and never report
`confidence:"high"` for a fallback-only result set.
**Fixed 2026-08-10, and the cause was not FTS.** The 50 rows came from the **vector near-neighbour
padding** in `searchSymbolsImpl` (it fires when FTS returns fewer than 3 hits and pads to `limit`), not
from `buildFtsQuery`. Those rows are now tagged `matchType:"fuzzy"`. When the whole set is fuzzy —
i.e. nothing matched by name — coverage drops to **`low`** and says so: *"no symbol matched X by name;
all N results are vector near-neighbours and may share no name token with the query. Treat this as
'not found, here is what is nearby'."* A partially-fuzzy set drops to `medium` and reports the ratio.
The padding is kept, because it does rescue a near-miss spelling; what changed is that it is labelled.

**(c) `link_tests_to_source` ignores `filePath`, and now returns docs as `sourceFile`.**
`link_tests_to_source(repoId, filePath:"src/Domain/Entities/Conversation.cs", minScore:0.5)` returns
**20 repo-wide pairs**; exactly one involves the requested file. And with the docs lane enabled:
```json
{"testFile":"tests/.../ReplyCallLogConversationCommandHandlerTests.cs",
 "sourceFile":"docs/02-flows/flow-call-log-reply.md","score":0.5,"reasons":["name-affinity"]}
```
**Ask:** honor `filePath` as a filter, and exclude non-code files from the `sourceFile` candidate set.
**Fixed 2026-08-10.** Both. `filePath` seeded the TEST candidate set but never constrained the answer, so
every selected test was paired with its OWN best source — when the caller names a non-test file, that
file is now the anchor and only pairs whose `sourceFile` is it are returned. Separately, the source
candidate set was "everything that is not a test", which with the docs lane enabled included Markdown;
non-code extensions are excluded, so a flow document can no longer be reported as the code under test.
`excludeTests` was also added (MCP-ISSUE-056), filtering the source side only.
**Follow-up 2026-08-10 (code review): the anchor was applied too late to work.** It ran as a
post-filter over `output`, after the scoring loop had already (a) sliced each test's candidates to
`maxCandidates` — default **3** — and (b) executed `if (output.length >= limit) break`. So the anchored
pair could be discarded before the filter ever saw it: dropped in favour of a test's own better-scoring
source, or never produced because the loop broke on `limit` first. The symptom is the one the fix was
written for, inverted — `link_tests_to_source(filePath: X)` answering "no covering tests" for a file
that has them, which `change_impact` then reports as `residualRisk.untestedChangedFiles`. The anchor is
now applied **inside** the loop, before `maxCandidates` and before the `limit` break, so only rows that
survive it count toward `limit`.

**(d) `query_docs mode:"search"` is over-fuzzy and mixes `code_block` content into a prose search.**
`query_docs(repoId, mode:"search", query:"ConversationNote")` returns exactly one result: a mermaid
`contentType:"code_block"` in `docs/00-overview/architecture-highlevel-nontech.md` whose text matches
only the words *"pinned note"*. Cross-checked with
`search_regex(pattern:"ConversationNote", filePathPrefix:"docs", scanAll:true)` → `count: 0` over 53
files, i.e. **0 was the correct answer**. Meanwhile `mode:"stale"` on the same symbolId correctly
returns 0 because it counts prose only — so `search` and `stale` disagree on what a mention is.
**Ask:** an exact/phrase option, and a `contentTypes` filter (`heading` | `prose` | `code_block`).
**Fixed 2026-08-10 (the filter half).** `query_docs{mode:"search"}` takes `contentTypes`, and now defaults
to `["heading","prose"]` — so the mermaid `code_block` matching only "pinned note" no longer answers a
type-name query, and `search` agrees with `stale` about what a mention is. Pass `["code_block"]` (or all
three) to widen. **Not done:** the exact/phrase option; the query is still FTS token matching.
Credit where due: `mode:"stale"`'s hint and `mode:"coverage"` (30 symbols, 15 documented, per-symbol
`mentionCount`) both behaved exactly as advertised.

**(e) `change_impact.residualRisk` tells you to run tests for Markdown and Dockerfiles.**
`change_impact(repoId, baseRef:"HEAD~2", impactLimit:400)` on a docs-only diff (10 `SKILL.md`, 3
`docs/*.md`, 1 `Dockerfile`) puts all 14 in `residualRisk.untestedChangedFiles` with *"14 changed
file(s) have no linked test — run the broader suite for these."* Also
`riskSummary:{low:14, maxRiskScore:0}` — 14 files scoring 0 are bucketed `low` rather than a
`none`/not-applicable bucket. **Ask:** partition `residualRisk` into code vs non-code.
**Fixed 2026-08-10.** `residualRisk.untestedChangedFiles` now holds only files that COULD have a test;
docs/config/images move to `nonCodeChangedFiles` and the note says which is which. `riskSummary` gained a
`none` bucket for files scoring 0, so a docs-only diff no longer reports `low: 14` — which read as a
finding rather than as "nothing measurable happened".

**(f) residual generic-name cross-repo edges, and a split path style inside one response.**
Follow-up to `MCP-ISSUE-045`: the `Task` case is **gone and verified clean** — all 13 hub→ssnet
targets are now real contracts (`SSNet.CommunicationHub.Messaging` 34, `OutboundFlowType` 21,
`IOutboundDeliveryPublisher` 8, `QueueNames` 5, `ManualCallLogSourceType` 4). Residual, 4 edges of 123:
`Message` → `src/SSNet.ChatGpt/Model/ChatResponse.cs`, `Request` →
`src/SSNet.Instrument.Api/Models/Request/Request.cs`, `Program` →
`samples/QueueManagement/SS.QueueManagement.Publisher/Program.cs`. Also `SSNet.sln` appears as an edge
target with 32 edges alongside the `.csproj` with 34, which looks like the same package reference
counted twice. Separately, one `query_graph` result set returned method rows with forward slashes and
their joined parent rows with backslashes — the `MCP-ISSUE-049` path-style split, still observable
within a single response.
**Partially fixed 2026-08-10.** The generic-name residue is closed: `isTooGenericToCrossRepos`
(`edgeResolverRefs.ts`) is the sibling of the existing framework-type gate — framework names are excluded
because they belong to the BCL, these because *every* repo declares its own (`Program`, `Message`,
`Request`, `Response`, `Context`, …). A distinctive contract name such as `IOutboundDeliveryPublisher` is
unaffected. **Not done:** the `.sln`/`.csproj` double-count, and the path-style split inside a single
`query_graph` result set — that one is a raw-row response, so it needs the normalization applied at the
SQL projection rather than at the response layer.

---

