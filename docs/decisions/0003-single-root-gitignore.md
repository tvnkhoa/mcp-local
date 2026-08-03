# ADR 0003 — One root `.gitignore`; no per-server copies

**Status** — Accepted
**Step** — S-37 (Phase J)
**Date** — 2026-07-29

## Context

S-37's stated purpose is to "apply the Phase 1 server tree uniformly", noting that "only two
servers have their own `.gitignore` today (`observe-mcp`, `bitbucket-mcp`)" and listing
`codebase-index-mcp/.gitignore` and `postgres-mcp/.gitignore` as new files to add.

That premise no longer holds. The root `.gitignore` has since grown to cover the whole workspace
with `**/`-prefixed patterns, so the two per-server files add nothing. Verified with
`git check-ignore -v`, which reports the rule that actually decides each path:

| Path | Deciding rule |
|---|---|
| `codebase-index-mcp/node_modules/x` | `.gitignore:2` `**/node_modules/` |
| `codebase-index-mcp/dist/index.js` | `.gitignore:5` `**/dist/` |
| `codebase-index-mcp/.env` | `.gitignore:30` `.env` |
| `codebase-index-mcp/.env.local` | `.gitignore:31` `.env.*` |
| `postgres-mcp/foo.tsbuildinfo` | `.gitignore:20` `**/*.tsbuildinfo` |

Every pattern in `observe-mcp/.gitignore` (3 lines) and `bitbucket-mcp/.gitignore` (5 lines) is
already covered by the root file. Only `bitbucket-mcp/.env.example` is decided by its own
`!.env.example` — and the root's `!**/.env.example` would have decided it identically.

The negation was confirmed to work for a **new** server directory, not just the four tracked
files, by creating one and checking that `git add -n` picks up `.env.example` while `.env` stays
ignored. That distinction matters: all four current `.env.example` files are tracked, so an
ignore bug would have been invisible until server #5.

## Decision

**Do not add `.gitignore` to `codebase-index-mcp` or `postgres-mcp`.** The root file is the single
place ignore rules are declared.

The two existing per-server files are left in place. They are redundant but harmless, and deleting
them is churn with no benefit.

## Consequences

- One place to change an ignore rule, so the rules cannot disagree between servers.
- A server directory copied out of the workspace on its own would lose its ignores. Accepted: no
  workflow does that, and `S-42` (the `servers/` move) was already skipped by decision, so
  directories are not being treated as independently relocatable.
- The scaffold generator (S-38) does **not** emit a `.gitignore`, for the same reason.

## Alternative rejected

Adding both files for symmetry. It would mean four copies of the same rules with nothing checking
they agree — the exact duplication S-35 and S-36 had just finished removing from the env and tool
contracts. Symmetry between directories is cosmetic; a single source of truth is not.
