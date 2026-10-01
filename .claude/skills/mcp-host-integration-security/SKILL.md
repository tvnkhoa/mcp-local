---
name: mcp-host-integration-security
description: "Review how this workspace's MCP servers are wired into a host agent (Claude Code ~/.claude.json, VS Code/Copilot) — where credentials live, which write/exec flags and allowlists are set in the registered env, TLS settings, the installer/doctor/uninstall scripts, and the gitignored rendered skills. Use when changing scripts/install-mcp.mjs, mcp-doctor, uninstall/update, scripts/lib/agents.mjs or skills.mjs, adding an auth/secret/allowlist env var to packages/manifest/src/envSpecs, registering a server for a new environment, or auditing a machine's MCP config. Not for reviewing tool code inside a server (mcp-security-review) or SQL construction or query bounds (db-tool-review)."
---

# MCP Host Integration Security

All five servers are **local stdio processes** launched by the host — no network listener, no HTTP
transport. Four of them make outbound calls (databases, OpenObserve, Bitbucket) with credentials from
their env. The trust boundary is therefore the host config that spawns them and the env it hands over.

## Where things live

| What | Where | Rule |
|---|---|---|
| Secrets and all env values | the host config (`~/.claude.json` for Claude Code), written by `scripts/install-mcp.mjs` | Env-only. Never in a committed file, a `default` in `envSpecs/`, a skill, or a log line |
| Env contract (names, `secret`, `default`, `group`) | `packages/manifest/src/envSpecs/<server>.ts` | `secret: true` keeps a value out of doctor/install output. **No secret gets a `default`** |
| Rendered skills | `~/.claude/skills/<key>/`, `.claude/skills/<key>/` | Gitignored (machine paths). Must never contain a value — keys only |
| Health report | `npm run mcp:doctor` | Reports presence and shape (`kind`) of values, never the value |

Never dump the process environment to "check" a config — test a var by name only.

## Checklist

1. **Least-privilege flags in the registered env.** Every write path is off unless its flag is set:
   `BITBUCKET_WRITE_ENABLED`, `POSTGRES_WRITE_ENABLED`, `POSTGRES_MIGRATION_ENABLED`,
   `POSTGRES_DDL_ENABLED`, `SQLSERVER_EXEC_ENABLED`. A machine config that sets one should have a
   reason; `prod` stays read-only in postgres-mcp regardless.
2. **Scope allowlists set, not wide.** `CODEBASE_INDEX_ALLOWED_ROOTS` (the only required var for
   that server — exact absolute paths), `POSTGRES_ALLOWED_ENVIRONMENTS`,
   `SQLSERVER_ALLOWED_ENVIRONMENTS`, `SQLSERVER_ALLOWED_DATABASES` (also filters three-part names),
   `OBSERVE_ALLOWED_ENVIRONMENTS`. `POSTGRES_APPSETTINGS_ROOTS` reads connection strings from
   `appsettings*.json` — keep it to the repos that need it.
3. **Backend credentials are least-privilege.** SQL Server: a `db_datareader` login is *the*
   read-only control (T-SQL has no read-only transaction). Bitbucket: Bearer
   `BITBUCKET_ACCESS_TOKEN` **or** Basic `BITBUCKET_EMAIL` + `BITBUCKET_API_TOKEN`, with only the
   scopes the tools use (pipelines need `read:pipeline:bitbucket`).
4. **TLS is verified.** `NODE_TLS_REJECT_UNAUTHORIZED=0` disables verification for the *whole
   process*; prefer trusting the CA (`NODE_EXTRA_CA_CERTS` for the RDS bundle, `PGSSLMODE=verify-full`).
5. **Approval secrets.** `POSTGRES_WRITE_APPROVAL_SECRET` / `CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET`
   are auto-generated per process when unset — set them only to keep tokens valid across restarts,
   and then as secrets.
6. **Installer changes.** A new field with `default` or `prompt` is *written* to the host config and
   pins the value; `uninstall` backs the config up first; multi-backend registrations
   (`<key>-<suffix>`) must be found by doctor/update too. No code path prints a `secret` field.
7. **Deprecated names.** postgres-mcp still accepts `CH_*`/`PG_*`/`MCP_DB_*` with a warning; new
   configs and docs use the canonical `POSTGRES_*` (`docs:check` `env-names` enforces docs).

## Verify

```bash
npm run mcp:doctor -- --server <key>      # build/config/env/skill/start — never prints a value
npm run test:scripts                      # installer, env-preserve, skip-skill, agents tests
npm run docs:check
```

Test an installer change against a scratch `HOME` with `--skip-skill`, not your real `~/.claude`.

## Output

Pass/fail, then findings (`high` = secret exposure or a write path opened unintentionally; `medium` =
scope wider than needed; `low` = hygiene) with the mitigation.

## Authoritative reference

`README.md` §"What install writes" and `docs/servers/server-development.md` §6 (install, doctor,
the env-field semantics); `docs/guides/onboarding.md` (multi-environment registration). Per-server
gates: each server's README generated env table. T-SQL deployment control:
`docs/decisions/0004-tsql-guardrail-policy.md` Part 4.
