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

