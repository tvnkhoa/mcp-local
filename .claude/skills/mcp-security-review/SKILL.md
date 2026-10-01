---
name: mcp-security-review
description: "Pre-merge security review of a change to any of this workspace's five MCP servers or shared packages: read-only defaults and env-flag write gates, declared guards, preview/apply/rollback with HMAC approval, prod/allowlist scoping, input validation, secrets and logging, error leakage, and the guard/contract gates that must stay green. Use before merging a server or packages/ diff that adds a tool, touches a gate, a guard, config/env, SQL, file paths, or an upstream client. It is the umbrella review — it hands SQL-construction detail to db-parameterization-audit, bounds to db-query-budgeting, hints to mcp-tool-annotations and host config to mcp-host-integration-security."
---

# MCP Security Review

Baseline policy is already loaded (`.claude/rules/mcp-base.md`, `typescript-mcp.md`,
`db-guardrails.md`, `codebase-index.md`). This is the review procedure for this repo.

## 1. Scope the diff

`git diff --stat main...` and classify each touched file: tool declaration (`src/tools/`), guard /
guardrail (`src/middleware/`), config (`src/config/`), repository/client (`src/repositories/`,
`src/services/`), `packages/*`, manifest/env, installer. Run the sibling skill for each specialist
area the diff touches.

## 2. Checklist

1. **Default-safe.** A new mutating path is off unless its `*_ENABLED` flag is exactly `"true"`/`"1"`
   — existing flags: `BITBUCKET_WRITE_ENABLED`, `POSTGRES_WRITE_ENABLED`,
   `POSTGRES_MIGRATION_ENABLED`, `POSTGRES_DDL_ENABLED`, `SQLSERVER_EXEC_ENABLED`;
   codebase-index's refactor apply needs a preview `approvalToken`. postgres `prod` stays read-only
   whatever the config says; `CODEBASE_INDEX_LLM_ENABLED=true` must still fail start-up.
2. **Gates are declared, not buried.** Each gate is a `guards: [...]` entry
   (`featureFlagGuard`, `immutableTargetGuard`, `defineGuard`) — not an `if` in the handler — so the
   review reads the guard list. Tool stays listed when gated (refuses at call time).
3. **Destructive pattern.** `preview → apply → rollback`; apply verifies an HMAC token bound to the
   previewed plan (`@mcp/shared/approval`), and refuses if the target changed since preview.
   postgres writes need a `WHERE`; the `mcp_ops` schema belongs to the server and nothing may write to it.
4. **Input.** zod `.strict()` before business logic; every bound has a max; file paths go through
   the allowlist (`CODEBASE_INDEX_ALLOWED_ROOTS`, exact `repoPath`); environment/catalog names are
   checked against `*_ALLOWED_*`. SQL → `db-parameterization-audit`.
5. **Secrets.** Only `src/config/` reads `process.env` (`guard:deps` `env/direct-access`). Nothing
   secret in a response, `describeConfig`, `health_check`, a log field, a contract snapshot, or a
   skill. No secret has a `default` in `envSpecs/`.
6. **Errors don't leak.** Driver/HTTP messages that can carry a connection string, token or path do
   not reach the caller (postgres-mcp's custom `fallback`); see `mcp-error-taxonomy`.
7. **Annotations honest** for any new/changed tool — `mcp-tool-annotations`. A wrong
   `readOnlyHint` lets a client auto-approve a write.
8. **No new trust edges.** No server imports another server or `@mcp/manifest`/`@mcp/cli`; only
   `@mcp/sdk` imports `@modelcontextprotocol/sdk`; no LLM client in codebase-index `src/`.
9. **Tests.** Each gate has an accepted and a refused case; leak checks with `@mcp/testing`
   `assertNoLeak`.

## 3. Gates to run (narrow first)

```bash
npm run guard:all                        # deps + convention rules (conventions.md §1–2); needs build:packages
cd <server> && npm run typecheck && npm run test
cd codebase-index-mcp && npm run guard:no-llm-runtime     # if codebase-index changed
npm run contracts:check                  # did the public surface change?
bash scripts/prove-guards.sh             # only if a guard rule itself was edited
```

## Output

Pass/fail summary, then findings `high` (write/exfil path open, secret exposed) / `medium` (gate
not declared, scope too wide, missing refusal test) / `low`, each with `file:line` and the fix.

## Authoritative reference

Enforced rules and what checks them: `docs/reference/conventions.md`. Import and env-access rules:
`docs/reference/dependency-rules.md`. Gates, guards and the destructive pattern:
`docs/servers/tool-development.md` §2–3. Guard proof: `scripts/prove-guards.sh`.
