## MCP-ISSUE-061 — the docs lane stores no prose, and the 2026-08-10 `contentTypes` fix narrowed the default search to headings alone

- **Status:** **OPEN** — filed 2026-09-16 from a four-track discovery sweep run for a docs-first
  consumer. Eleven defects confirmed; **four further claims were investigated and REFUTED** and are
  recorded below so they are not re-proposed.
- **Scope:** `mcp-local`, `wec.communication-hub`, `wec.rag`, `wec.social-ads` (measured); the fixes
  are all in `codebase-index-mcp`.

### (a) `contentType:"prose"` is advertised, is the default filter, and no code path writes it

`query_docs{mode:"search"}` defaults to `contentTypes: ["heading","prose"]` (`docsStore.ts:353`) and
the value is advertised in both schema sites (`tools/readMetadata.ts:136`,
`types/schemas/readMetadata.ts:80`) and in the golden contract. But `parseMarkdownFile` writes only
`"code_block"` (`markdownParser.ts:49`) and `"heading"` (`:79`, `:100`). Prose lines are scraped for
mentions at `:90` and the line itself is **discarded**.

Measured on the central index — every repo, all content types:

```
heading     2 259
code_block  1 810
prose           0
```

`mcp-local` alone: 1 378 heading, 294 code_block, 0 prose. Mean heading `text` length **35 chars**,
max 192. So the default search answers from titles.

Repro: `query_docs(repoId:"mcp-local", mode:"search", query:"forbidden token list per-dialect
decision")` — a phrase present verbatim in the prose of `.claude/rules/db-guardrails.md` — returns
`count: 0`.

**This is a regression introduced by a fix, not an original gap.** The `contentTypes` filter shipped
2026-08-10 against MCP-ISSUE-058(d) (over-fuzzy search; a mermaid `code_block` answering a type-name
query) and is recorded earlier in this file. Its default of `["heading","prose"]` assumed a `prose`
row existed. Net effect: `code_block` (1 810 rows) left the default, `prose` (0 rows) joined it, and
the searchable corpus fell from 4 069 rows to 2 259 rows of headings. The precision bug was traded for
a recall collapse, invisible because the assertion made at the time — "the mermaid block no longer
answers" — was true.

**The LIKE fallback does not rescue it.** `docsStore.ts:376-383` triggers when FTS is unavailable *or*
matched nothing, but it applies the **same** `content_type in (...)` filter as the FTS branch
(`:364` vs `:381`), so it cannot reach `code_block` either.

**Cheapest correct fix:** add `code_block` to the default at `docsStore.ts:353`. One line, no
migration, restores 1 810 rows immediately. The full fix is a prose writer.

### (b) Three spellings of the third content type, and a fourth dead mention type

`DocRecord.contentType` is `"heading" | "code_block" | "paragraph"` (`types/index.ts:306`); the store
default and the tool enum say `"prose"`; the writer emits neither. `"prose"` is the one in the
published contract, so it should win and the type union is what changes.
`DocMentionRecord.mentionType` likewise declares `"heading"` (`types/index.ts:325`), never emitted —
`extractMentionsFromText` produces only `backtick` and `filepath`.

### (c) `mode:"coverage"` reports a page length as a total — and the cap is live

`findDocCoverageImpl` hardcodes `limit 200` (`docsStore.ts:579`) while the tool advertises `limit` up
to 500, and sets no truncation flag, so `count` in the envelope is the post-cap length. The graph
holds **381** non-module symbols, so this fires on real files today. `findStaleDocsImpl` has the same
hardcoded cap (`:534`) but is currently theoretical — the maximum mentions for any single symbol
corpus-wide is 49. Same defect class as `detect_changes.changedFileCount` under MCP-ISSUE-060; the fix
should take the same shape (true count + `returned` + `droppedByLimit`).

### (d) There is no response size budget anywhere in the server

No byte, character or token cap exists in `src/middleware/`. `responseBytes`
(`responseFormatter.ts:94`, `:175`) is telemetry — measured, logged to stderr, never enforced. And
`profile` does almost nothing for `query_docs`: `responseFormatter.ts:163` shows `nano`/`compact`
differ from `standard` **only** by dropping nullish keys — no field selection, no row cap, no text
truncation. `get_file_context` received an edge budget after returning 68 663 chars; the docs lane
never got the equivalent. **This blocks any prose work**: 500 prose sections would leave as one
unbounded string.

