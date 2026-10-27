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

