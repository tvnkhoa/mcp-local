## MCP-ISSUE-110 — two harnesses failed under machine load: freshness budget did not bound the tree check; HTTP start-up outran the harness; an unresolved client identity is suspected

- **Status:** ✅ FIXED 2026-10-28 for (1) and (2) (row 11). (3) FIXED 2026-11-10 (row 4): a null identity is re-resolved; the 28 Oct run itself was not reproduced.
- **Scenario:** on 28 Oct, three member runs of `run-tests.mjs --changed` on a loaded machine (parallel harnesses from
  several worktrees) failed `test:freshness-worker` and `test:http-transport`; each passed when re-run alone.

### (1) The query budget did not bound the freshness check — product, fixed

- **Tool/query:** any read tool on a repo with a dirty tree (`test:freshness-worker` (a): 300 dirty files, budget 300 ms).
- **Expected vs actual:** the answer comes within the budget (+1 s slack in the harness). Under 6 CPU burners the
  first query took 1,793 / 2,403 / 2,623 ms. Instrumented: the server's own `freshness.elapsedMs` was 712 / 861 ms
  against 300 ms.
- **Cause:** the budget already ran from the query's arrival, but it bounded only the wait for the refresh *run*.
  The check before it — `readTree` (`git status`) and `computeTreeKey` (hash every dirty file) — was awaited in full;
  `waitBudget` then found the budget spent and answered at once, late by the whole check.
- **Fix:** `createFreshnessGate` (`src/middleware/freshness.ts`) runs the check as a per-repo in-flight promise and races
  it against the remaining budget (`waitCheck`). On overrun the answer is `refreshing` ("checking the working tree …
  is still running"); the check carries on, starts the run if one is needed, and a later query joins that run. A caller
  arriving mid-check joins the same check: one `git status` + hash however many callers. A zero budget still waits for
  the check (it bounds only the run wait, as before). A check that throws reaches every waiter; nothing is left unhandled.
- **Guarded:** `freshness.test.ts` — "MCP-ISSUE-110: a tree check that outlives the budget …" (fails without the fix:
  48/49) and "… a zero budget still waits for the tree check …".
- **Limits:** with `checkTtlMs` 0 (the default since B.1), a finished check that found the tree fresh is not reused; the
  next query checks again, and on a machine that slow it may answer `refreshing` again.

### (2) HTTP server start-up outran the harness's 30 s wait — harness, fixed

- **Expected vs actual:** under 6 CPU burners + 8 processes looping PowerShell/git spawns, `test:http-transport` failed
  10/10 with "server did not start listening within 30 s", before reaching any check.
- **Measured:** time to listening 7.5 s idle, 48.7 s under that load, all of it before `server_starting`. A CPU profile of
  start-up: module resolution on disk (`getPackageScopeConfig` 10.6 s, `open` 7.2 s, `readFileUtf8` 2.5 s; 611 modules:
  dist 209, zod 159, ajv 63). Not a worktree/junction effect: the main tree starts as slowly.
- **Fix:** `scripts/test/test-http-transport.mjs` waits `SERVER_START_MS` = 120 s (≈ 2.5× the measured worst case).

### (3) Pre-restart preview refused to a new session of the same client process — FIXED 2026-11-10 (cause confirmed by unit test; the run not reproduced)

- **Signature (28 Oct, member run under load):** the three checks "restart: a new session of the same process applies the
  pre-restart preview" / "that apply wrote the file" / "... and rolls it back" fail with
  `PREVIEW_OWNED_BY_ANOTHER_SESSION`. That is exactly the 27 Oct control run with the owner forced to the session id
  (briefs/2026-10-27-mcp-local-owner-pid-evidence.md): the client identity (MCP-ISSUE-108) resolved `undefined` for the
  pre-restart session or the new one, so the owner fell back to a session id that a restart does not keep.
- **Suspected cause:** `packages/sdk/src/httpTransport.ts` resolves the identity once per session — `netstat -ano`
  (10 s timeout) then PowerShell `StartTime` (15 s timeout) — and a failure (timeout, or the socket row gone by the
  time netstat snapshots) fixes the session at `null` for its life.
- **Not reproduced:** 0/10 under 6 CPU burners, 0/10 under 12; under the spawn load the server did not start in 30 s
  (10/10, see (2)); with the start wait at 180 s, 1 run under the spawn load (380 s) passed, restart included.
  PowerShell `StartTime` measured 1.4–2.1 s under 6 burners, far from 15 s.
- **Proposed (sdk, needs owner — widens the gate):** when a session's identity resolved `null`, re-resolve it on the next
  ownership-tool call from that request's socket instead of keeping `null`; and log `http_identity_unresolved` with the
  failing step, so the next occurrence names its cause.
- **Workaround:** re-run the harness; a client that hits it in use re-creates its preview.
- **Confirmed (2026-11-10, deterministic, no load):** `httpClientIdentity.test.ts` "MCP-ISSUE-110 (3) …" with a pid lookup
  that rejects once (a netstat timeout) or a start time that is null once: the session's identity stayed null on every
  later ownership call, and the lookup ran exactly once per session (3/3 red before the fix). So any one failed step at
  initialize fixes the owner at the session id for the session's life — the 28 Oct signature. Which step failed on
  28 Oct is not recoverable (nothing was logged).
- **Fix (2026-11-10, row 4, `packages/sdk/src/httpTransport.ts` + `httpClientIdentity.ts`, split out first as a pure
  move for the 600-line cap):** each HTTP request is handled inside an `AsyncLocalStorage` holding its socket's client
  port, which the tool calls it starts inherit. `clientIdentity()` (awaited only by `OWNERSHIP_TOOLS`) re-resolves a
  null identity from the port of the ownership call in flight — its own socket, open while it is answered (the session's
  latest request port is only the fallback outside a request). The first re-resolution runs at once, later ones at most
  once per `identityRetryMs` (default 30 s, on the monotonic `performance.now()`) per session; callers that wait while
  one is in flight share it and do not start another; a call that does not ask never triggers one. Every failed step
  logs `http_identity_unresolved` (warn) with `{sessionId, attempt: initialize|adopt|retry,
  step: remote_port|client_pid|start_time, reason}`; the reason is coarse (`timeout`, `exec_failed`, `not_found`,
  `unsupported_platform`, `threw`) — no command line, no token. The netstat resolver rejects with `timeout` (killed at
  its timeout) / `exec_failed` instead of a silent null, and with `unsupported_platform` off win32, which is logged at
  warn once per process and at debug after that. The ownership rule is unchanged.
- **Guarded:** `httpClientIdentity.test.ts` (the 108 identity tests moved there too): re-resolution after a failed pid
  lookup and after a null start time; the throttle (2 lookups in one window, a third after it elapses); five callers
  resuming together plus one arriving mid-retry share one lookup with the window at 0 (red with either sharing branch
  removed: 6 and 3 lookups); the retry looks up the ownership call's own port while a later request on another socket is
  the session's latest (red with the pre-review "latest request" port); netstat's timeout / exec_failed mapping; the
  unsupported platform logged at warn once.
- **Limits:** a client that stays unresolvable keeps the session-id owner, as before (fail closed); a preview made
  while the identity was null stays owned by that session id and does not move to the identity once resolved — the
  check accepts either, so the same session still applies it, but a restart loses it.

**Follow-up (2026-10-28, CI red on a5a3702):** this file broke `test:profile-responses`, not the gate change: it pushed the first
code file out of the harness's 100-file sample. The harness now indexes `src/` whole. Also: `maxFiles` counts docs before the docs filter.