### (e) Indented fences are not detected

`markdownParser.ts:34` tests `line.startsWith` against a triple-backtick prefix. The `mcp-local`
corpus contains **28 fences indented inside list items**. For those `inCodeBlock` never toggles, so
the body is scanned as prose and any `#` comment inside becomes a real heading — the exact failure
MCP-ISSUE-049 was opened to fix, still present for the indented case.

### (f) docId collisions overwrite silently

Code-block docIds are `hash(headingPath + ":code:" + content.slice(0,50))` (`markdownParser.ts:43`);
heading docIds are `hash(filePath + "#" + headingText)` (`:70`, `:73`), and `currentHeadingPath` holds
only the **last** heading, not an ancestry path, so a repeated heading text in one file collides
regardless of level. Collisions resolve as silent overwrites through
`on conflict(repo_id, doc_id) do update set text = excluded.text` (`docsStore.ts:12`).

**Measured, not assumed:** reimplementing the hash over the real corpus yields **3 code_block + 2
heading collisions = 5 rows lost of ~1 672 = 0.3%**, all three code collisions inside
`.claude/commands/mcp-effectiveness-eval.md`. A stable docId needs a line number, and neither
`DocRecord` nor the `docs` table has a line column.

### (g) `docsUpserted` counts the array, not the rows

`indexPipeline.ts:204-206` increments by `extracted.docs.length` at the funnel, before the write, so
the collisions in (f) are absorbed rather than visible.

### (h) The LIKE fallback has no relevance order, and the re-sort breaks past 99

`docsStore.ts:381` orders by `rowid` — insertion order. And the client-side re-sort that restores FTS
rank (`:438-441`) assigns missing ids a sort key of `99`, which misorders any result set larger than
99.

### (i) Both docs flags default to `false`

`CODEBASE_INDEX_DOCS_INDEXING_ENABLED` and `CODEBASE_INDEX_DOCS_TOOLS_ENABLED` are both `false`
(`src/index.ts:74-75`), so a fresh clone has no docs lane at all and must opt in twice. For a
docs-first consumer this is the single highest-leverage default in the server.

### (j) Three documents describe a JS-only SQLite backend that has never existed

`CLAUDE.md:149`, `docs/development/workflow.md:277` and `docs/guides/onboarding.md:26-28` all tell the
reader to "switch to the JS-only SQLite backend" if the native build fails. All ~25 SQLite touch
points import `better-sqlite3` directly and unconditionally (`graphStore.ts:21`, `schema.ts:15`,
`docsStore.ts:1`, ...). There is no driver abstraction and no reference to `node:sqlite`, `sql.js` or
wasm anywhere in `src/`.

### (k) `isLikelyMinified` applies to markdown — latent, not currently firing

`fileFilter.ts:253-259` skips any file over 10 KB whose average line length exceeds 500, and markdown
is not carved out. A document written one long line per paragraph would be dropped with no error.
**Measured: 0 of 107 files exceed it** — the longest average line length in the corpus is 101.7, a 5x
margin. Recorded as a latent hazard, not as work.

---

### REFUTED — four claims that did not survive verification

Recorded because each was argued from real evidence and each is wrong. Do not re-propose them.

