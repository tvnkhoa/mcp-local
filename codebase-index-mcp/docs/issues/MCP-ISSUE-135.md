## MCP-ISSUE-135 — query_graph did not enforce timeoutMs: a heavy query froze the server thread for every session

- **Status:** FIXED 2026-11-16 (row #13, branch `wt/qg-timeout`). Found by row #10 (session d754bd8e); design approved by
  the leader (session e242b81b).
- **Scenario:** looking for C# implementers that inherit an interface method from an in-repo base (MCP-ISSUE-133 row
  #10), a member ran `query_graph` on the LIVE, shared HTTP-served server against repoId `wec.be` (8 731 indexed files)
  with `timeoutMs: 30000`.
- **Tool/query attempted (MCP):** `query_graph`, repoId `wec.be`, `timeoutMs: 30000`, SQL verbatim:

  ```sql
  select count(*) as n, count(distinct k.symbol_id) as impls from (select distinct s.name as name, s.parent_symbol_id as ifaceId from edges e join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.to_id join symbols i on i.repo_id = s.repo_id and i.symbol_id = s.parent_symbol_id and i.kind = 'interface' where e.repo_id = :repoId and e.type = 'CALLS' and s.kind = 'method') c join edges ie on ie.repo_id = :repoId and ie.type = 'IMPLEMENTS' and ie.to_id = c.ifaceId join symbols k on k.repo_id = :repoId and k.symbol_id = ie.from_id join edges x on x.repo_id = :repoId and x.from_id = k.symbol_id and x.type = 'EXTENDS' and x.to_id not like 'base:%' join symbols b on b.repo_id = :repoId and b.symbol_id = x.to_id where k.file_path like '%.cs' and not exists (select 1 from symbols o where o.repo_id = :repoId and o.parent_symbol_id = k.symbol_id and o.name = c.name) and exists (select 1 from symbols bm where bm.repo_id = :repoId and bm.parent_symbol_id = b.symbol_id and bm.name = c.name and bm.kind = 'method')
  ```

- **Expected vs actual:**
  - **Expected:** the query is cut off at 30 s and the server keeps answering other calls.
  - **Actual:** no answer. The client moved the call to the background after 120 s and aborted it at 300 s. Meanwhile
    `query_graph` on `ssnet` and `search_regex` on `wec.social-ads` timed out client-side. The leader found the served
    process at 100% of one core with no index run in flight and restarted it on the owner's word (pid 85424 → 71572).
- **Cause:** `runReadOnlyGraphQueryImpl` (`src/services/impact/impactRepoSummaries.ts`) ran the statement as a
  synchronous `stmt.all(boundParams)` on the server thread; `timeoutMs` only set `timedOut` AFTER it returned
  (`elapsedMs > timeoutMs`). better-sqlite3 (11.10) exposes neither `sqlite3_interrupt` nor a progress handler, so
  nothing on that thread can stop a running statement.
- **Impact:** any caller could stall the shared served server for every session with one `query_graph`. The schema
  advertised a bound (`timeoutMs` maximum 30000) that was not enforced.

### Why not a worker thread (measured)

The first candidate was the read-only worker pattern of `vectorSearchWorker*.ts` (MCP-ISSUE-132). It does not stop the
statement: a worker thread running a long better-sqlite3 statement (an aggregate over a recursive CTE, no row before
the end) was sent `Worker.terminate()` after 1.5 s; the promise had not resolved 60 s later and the thread still held
its core. V8's termination only takes effect when the thread returns to JS, which a native SQLite step never does. A
worker would free the server thread but leave one thread burning a core per runaway query, indefinitely.

**This bears on MCP-ISSUE-132's worker:** a `search_symbols` KNN that outlives its padding budget keeps running in the
vector-search worker until SQLite finishes it — bounded (`MAX_PENDING` 4 queued scans, each a brute-force scan of one
repo partition, measured 0.05-2.9 s), but not stoppable. Its idle-exit `terminate()` likewise waits for a running scan.

### Fix

- `query_graph`'s statement runs in a forked CHILD PROCESS (`src/repositories/queryGraphRunner.ts`) on its own
  read-only connection; `runReadOnlyGraphQueryImpl` runs there unchanged, with every guard (scope CTEs,
  schema-qualifier refusal, EXPLAIN root-page check). Killing a process stops SQLite at once.
- `src/repositories/queryGraphRunnerClient.ts` (server thread): the `timeoutMs` timer starts when the request reaches a
  ready child; when it fires the child is killed and the call fails with code **`QUERY_TIMEOUT`**: "query_graph: query
  exceeded timeoutMs <budget> and was stopped after <n>ms. …". One idle child is kept warm; a kill starts its
  replacement at once. At most 3 statements run at a time; a 4th call fails at once with **`QUERY_BUSY`**. A child that
  exits mid-query fails that call (`INTERNAL_ERROR`, "the query runner process exited mid-query …"); nothing is
  retried. The idle child exits after 10 min; children exit when the server's IPC channel closes; shutdown kills them.
- The handler is async; without a runner (handler unit tests) the statement still runs in-thread, as before.

### Evidence

Harness `test:query-graph-timeout` (scratch DB, generated 120-file TS repo, cubic SELECT over `edges`, timeoutMs 2000):

| | before (eb7e730 build, negative control) | after |
|---|---|---|
| runaway query_graph | no answer; client request timeout 15 s | `QUERY_TIMEOUT`, stopped at 2021-2036 ms, call 2192-2263 ms (×3) |
| list_repositories during it | 4 001-4 013 ms (request timeouts) | 2-10 ms |
| health_check during it | 4 001-4 009 ms (request timeouts) | 160-389 ms (idle 145-210; it spawns git, the child holds a core) |
| normal query_graph | median 216 ms | median 214 ms; the first call after start-up +~200-400 ms (cold child) |
| killed child | — | pid gone (`process.kill(pid, 0)` throws), a fresh pid ready, each round |
| child killed from outside mid-query | — | clean `INTERNAL_ERROR` "exited mid-query" |
| child RAM | — | 47-67 MB working set, idle or busy |

The 16 Nov query itself, on `wec.be` indexed into a SCRATCH DB (`QG_REPO_PATH=D:/1.SourceCode/crm/wec.be
QG_REPO_ID=wec.be QG_SQL_FILE=<the SQL above> QG_TIMEOUT_MS=30000`; index 297 s), after the fix, ×3: stopped at
30 018 / 30 046 / 30 066 ms → `QUERY_TIMEOUT`, call 30 944 / 30 743 / 32 169 ms; list_repositories during it 6-23 ms
(n 42 / 43 / 13); health_check 323-2 778 ms (idle 646-1 410; the machine was shared with other runs); each killed pid
gone and a fresh one ready; child RAM 66-82 MB; normal query_graph median 460 ms. The query never finishes inside
30 s on this index, so the statement is the cost, not a lock wait.
Negative control, same query and scratch DB shape on the eb7e730 build (`QG_SERVER_ENTRY`, one round): no answer
within the 90 s request timeout; list_repositories and health_check sent during it got no answer within their 60 s
request timeouts; the next normal query_graph also got none within 90 s. That is the 16 Nov freeze, reproduced. After
the harness closed the stdio server, no server or runner `node.exe` was left.

### Other synchronous read paths (same class, not changed here)

`query_graph` is the only tool that runs caller-written SQL and the only one with a `timeoutMs`; no other read path
has a statement deadline. These run fixed-shape SQL synchronously on the server thread, bounded by row/depth limits
only, not by time (not measured in this row): `find_impact_files` (a 216 s case on a shared 54 MB DB is recorded in
`scripts/test/_fixtures.mjs`), `get_call_chain` / `trace_execution_flow`, `get_dependency_graph`, `dead_code_scan`,
`detect_circular_dependencies`, `query_docs` (stale / drift / links), `route_map`, and the file-reading
`search_regex` / `search_literals` (capped by limit and per-file caps). Any of them on a large repo can block the server
thread for as long as its statement runs. Candidate: move the heaviest behind the same runner once one is measured.

### Follow-up: the vector-search worker's timed-out scan (17 Nov, row 4, branch `wt/knn-cancel`)

The KNN behind `search_symbols` padding (MCP-ISSUE-132/136) stays in a worker thread: it is not caller-written SQL,
and the memo makes a late answer useful. A scan still cannot be interrupted. Each widening round of `knnDeterministic`
is one synchronous vec0 statement, and the scan runs up to 4 of them. The client bounds what it can:

- **Queued requests expire.** A request queued behind another scan on its lane carries `deadline` (post time +
  budget). The worker answers `expired` without scanning when that deadline has passed (`createSearchHandler`). The
  caller already got `budget`, and nothing is memoized. A lane's first request carries no deadline. A cold worker
  needed ~2.5 s to boot and load sqlite-vec on this machine, and a deadline there dropped the first scan of a slow
  repo every time, so its padding was never memoized (found while measuring this fix).
- **Lane cap.** A lane whose request in hand runs past `DEFAULT_LANE_CAP_MS` (10 s, ~2x the slowest scan measured) is
  retired. It is dropped from the lanes at once, its waiters settle `worker-error` and leave `MAX_PENDING`, the next
  search spawns a fresh worker, and the worker is terminated. Termination takes effect when the statement in hand
  returns, so the rest of the scan and the lane's queue never run.
- **Join, warm lanes** (same row, MCP-ISSUE-136 residual): a repeated query joins the scan in flight instead of
  starting a second one, and every lane is spawned and warmed on first use.
- **Memo copies** (row 1 review). A memo hit returns a fresh copy, and the memo holds a frozen copy. Before this, a
  caller that edited the rows it got changed every later answer.

Measured on a scratch DB (200 000 vectors in one repo partition, 50 in another; dist/ built at this branch's base for
"before", 2 runs each; `measure-knn.mjs`, raw log in the row's evidence). One cold lookup took 1.1-5.0 s. Scenario:
budget 500 ms. A big-repo search times out on lane 1. A second big search takes lane 2, and a small-repo search queues
on lane 1.

| | before | after (cap 10 s) | after (cap 1.5 s) |
|---|---|---|---|
| queued small search after its caller gave up | scanned anyway (590-637 ms) | `expired`, not scanned | settled at the cap |
| both lanes free at | 5 330-5 911 ms | 5 376-6 240 ms (started scans finish, memoized) | 2 038-2 050 ms (2 lanes retired) |
| worker threads exit | when disposed, after their scans | same | 33-591 ms after retire (end of the statement in hand) |

With the 10 s default, a started scan of a few seconds still runs to its end: that is deliberate, because its answer is
memoized for the next identical query. The cap stops a pathological scan. Unit tests: `vectorSearchWorkerClient.test.ts`
(lane cap retires and terminates; the cap bounds one scan, not a lane's queue; expired is not memoized; only a queued
request carries a deadline; memo copies).

- **Workaround used (before the fix):** no `query_graph` on the live server; the question was answered from scratch DBs
  indexed by a private server process.
- **Enhancement proposal:** done (the runner). Follow-up: measure the fixed-shape paths above on wec.be and move any
  that blocks for > 1 s.
