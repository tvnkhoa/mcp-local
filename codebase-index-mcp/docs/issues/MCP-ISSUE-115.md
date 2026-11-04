## MCP-ISSUE-115 — the served HTTP process dropped clients: Node's 5 s keep-alive reset reused sockets, and a crashed server was never respawned

- **Status:** ✅ FIXED 2026-11-04 (row IX-5, branch `wt/http-respawn`). Live effect needs the leader's `--restart`.
- **Scenario:** sessions using the shared codebase-index over HTTP (`scripts/serve-http.mjs`, port 7341) saw
  `ECONNRESET` / "server disconnected" on calls, and `CONNECT_TIMEOUT` at connect (2 Nov ~07:47Z; 4 Nov 02:29Z–02:47Z,
  and 04:4xZ on the leader's session while the served pid stayed listening). No server restart was needed for the
  disconnect: the process was up throughout.

### (1) Keep-alive left at Node's default 5 s — product, fixed

- **Tool/query:** any tool call on a client that reuses a pooled keep-alive socket after an idle gap.
- **Expected vs actual:** the second request on the pooled socket is answered. With the transport's `http.createServer`
  carrying no `keepAliveTimeout` / `headersTimeout` / `requestTimeout` (`packages/sdk/src/httpTransport.ts`), Node closes
  an idle socket after 5 s. A client that reuses it after that window writes into a socket the server has closed and
  gets `read ECONNRESET`.
- **Reproduced (scratch server, port 0, Node 22.18, Windows):** one POST, 6 s idle, a second POST on the same
  `http.Agent({ keepAlive: true })` socket — server at default 5 s: `ECONNRESET`; at 65 s: ok. `fetch` (undici, which
  honours the `Keep-Alive: timeout=5` hint) was ok both ways. **Negative result:** an 8 s synchronous block of the
  server's main thread while the client waited 6 s did *not* reset the socket at either setting — a freeze makes calls
  slow, it does not by itself drop them. The MCP SDK sets `Connection: keep-alive` itself, which suppresses Node's
  `Keep-Alive: timeout=` hint, so a client cannot learn the 5 s window from the response.
- **Fix:** the transport sets the timeouts explicitly: `keepAliveTimeout` 65 s (`DEFAULT_KEEP_ALIVE_TIMEOUT_MS`, option
  `keepAliveTimeoutMs`), `headersTimeout` = keep-alive + 5 s (Node requires it above keep-alive), `requestTimeout` =
  max(60 s, headersTimeout) — the time to *receive* a request, so a long tool call is never cut — and `timeout` 0 (an SSE
  stream may sit quiet).
- **Guarded:** `packages/sdk/src/httpTransport.test.ts` — "MCP-ISSUE-115 a keep-alive socket reused after 6 s idle gets
  no ECONNRESET" (the pooled socket is still open after 6 s and the second request reuses it) and "… the keep-alive
  timeout is explicit and overridable".

### (2) The supervisor exited with its server — product, fixed

- **Expected vs actual:** a served process that dies is back within seconds. `serve()` in `scripts/serve-http.mjs`
  ended the supervisor on the child's `exit` (`process.exit(code ?? 1)`), and the logon task has no restart-on-failure
  by design, so the port stayed dark until the next logon, 08:00 trigger or `--restart`: every client got
  `CONNECT_TIMEOUT`.
- **Fix:** `supervise()` respawns a child that exits without the supervisor having stopped it. Backoff 1 s doubling to
  30 s (`RESPAWN_POLICY`); after 5 restarts inside 10 min it records `gave_up` and exits, so a server that dies on start
  (bad env, port taken) does not spin. Each `started` / `respawn` / `gave_up` is one JSON line — time, pid, exit code or
  signal, reason, next delay; no env, no args — in `<deployRoot>/<key>/restarts.jsonl` (trimmed to its newest 32 KiB
  once past 64 KiB) and a `supervisor_*` line in the server log. `running.json` is rewritten with each new pid.
  `mcp:doctor` gains `[restarts]`: the last five events; warn on a respawn in the last 24 h, fail after a give-up.
  Re-adoption of sessions after a restart (MCP-ISSUE-103) is unchanged — the respawned process reads the same session store.
- **Guarded:** `scripts/serveHttp.test.mjs` — "a server killed under a scratch supervisor is back within 30 s and the
  restart is logged" (a real `serve-http.mjs` on a scratch port and deploy root: kill the served pid, a new pid answers,
  `running.json` and `restarts.jsonl` name it; measured ~5 s); "supervise respawns … and stops at the cap"; "respawn
  backoff doubles, caps, and gives up"; "a child stopped by the supervisor is not respawned"; "the restart log stays
  bounded and doctor reads its tail".

- **Review follow-ups (same day):** (a) `--restart` in a respawn gap found no listener, killed nothing, had `/Run`
  dropped by `IgnoreNew` and took the old supervisor's respawn for the new server — it now kills the supervisor named
  by `running.json`'s new `supervisorPid` (only when that pid is still this server's serve-http) before `/Run`.
  (b) A second supervisor started while one serves exits before writing `running.json` or the restart log (a probe
  bind on the port), instead of five EADDRINUSE respawns that turned `[restarts]` red. (c) A `record` / `onStarted`
  that throws, or a spawn `error`, is reported and never kills the supervisor (which would orphan the child on the
  port). (d) `requestTimeoutMs: 0` disables the request timeout. (e) Exit code 0 is a clean stop — the server exits
  0 only after a signal-driven shutdown (`packages/sdk/src/lifecycle.ts`) — recorded as `stopped`, not respawned.
  Guarded by the `MCP-ISSUE-115 review:` tests in `scripts/serveHttp.test.mjs` and the second-supervisor step of the
  end-to-end respawn test.

### (3) CONNECT_TIMEOUT from a live server — a main-thread block, not this fix (open, IX-1 / IX-2)

- **Observed:** 4 Nov ~11:4x–12:xx local, two sessions (the leader's and another member's) got `CONNECT_TIMEOUT` /
  "server disconnected" while the served pid did not restart.
- **Reproduced (scratch server, port 0):** the server blocks its main thread 12 s; a new client connects during the
  block. The TCP connect completes in 3 ms (the kernel's accept backlog answers for a blocked process), but no HTTP
  response comes until the block ends, so a 10 s client timeout fires — "no response; server alive" — and the next
  request after the block is answered. Scaled from the real pair: a block longer than the MCP client's connect timeout
  (30 s) is a `CONNECT_TIMEOUT` with the process up and listening.
- **Not fixed here:** neither the keep-alive change nor the respawn shortens a block. Removing main-thread blocks (sync
  SQLite busy waits, index runs on the server thread) is IX-1 / IX-2. This row only makes sure the process is back if it
  dies and that an idle socket is not cut under a client.

- **Impact:** every HTTP client of the shared server; a dropped call cost a retry, a dead server cost every session
  its codebase-index until someone restarted it.
- **Workaround used:** none needed beyond `/mcp` reconnect or a `--restart` by the leader.
- **Enhancement proposal:** main-thread freezes (sync SQLite waits, index runs on the main thread) still make calls slow
  and, past 30 s, fail new connects — part (3), owned by IX-1 / IX-2.