| Claim | Why it is wrong |
|---|---|
| "Disable `CODEBASE_INDEX_VECTOR_ENABLED`: the lane costs 27 860 ms per run and resolves nothing." | The 27 860 ms is the **pre-fix** figure from MCP-ISSUE-039, whose header reads `Status: FIXED 2026-07-30`. Post-fix `callResolveMs` is **4 485**, below the 4 953 pre-regression baseline; the lane now self-limits after 100 lookups with no hit. That entry already decided the question — *"Neither disabled (it can pay where unresolved tokens are in-repo near-misses) nor unbounded."* Disabling would also silently regress `search_symbols`: `symbolSearchQuery.ts:88` pads thin FTS result sets with vector neighbours behind `isVectorEnabled()`. |
| "The 43-tool `tools/list` costs ~11 174 tokens of context per session." | Only for a client that requests full schemas. Full schemas are 44 695 chars (~11 174 tok); the **name-only listing is 1 698 chars (~425 tok)**, a 26x difference, and Claude Code defers tool schemas by default. Real fixed overhead is ~15 127 tok, of which **97% is this repo's own markdown** (`mcp-hard-mode.md` alone is 53.5%), not the tool surface. Any plan to consolidate the tool count on token grounds is attacking 2.8%. |
| "docId collisions are the dominant shape in this workspace's docs." | 0.3% — see (f). The reasoning (consecutive shell blocks under one `## Commands` heading sharing their first 50 chars) is sound; the frequency was asserted, not counted. |
| "The corpus is uniformly LF" / "the corpus is uniformly CRLF." | Both wrong. **3 CRLF files, 104 LF.** But `core.autocrlf=true`, so a fresh Windows clone produces CRLF throughout. The parser survives today only because `.trim()` incidentally strips the carriage return on headings (`markdownParser.ts:70`, `:80`); **prose lines are trimmed nowhere**, so a prose chunker that stores raw lines would persist a trailing carriage return on every line and pollute FTS tokens. A bug that a prose lane would *introduce*. |

### Corpus measurements that ground any fix here

From a full survey of `mcp-local` (107 `.md`, 1.31 MB, ~336 K tokens; 0 `.mdx`), cross-checked against
`wec.communication-hub` (82) and `api-testing-studio` (86):

```
1 327 headings   H1 108 - H2 747 - H3 455 - H4+ 17   -> a 2-3 level tree covers 99%
1 374 sections   median 640 ch (~160 tok) - p90 2 149 ch (~540 tok) - <=2 KB = 90%
  320 tables     73/107 files - 2 925 rows = 21% of all content lines - median 7 rows
  311 fences     49% carry no language tag (procedural recipes and ASCII diagrams, not code)
                 40 (12.9%) exceed the 500-char store limit; at 1 000 only 6 (1.9%) would
  319 links      all relative .md - 0 wiki-links, 0 external URLs, 0 reference-style, 0 anchored
   39 files      have YAML front matter; ALL are Claude Code artifacts. 0 of the 47 under docs/
```

Two consequences for design, both of which overturned a plausible first plan:

- **Front matter cannot carry doc metadata here.** Zero coverage on `docs/`. The real convention is
  body-level `**Status** — Accepted` (em-dash, not colon) in all four ADRs,
  `**Risk**`/`**Complexity**`/`**Rollback**` in 32 files, `Status` as a table column in 11, and
  supersession expressed structurally as `docs/archive/superseded/` plus a link table in
  `docs/archive/README.md`. `owner`/`tags` appear nowhere in any form.
- **A doc-to-doc link extractor needs one parser, not five.** CommonMark inline links with three
  resolution rules — bare relative (133 = 43%), parent-relative (140 = 44%), dot-slash (46 = 13%) —
  plus dropping the 23 pure-anchor links. It must be fence-aware or it will harvest the 28 indented
  fences and 320 tables full of link-shaped example text.

Mention resolution, for scale on (c) and on any drift reporting: `wec.social-ads` resolves 127 of 984
backtick mentions (13%), `wec.rag` 112 of 268 (42%).

**Correction (2026-09-16, while implementing `mode:"drift"`):** an earlier draft of this entry said
`resolveMentionsImpl` **discards** every mention it cannot resolve. It does not. Unresolved mentions
stay in `doc_mentions` with `symbol_id = null` — 1 218 rows for `mcp-local`, 659 for
`codebase-index-mcp` — and were simply never read back by any tool. The defect was a missing read,
not a lost write, which made the fix considerably smaller than this entry originally implied.

Reading them raw is still not useful: the most frequent unresolved mentions here are **MCP tool
names** (`find_impact_files` 91, `health_check` 79, `search_symbols` 77), because a document about a
tool names the tool. `mode:"drift"` therefore reports only near misses against an existing symbol,
after filtering naming-convention variants (`find_implementations` vs `findImplementations`) and
plurals (`contentTypes` vs `contentType`) — 1 218 unresolved → 152 near misses → 23 candidates.

### Stage 3 outcome (2026-09-16) — four shipped, one measured away

