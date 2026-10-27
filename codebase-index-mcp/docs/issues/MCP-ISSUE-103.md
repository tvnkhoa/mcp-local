## MCP-ISSUE-103 — a server restart dropped every client's HTTP session

- **Status:** ✅ FIXED 2026-10-27 (C3b-1, wec.aria request; plan agreed with wec.aria, owner-approved).
- **Scenario:** the HTTP transport (`packages/sdk/src/httpTransport.ts`) keeps sessions in memory, keyed by a
  random UUID. After a restart (the `scripts/serve-http.mjs` supervisor respawns `dist/index.js --transport
  http`), every `Mcp-Session-Id` was unknown and answered `404 -32001`. Each Claude session needed a manual
  `/mcp`, and its refactor previews became unusable: a preview is owned by the MCP session id that made it
  (`client_session`, `refactorApplyGate.ts`).
- **Fix:**
  - `HttpTransportOptions.sessionStoreFile` (sdk). At initialize the transport records the session id with the
    sha256 of the bearer that opened it, in an SDK-owned JSON file (`httpSessionStore.ts`: write-then-rename,
    mode 0600, entries older than the idle limit dropped).
  - On a session id it does not know, the transport re-adopts it iff the presenting bearer hashes to the
    recorded one (compared in constant time). Otherwise it answers 404 as before. A bearer alone never claims
    an id.
  - The record is dropped on every close except shutdown: client delete, idle, eviction, client exited,
    transport closed.
  - Why an SDK-owned file rather than the server's DB: every server that serves over HTTP gets it, and the
    transport needs no access to a server's storage. codebase-index passes
    `<state dir>/http-sessions.json` (beside the index DB).
  - SDK 1.29.0 has no public resume API. Adoption marks the transport initialized under the old id through its
    private `_webStandardTransport.sessionId` / `._initialized`. A missing field logs
    `http_session_adopt_unsupported` and answers 404.
- **Guarded:**
  - `packages/sdk/src/httpSessionStore.test.ts`: the installed SDK is 1.29.0 and the private fields exist and
    behave (a different SDK fails it); the store survives a new instance and forgets deletes, expired entries
    and an unreadable file.
  - `test:http-transport` (real server restart, same DB and secret):
    - the same client and bearer keep their session id, and a pre-restart preview applies and rolls back;
    - after a restart with a rotated bearer, the old id answers 404, the new session's apply of the old
      session's preview is refused (`PREVIEW_OWNED_BY_ANOTHER_SESSION`), and nothing is written;
    - with re-adoption disabled, the restart section fails on `-32001 Session not found`.
- **Review follow-up:** the age limit ran from `at`, which only initialize set. A session busy for more than the 8 h
  idle limit was therefore not re-adopted after a restart. `at` is now the last activity: initialize, a request
  (refreshed at most every 5 min, so a crash loses at most that much), adoption, and shutdown (`touch`).
  The supervisor now creates the secret file empty, restricts it, and only then writes the secret. An empty file
  left by an interrupted start is regenerated.
  - Guarded: `httpSessionStore.test.ts`. `touch` moves the age limit. A session initialized 9 h ago with a recent
    shutdown is re-adopted by the restarted server (FAILS without the shutdown refresh). `serveHttp.test.mjs`:
    the empty-file case.
- **Limit:** the transport has ONE bearer, shared by every client of the process. "Same bearer" therefore proves
  the caller holds the server's token, not that it is the client that opened the session. That is as strong as
  the bearer check on any request today. Per-client tokens would make it per client. A rotated token revokes
  every recorded session.

