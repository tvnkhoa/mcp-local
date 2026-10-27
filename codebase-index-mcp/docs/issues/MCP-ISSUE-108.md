## MCP-ISSUE-108 — a new session of the same client lost its pre-restart previews

- **Status:** ✅ FIXED 2026-10-27 (C3b-4, wec.aria live check; conditions agreed with wec.aria).
- **Scenario:** after a served-process restart with no `/mcp`, `search_symbols` worked but
  `refactor_replace_apply` on a preview made before the restart, in the same Claude session, failed
  `PREVIEW_OWNED_BY_ANOTHER_SESSION`. In `.codebase-index-state/http-sessions.json` the preview's session id kept
  its pre-restart `at`, and new ids appeared at the restart: Claude Code does not resend its old `Mcp-Session-Id`
  after the server drops the stream, it silently initializes a new session. MCP-ISSUE-103's re-adoption never
  fires for that client, so ownership keyed by the session id cannot survive a restart.
- **Fix:**
  - The owner of a preview / apply (`client_session`) is now the client *process*:
    `pid:<pid>@<start time>/<bearer sha256 prefix>`. The SDK transport resolves the pid from the loopback socket at
    initialize (and at re-adoption), then the process's start time (`resolveProcessStartTime`: PowerShell ticks on
    win32, `/proc/<pid>/stat` on Linux). netstat and PowerShell run by absolute path under `%SystemRoot%\System32`.
    A reused pid has another start time; another bearer is another owner. Over stdio the owner is the server's
    parent process.
  - Lazy (leader review: the first call of every session waited 2.1–2.5 s, worst case ~25 s): the lookup starts
    at initialize, but `CallContext.resolveClientIdentity()` is awaited only by the tools in `OWNERSHIP_TOOLS`
    (`refactorApplyGate.ts`: rename_assist, the refactor_replace trio, refactor_symbol_migration,
    change_value_representation). Every other call goes ahead without waiting.
  - Fail closed: an unresolvable pid or start time, or a client process that has exited, leaves no identity, and
    the owner is the session id, which a restart does not keep.
  - `refactorApplyGate.ts`: `previewOwnerOf` stamps the identity (else the session id); the check accepts a match on
    either, so a row stamped with a session id before 108 still opens to that session.
- **Guarded:**
  - `packages/sdk/src/httpTransport.test.ts`: a new session from the same pid and start time after a restart has the
    same identity; another pid, a reused pid with another start time and another bearer each differ; an
    unresolvable pid / start time (null or throwing) and an exited client give none; with a 2.5 s start-time stub, a
    call that does not ask for the identity answers in under 1 s (FAILS with the eager await).
  - `refactorApplyGate.test.ts`: identity owner, new session of the same process allowed; peer, reused pid and an
    unresolvable caller refused; session-id rows and unowned rows as before.
  - `test:http-transport` (real restart): a NEW session of the same process applies and rolls back its pre-restart
    preview (FAILS without the fix: `PREVIEW_OWNED_BY_ANOTHER_SESSION`); a peer client in another process is
    refused apply and rollback, before and after the restart; a rotated bearer is refused.
- **Limits:** `claude --resume` or any new Claude process is a new pid and loses its previews (they expire after
  30 min anyway). The pid comes from `netstat`, so only win32 resolves an HTTP client today; elsewhere ownership
  stays per session. The start time is read once per session (one PowerShell spawn, ~0.5 s, in the background).
  Isolation is now per OS process: a host that runs several MCP sessions in one process shares ownership between them.