| Item | Outcome |
|---|---|
| doc→doc link graph, `mode:"links"` | Shipped. 258 links over 107 files, **0 broken**, 33 orphans. Zero broken is the load-bearing number: wrong path resolution would have produced false "broken" everywhere |
| document lifecycle, `includeArchived` | Shipped. 82 active / 21 archived by path / 4 ADRs `accepted` via the em-dash `**Status**` line. A search for "cheatsheet" returns 0 by default and 5 with `includeArchived` |
| `mode:"drift"` | Shipped. 1 218 unresolved mentions → 152 near misses → 23 candidates after filtering convention variants and plurals |
| `mode:"behind"` | Shipped. `mcp-local` 89 docs compared / 57 behind; `codebase-index-mcp` 7 / 4 |
| registry-noise weighting | **Dropped — the premise did not survive measurement** |

**Why the weighting item was dropped.** The plan asserted that five files at 17%+ of the corpus
(`mcp-codebase-index-issue-registry.md` alone is 229 KB) would dominate any ranked retrieval, and that
a weighting or exclusion policy was a prerequisite for ranking work. Measured on actual search
results, it does not happen: across four probe queries the worst case was **4 of 20 results from one
file**, with 11–18 distinct files per 20 results, and the 104-row registry topped none of them.

The obvious explanation — that the Stage 3.2 archive filter had already removed three of the five
offenders — is **also wrong**: concentration is essentially identical with `includeArchived` on and
off. The actual reason is that FTS5's bm25 normalizes by row length, and a doc row is one short
heading, so a large file gets more rows but no per-row advantage.

Two theories, both refuted by the same measurement. Recorded so neither is re-proposed. If prose
sections land (Stage 4) rows get much longer and this should be **re-measured**, not assumed either
way.

### Stage 4 outcome (2026-09-17) — the prose lane

The defect this whole entry opened on is closed. `parseMarkdownFile` emits `prose` sections.

```
prose                0 -> 1603 rows (avg 754 chars)     heading 1437     code_block 303
docId collisions     5 -> 0        (ids hash the start line; two nodes cannot share one)
carriage returns          0        (CRLF stripped at read; core.autocrlf=true makes clones CRLF)
rows with no span         0
chunks over budget        0        (largest 2047 of 2048)
table chunks            368, of which 0 lost a header row
```

Chunk budget 2048 chars (~512 tokens) from the corpus: median section 640, p90 2149, 90% under 2 KB.
Code-block text 500 → 1000 chars, cutting truncation from 12.9% of blocks to 1.9%.

**Not yet done, and the success criterion is therefore unproven.** The plan set "≥15/20 recall on a
20-query prose set", and Stage 0's measurement harness was never built — shipping was prioritized
over instrumenting. Three hand-picked phrase queries went 0 → 4, 0 → 4, 0 → 5, which demonstrates the
capability but is not the metric. Anyone continuing this work should build the Stage 0 harness before
claiming a recall number.

**Operational:** prose rows, doclinks and `doc_status` are all written at index time. An index built
before these stages has none of them — run `index_repository(mode:"full", docsMode:"on")` after
restarting the server.

### Stage 5 + 6 outcome (2026-09-17)

**Stage 5 — the plan was wrong about its own content, and the harness said so.** The plan called for
`exact/phrase` matching. Phrase is NARROWER than the AND query that was already failing, so it would
have moved nothing. What was actually broken: `buildFtsQuery` joins prefix terms with an implicit
AND, so a nine-word question demanded all nine tokens in one chunk.

```
intent queries, strict AND   0/10   (7 of them returned no rows at all)
intent queries, broad OR     7/10
```

`buildIntentFtsQuery` — the OR builder — already existed for symbol search and had never been wired
to docs. `mode:"search"` now runs strict first and tops up from broad, labelling broad rows
`matchTier:"broad"` per MCP-ISSUE-058(b). Result: **10/20 → 18/20**, past the plan's ≥15/20.

Also fixed here: the LIKE fallback ran whenever FTS "matched nothing" (now: only when FTS is
unavailable) and ordered by `rowid`; and 061(h)'s rank-99 sort key.

The two residual misses are ranking limits, not defects — "why are servers not in the npm workspace"
tops out at `backlog.md` instead of ADR 0001, and "which database environment is always read only"
answers sqlserver instead of postgres. Stage 7 now has a target to beat rather than an argument.

**Stage 6 — `mode:"language"`.** Non-ASCII **letters** (`\p{L}` outside Basic Latin), per chunk.

