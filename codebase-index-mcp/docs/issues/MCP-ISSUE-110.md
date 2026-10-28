## MCP-ISSUE-110 — two harnesses failed under machine load: freshness budget did not bound the tree check; HTTP start-up outran the harness; an unresolved client identity is suspected

- **Status:** ✅ FIXED 2026-10-28 for (1) and (2) (row 11). (3) OPEN — not reproduced, fix deferred by the owner.
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

### (3) Pre-restart preview refused to a new session of the same client process — OPEN, not reproduced

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
