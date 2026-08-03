# Tool Contract Snapshots

One file per MCP server, holding the exact `tools/list` response that server advertises.

`tools/list` **is** the public API: it is everything a client sees before calling anything. A tool
rename, a dropped field, a changed enum, or a loosened `required` array is a breaking change that
no TypeScript check will catch — the types stay valid while the contract shifts underneath.

These snapshots turn "did I change the API?" from a code-review judgement call into `git diff`.

## Commands

```bash
npm run contracts:check     # verify — non-zero exit on any drift
npm run contracts:update    # regenerate after an intended change, then commit the diff
node scripts/contract-snapshot.mjs --server bitbucket-mcp    # one server
```

`contracts:check` requires every server to be built (`dist/index.js`), because it captures from a
real stdio MCP handshake rather than by reading source.

## What a failure means

```
DRIFT  bitbucket-mcp          8 -> 8 tools
         at: tools.0.description
   committed: "Create a pull request. Disabled unless BITBUCKET_WRITE_ENABLED=true. ..."
     current: "Create a PR. Disabled unless BITBUCKET_WRITE_ENABLED=true. ..."
```

Two possibilities:

- **Unintended** — a refactor changed the contract by accident. Fix the code.
- **Intended** — run `npm run contracts:update` and commit the snapshot diff *alongside* the change,
  so the contract change is visible in review rather than implied.

## How the snapshots stay deterministic

Reproducibility is the whole value; a snapshot that varies per machine is noise.

- **Every env var the manifest declares is overridden.** Required vars and one representative per
  `group` get a fixed placeholder; everything else is *unset* so the server falls back to its own
  defaults. A developer's real credentials can neither leak in nor change the output.
- Optional vars are deliberately unset rather than given a placeholder. A made-up value for
  something like `POSTGRES_ALLOWED_ENVIRONMENTS` is not harmless — it is a filter that matches
  nothing, and the server refuses to start.
- Tools are sorted by name and every object key is sorted, so a diff shows semantic change rather
  than serialization order.
- The server list comes from `@mcp/manifest`, so a new server is picked up automatically.

## Current contracts

| Server | Tools | Advertises annotations |
|---|---|---|
| `codebase-index` | 43 | **yes** — migrated to `@mcp/sdk` (S-31…S-33) |
| `postgres-mcp` | 17 | **yes** — migrated to `@mcp/sdk` (S-25) |
| `observe-mcp` | 8 | **yes** — migrated to `@mcp/sdk` (S-24) |
| `bitbucket-mcp` | 8 | **yes** — migrated to `@mcp/sdk` (S-23) |
| **Total** | **76** | all four |

Servers on `@mcp/sdk` advertise MCP annotation hints (`readOnlyHint` / `idempotentHint` /
`destructiveHint` / `openWorldHint`), which the SDK derives from each tool's declared annotations.
In every migration so far this was an **additive** contract change, reviewed via the snapshot diff: names,
descriptions and input schemas stayed byte-identical.

Clients use these hints to decide what may be auto-approved. Across the workspace the tools marked
**not read-only** are `create_pull_request`, `write_apply`, `write_rollback`, `migration_apply`,
`migration_add`, `index_repository`, `watch_repo`, `refactor_replace_apply` and
`refactor_replace_rollback` — of which all but `create_pull_request`, `migration_add` and
`watch_repo` are also destructive.

Two of those deserve the note, because a reviewer will read them as too strict or too loose:

- `index_repository` is destructive but touches **only derived state** — it replaces the SQLite
  graph and prunes entries for deleted files, and cannot alter a line of the repository it reads.
- The four preview/dry-run refactor tools (`refactor_replace_preview`, `rename_assist`,
  `refactor_symbol_migration`, `change_value_representation`) are read-only yet **not idempotent**:
  they write nothing to the working tree, but each call mints a new previewId and approval token.

No tool in any server is `openWorldHint: true`.

Tool advertisement is **not** env-dependent in any server: write-gated tools such as
`create_pull_request`, `write_preview` and `migration_apply` are always listed, and the gate is
enforced when they are called. That is why one snapshot per server is sufficient — verified by
listing tools with the write flags both off and on.

## Why this exists (migration-plan step S-06)

It is the prerequisite for migrating a server's internals onto `@mcp/sdk` (steps S-23…S-33). Those
migrations rewrite how tools are declared and dispatched, and the only guarantee that matters is
that clients cannot tell. The snapshot is that guarantee.