The naive signal is worthless here: "any non-ASCII codepoint" flags **100 of 107 files**, because
this prose is full of em-dashes (3 246), arrows (748), middots (578), box-drawing (~670) and check
marks (317). Restricting to alphabetic characters flags **2 files at the 0.5% default** — exactly the
two Vietnamese READMEs — with 105 clean. At 0.1% four more appear, and their "letters" are a Greek
`Δ`: a true positive by the rule, and the reason the threshold exists.

Per chunk rather than per file, because the text is mixed *within* paragraphs — Vietnamese prose
wrapping English identifiers. That granularity is what makes it a progress meter:
`postgres-mcp/README.md` reports 20 of 30 chunks flagged, so ten are already English.

Computed on read, not stored: the scan is free at this corpus size and it works on an index built
before the feature existed.

**Stage 6.2 (cross-repo) needs no code.** The doc link graph already resolves within a registered
repo tree, including a sub-repo like `codebase-index-mcp` inside `mcp-local`. Links *between*
separately registered repos do not occur in practice — these are different projects. What remains is
operational: run `index_repository` for the other repos. Noted so the item is not carried as
outstanding engineering.

### Still open: "Connection closed" in `verify:enhancements`

New evidence, no diagnosis. It fails at **~8s**, far under any request timeout, so the server process
is going away rather than the client giving up. Standalone: **3 of 3 passes**. Inside
`scripts/run-tests.mjs`: intermittent, roughly one run in three, always at the same step.

An earlier commit added a request timeout here on the theory that the SDK's 60s default was expiring,
and one green run was read as confirmation. **That was wrong** — see the timing above. The timeout
stays on consistency grounds; the comment in the harness now says it is not a fix.

`SHOW_SERVER_STDERR=1` is wired into the harness. Run the SUITE with it set — not the harness alone,
which does not reproduce — until the failure recurs, and read what the server wrote before it exited.

### "Connection closed" — 2026-09-17 hunt: no diagnosis, but the blocker to diagnosing it is gone

Six consecutive suite runs with capture on. It reproduced **once**, and what it produced settled two
things and refuted one.

**It is not specific to `verify:enhancements`.** The occurrence landed on
`test:value-contract-impact`, with the same `McpError -32000` at
`ChildProcess._handle.onexit` — the child process exits. So this is a property of the stdio server
under `scripts/run-tests.mjs`, not of one script. Standalone it passed 3 of 3, and in the runner it
is roughly one run in three.

**The blocked-pipe mechanism does not explain it.** That mechanism is real — MCP-ISSUE-049
demonstrated it here — but two data points contradict it as the cause of this:
`verify-enhancements.mjs` failed while drained via `on("data")`, and `test-value-contract-impact.mjs`
failed while drained via `resume()`. Mechanism still not established.

**Why six runs produced nothing readable.** `transport.stderr?.resume()` unblocks the pipe by
DISCARDING every byte. When the server dies, Node writes the stack trace to stderr, and that drain
throws away precisely the thing worth reading. Counted across the harnesses: 7 drained nothing at all,
6 used `resume()`, 2 used an `on("data")` no-op. Every one of the 15 either blocked or went silent.

`scripts/test/_serverStderr.mjs` replaces all 15: always drain, keep the last 64 KB, print that tail
when the process is about to exit non-zero, or stream it live under `SHOW_SERVER_STDERR=1`.

**Next step, concretely:** run `npm run test` in a loop until a harness fails. The tail now prints
automatically on the failing run — no env var needed. Read what the server wrote before it exited.
Two earlier attempts at this item were closed on a theory that a single green run appeared to
confirm; do not close it that way a third time.

### "Connection closed" — 2026-09-17, second hunt: characterized, still not root-caused

The capturing drain worked. Three occurrences, three DIFFERENT harnesses, one shape.

| Occurrence | Harness | Duration | Server's last words |
|---|---|---|---|
| 1 | `verify:enhancements` | ~8s | `server_ready`, then nothing |
| 2 | `test:value-contract-impact` | **37.3s** (normally ~5s) | indexed `service-a`, two `fatal: not a git repository`, then nothing |
| 3 | `test:field-access-rhs` | 14.9s | `server_ready`, two `fatal: not a git repository`, then nothing |

