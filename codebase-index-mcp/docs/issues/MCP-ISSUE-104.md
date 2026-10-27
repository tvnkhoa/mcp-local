## MCP-ISSUE-104 — an unset approval secret fell back to a constant, so anyone could mint an apply token

- **Status:** ✅ FIXED 2026-10-27 (C3b-2, security; found while planning the restart-session work with wec.aria).
- **Scenario:** `resolveApprovalSecret` (`refactorUtils.ts`) returned the constant `"dev-insecure-secret"` when
  `CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET` was unset and strict approval was off — the default. The HMAC key of
  every `approvalToken` was then public. Anyone could sign a token for any preview and apply it. The env note
  meanwhile claimed the secret was "auto-generated per process".
- **Fix:**
  - There is no fallback. `resolveApprovalSecret` refuses an empty secret (`APPROVAL_SECRET_REQUIRED`) in either mode.
  - Startup always supplies one (`refactorApprovalSecret`, `config/envConfig.ts`).
    - The env value wins.
    - Over HTTP, unset: the server refuses to start, before it opens the DB, naming the variable.
    - Over stdio, unset: a random 32-byte secret for this process. Its previews die with the process anyway.
  - `scripts/serve-http.mjs` passes `CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET` to the child unless the env file
    sets it. On first use `ensureApprovalSecret` creates `~/.claude/mcp/http/codebase-index.approval-secret`
    (`wx`, 64 hex, mode 0600) and reuses it after that.
    - On Windows, `icacls /inheritance:r /grant:r <user>:F` leaves the user as the only ACL entry. A file
      that cannot be restricted is removed and serving refuses.
    - An unusable file (under 32 characters) refuses with a message to delete it.
  - The env spec note says this (generated `.env.example` / README).
- **Guarded:** `test:approval-token`:
  - empty non-strict refused;
  - stdio gets a per-process 64-hex secret, different per process;
  - a token minted with the old constant is refused (`INVALID_APPROVAL_TOKEN`);
  - `refactorApprovalSecret("", "http")` throws, and the env value wins;
  - `dist/index.js --transport http` with no secret exits non-zero naming the variable, and no DB file is created.

  `scripts/serveHttp.test.mjs`: the secret file is created once and reused; one ACL entry, the user's, with no
  inherited entries (or no group/other mode bits off Windows); a short file is refused.
- **Not covered:** an existing env file that sets the secret keeps it, at whatever ACL that file has.