**The decisive new fact: the server writes NOTHING before it dies.** No exception, no stack trace, no
`tool_threw`. Node prints an uncaught error to stderr, and the drain now captures stderr, so a JS
failure would be visible. It is not. The client sees `McpError -32000` at
`ChildProcess._handle.onexit` — the child exited.

Occurrence 2 also shows it **hangs first**: 37.3s against a ~5s norm, well under the SDK's 60s
request timeout, so the client was still waiting when the process went away. And it died between the
first and second `index_repository` call — `service-b` never appears.

**Established:** load-dependent (only under `scripts/run-tests.mjs`, roughly one run in three;
3 of 3 passes standalone), harness-independent, and silent at the JS level.

**Refuted, both mine, both from theorising before measuring:**

- *Blocked stderr pipe.* A real mechanism — MCP-ISSUE-049 proved it here — but not this one:
  occurrence 1 was drained via `on("data")` and occurrence 2 via `resume()`.
- *Shared temp database.* Each harness gets its own through `mkdtempSync`, so no two can collide.

**The lead worth following next.** In occurrences 2 and 3 the last thing the server emitted was
`fatal: not a git repository` — stderr from `runGit`, which is `execFileSync`: a **synchronous child
process spawn inside the server**. Three deaths cluster immediately after synchronous spawns, on
Windows, while 41 harnesses compete for the machine. That is a correlation, not a cause. The
experiment is to instrument `runGit` call counts and timings, or stub git out for one suite run and
see whether the flake survives it.

Do not close this on a green run. Two previous attempts were, and both of those theories are in the
refuted list above.

### MCP-ISSUE-060 — `rename_assist(emitPreview:true)` preview recall — FIXED 2026-09-17

**Cause: a category error.** The preview was scoped to `affectedFiles` — the declaring file plus
whatever carried a resolved `CALLS` or `IMPORTS` edge to that exact symbolId
(`impactRenameTrace.ts:getRenameImpactImpl`). But a rename must touch every **textual** occurrence of
the identifier, and the graph only knows the subset it resolved: `import { x } from './y.js'` produces
an IMPORTS edge to the MODULE `y.js`, not to the symbol `x`, and a file that merely mentions the name
— a type annotation, a re-export, a doc comment — contributed nothing at all. Using the graph to
scope a textual rewrite is the wrong instrument, not a tuning problem.

The consequence was the dangerous shape: the preview came back with `riskFlags: []` and looked clean
while missing most of the work, so applying it left other files calling a name that no longer existed.

**Reproduced before changing anything**, on `codebase-index-mcp`, graph-scoped against the identical
unscoped scan:

```
searchDocsImpl        3 hunks vs  4   (25% missing)
parseMarkdownFile     7 hunks vs 10   (30% missing)
issueApprovalToken    8 hunks vs 11   (27% missing)
```

The original report measured 17–22% recall on `wec.communication-hub`, where the C# graph is sparser.

**Fix:** the scan is repo-wide, which is what `refactor_replace_preview` always did and what measures
complete. `scopePaths` narrows it for a caller who wants that DELIBERATELY, rather than being narrowed
silently by how much of the graph happened to resolve. The graph findings are still reported — "who
calls this" is a good question, it is just not the same question as "where does this name appear".

**Verified at parity**, hunk-for-hunk against `refactor_replace_preview` on five symbols: 5/5.

**Guarded.** `test:refactor-engine` §3.12 gained a fixture, `src/mentionsOnly.ts`, that names the
identifier in a comment and a string with no import and no call — so it carries no edge and the old
scoping could not see it — plus two assertions: that the preview reaches that file, and that its
`totalMatches` equals `refactor_replace_preview`'s. This defect survived for weeks because no harness
asserted recall; both assertions fail if the graph scoping returns. 71/71.

**Occurrence 4 (2026-09-17, later).** `verify:enhancements` again, 8.9s, step 5. Same signature:
`server_starting`, `server_ready`, `✓ index verify-self · 238 files · 3.1s`, then nothing. Standalone
immediately afterwards: PASS.

It **weakens the runGit lead**. Occurrences 2 and 3 ended with `fatal: not a git repository`;
1 and 4 did not. So the correlation is 2 of 4, not the 3 of 3 it looked like. Still worth the
experiment — the deaths cluster around index runs, which is where the synchronous spawns are — but
it is no longer the standout.

What survives all four: the server writes nothing at the JS level, it dies during or just after an
`index_repository` call, and it never reproduces standalone.


### `mode:"behind"` — two defects, found on `wec.aria` (2026-09-17)

Both are the shape this program keeps finding: **a number describing something other than the list
beside it.**

**(l) `newerCode` was capped at five with no total.** `docFreshness.ts` deduplicated the newer code
files by path and then `.slice(0, 5)`, reporting neither the cap nor the count. On `wec.aria`,
**37 of 106 rows were truncated, hiding 206 code files**; the widest,
`specs/SPEC-021-ingest-http-surface.md`, showed 5 of **22**. A review queue whose rows all look five
files wide cannot be prioritised — the doc trailing 22 files was indistinguishable from one trailing
one. Fixed by adding `newerCodeTotal` beside the sample. mcp-local: 6 rows, 22 hidden files, widest
12.

**(m) `docsCompared` counted documents that were never compared.** `filesCompared: byDoc.size` was
read off the map of documents *with mentions*, while the loop below it `continue`s on any document
git has no commit time for. Those documents were counted as compared while no comparison ran:
**147 → 145** on `wec.aria`, **69 → 65** on mcp-local. Now counted inside the loop.

**Refuted while measuring this.** The four top rows all cited `Customer` in
`packages/contracts/src/entities/customer.ts`, committed that day, which looked like one touched file
flooding the queue. It is not: the top drivers are `identity/src/introspection.ts` (26 rows),
`contracts/src/entities/market.ts` (24) and `core/ports/index.ts` (21) out of 106 — spread, not a
flood. The 72% rate on `wec.aria` is real; it is a docs-first repo mid-refactor.

### (n) `mode:"drift"` precision was ~0/6 on an unfamiliar repo (2026-09-17)

First run of `drift` against `wec.aria` returned 99 candidates whose **top six were all false
positives**, in three classes:

| Class | Example | Why it is not drift |
|---|---|---|
| A backticked English word | `terminate` → `terminated`, `retrieved` → `Retriever`, `schedule` → `scheduler`, `verified` → `VERIFIER` | Backticking a word is typography; the metric then matches any symbol sharing its root |
| Nearest symbol in test / fixture / build output | `VERIFIER` in `dep-lint/samples/`, `MarketRegistry` in `core/dist-runtime/` | Nobody renamed a document's subject to a symbol living in a fixture or a compiled copy |
| A live enum or config **value** | `erasure_queued` (0.93 vs `ERASURE_QUEUE`), documented under `4. Enumerations` | The document describes a value that exists; the enum is working as intended |

Three guards, each measured on two repos before shipping, each **reporting its own count** in
`suppressedAsNoise` so the queue never shrinks silently:

- `isPlainWord` — a single all-lowercase alphabetic token. Removes 39/99 and 25/61. Stated cost: a
  genuine one-word lowercase rename (`orient` → `orientate`) goes with them, the same trade the
  existing convention and plural guards already make.
- `isNonProductionPath` — test, spec, fixture, sample, mock, and `dist*`/`build`/`out`/`coverage`.
  Removes 20 and 2.
- `literalExists` — the mention text appears verbatim in `string_literals` for that repo. Removes 11
  and 7.

Plus a widened plural guard: `stem` strips one `s`, so `deprecatedAliases` stemmed to
`deprecatedaliase` and never met `deprecatedAlias`. Comparing the **set** `{key, key−s, key−es}`
catches both and can only add matches — stripping `-es` unconditionally would break `nodes`/`node`.

**Result: 99 → 29 on `wec.aria`, 61 → 27 on mcp-local**, and the survivors are what the mode was for:
`normalizedPath` → `normalizePath`, `callEdgesUnresolved` → `callEdgesResolved`,
`filesUnscanned` → `filesScanned`, `hasOnConflictUpdate` → `hasOnConflictDoUpdate`.

**Known residue, not fixed.** Antonym pairs score high and mean opposite things — `calleeCount` vs
`callerCount`. Separating them needs semantics, and a document naming `filesUnscanned` where only
`filesScanned` exists is arguably a real doc error, so they stay.

### "Connection closed" — occurrence 5, and the "load" framing is refuted

`verify:enhancements`, 8.3s, slot **3 of 41**. Standalone immediately after: PASS. Three suite runs
the same afternoon went pass / fail / pass, so it is roughly one in three.

Slot 3 kills the working frame. `scripts/run-tests.mjs` has **no concurrency** — no `Promise.all`, no
pool, no worker cap — so nothing runs beside it, and the only two harnesses before it are
`test:unit` (node:test, no DB, no server) and `guard:no-llm-runtime` (a static import scan). Neither
boots a server, opens the index or spawns git. There is no accumulated state for them to have left.

So "load-dependent" was the wrong word for "only fails inside the suite", and the difference between
suite and standalone is now unexplained rather than explained. What still holds across all five: the
server writes nothing at the JS level, it dies during or just after `index_repository`, and it has
never reproduced standalone.


### (o) `docs_fts` was corrupt on every repo, and both code paths hid it (2026-09-17)

**The largest defect in this program, and it was invisible from inside the test suite.**

Found by asking `wec.aria` a question whose wording is a heading in
`docs/14-software-architecture.md`. It returned `count: 1` — that heading — and no body text. The
direct SQL underneath returned **43 rows** for the same terms. Probing it raised the reason:

```
SqliteError: fts5: missing row 14564 from content table 'main'.'docs'   (SQLITE_CORRUPT_VTAB)
```

Every repo, every `MATCH`: `mcp-local`, `wec.aria` and `codebase-index-mcp` all threw. So
`mode:"search"` had been answering from the **LIKE substring fallback** — unranked, no prefix
matching, no two-tier recall — for as long as the corruption existed. The Stage 5 ranking work was
running on nothing.

**Cause.** `docs_fts` is external-content (`content='docs'`). The rebuild cleared it with
`DELETE FROM docs_fts`, which on such a table must read every row's *current* text back out of
`docs` to know which terms to remove. Reproduced in isolation, that `DELETE` raises
`SQLITE_CORRUPT_VTAB: database disk image is malformed` on the **first** call — so the chunked
re-insert that followed was always building on a table that had just failed to clear. The one
correct statement is `INSERT INTO docs_fts(docs_fts) VALUES('rebuild')`, which re-reads the content
table from scratch.

**Why nobody saw it.** Two `catch` blocks, both behaving as designed:

- `rebuildDocsFtsImpl` caught the failure and logged a warning into the index run's output.
- `searchDocsImpl` caught it as `// FTS unavailable` and fell through to LIKE — and then labelled
  those rows `matchTier: "broad"`, asserting an FTS tier that had never run.

A corrupt index was therefore indistinguishable from a repo with no docs lane, and the tool reported
a confident-looking answer either way. This is MCP-ISSUE-058(b)'s rule — *padding that looks
identical to a direct hit* — reappearing one layer down.

**Fixed, three parts.**

1. `rebuildDocsFtsImpl` uses `'rebuild'`. It is also ~10x faster: **196 ms for 10,882 rows**, one
   pass in C, against the chunked loop it replaces.
2. `matchTier` gains `"fallback"`. A LIKE row is now labelled as one, and `query_docs` emits a
   `degraded` string naming the repair.
3. `searchDocsImpl` distinguishes *corrupt* from *unavailable* and, on corrupt, repairs once and
   re-runs both tiers. A read-only handle throws again and falls through to the honest fallback.

**Measured, same query, same corrupt database:** `count: 1` (one heading) → **6 ranked results, five
of them prose**, from five different documents.

**Guarded.** `docsStore.test.ts` gained a test that writes two files' docs, rebuilds, replaces one
file's docs, rebuilds again, and asserts the surviving five rows are reachable through `MATCH`. A
single-pass test cannot catch this — a freshly built index is always consistent — which is the same
reason MCP-ISSUE-049 escaped its first fix. Verified red against the old rebuild. 177/177 unit.

**The live workspace index was repaired in place** (489 ms); `'pipeline'` now matches 46 / 154 / 1
rows across the three repos instead of raising.

### "Connection closed" — occurrence 6

`verify:enhancements` failed in the suite again and passed standalone immediately after, with the
`docs_fts` work in the tree. Unrelated to it, and unchanged in signature. Three of the four suite runs
this afternoon failed at that harness, which is the highest rate observed so far.

---

