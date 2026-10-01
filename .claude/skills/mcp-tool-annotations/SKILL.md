---
name: mcp-tool-annotations
description: "Choose the readOnly / idempotent / destructive / openWorld annotations for an MCP tool in this workspace (the @mcp/sdk annotations.* presets on defineTool) and check they match what the handler actually does. Use when declaring a new tool, when a tool gains or loses a side effect (writes, mints a token, starts a watcher, calls a remote API), or when reviewing the readOnlyHint/destructiveHint values in a contracts/*.json diff. Not for the broader contract diff (mcp-contract-conformance) or gate design (mcp-security-review)."
---

# MCP Tool Annotations

Clients use these hints to decide what to auto-approve. **A wrong hint is a safety bug, not a
documentation bug** — `readOnly: true` on a write lets a client run it unprompted.

## The fields and presets (`@mcp/sdk`)

| Field | Means |
|---|---|
| `readOnly` | no state change of any kind (working tree, DB, remote, *and* this server's own stores) |
| `idempotent` | two identical calls have the same effect as one |
| `destructive` | may remove or overwrite existing state |
| `openWorld` | talks to a system outside this machine |

| Preset | readOnly | idempotent | destructive | openWorld |
|---|---|---|---|---|
| `annotations.read()` | yes | yes | no | no |
| `annotations.readRemote()` | yes | yes | no | **yes** |
| `annotations.preview()` | yes | yes | no | no |
| `annotations.apply()` | no | no | yes | no |
| `annotations.create()` | no | no | no | **yes** |

Presets are a starting point. Pass an explicit object when none fits — the SDK emits
`readOnlyHint` / `idempotentHint` / `destructiveHint` / `openWorldHint` from it.

## Procedure

1. **List the effects of one call** — rows written, files edited, tokens/previewIds minted, a
   watcher started, a remote API hit, derived state (an index) replaced.
2. **Set each field from that list, not from the nearest preset.** Precedents in this repo:
   - `index_repository` — not readOnly, idempotent, **destructive** (replaces derived graph state only).
   - `watch_repo` — not readOnly, idempotent, not destructive (the hint describes the call, not
     the re-indexes a watcher later triggers).
   - `refactor_replace_preview`, `rename_assist` — readOnly but **not idempotent** (each call mints
     a new previewId + approval token).
   - `refactor_symbol_migration`, `change_value_representation` — **not readOnly, destructive**,
     because the same tool applies when called with `dryRun:false` + token. A dual-mode tool is
     annotated for its worst mode.
   - `execute_routine` (sqlserver) — destructive for **every** routine: the catalog cannot say
     whether a procedure writes.
   - `create_pull_request` — not readOnly, not destructive.
3. **`openWorld` follows where the call goes.** `true` for tools that reach a database or remote API
   (almost every bitbucket/observe/postgres/sqlserver tool); `false` for config-only tools
   (`list_environments`), for tools that only write local files (`migration_add`, `ddl_create`), and
   for every codebase-index tool (local filesystem + local SQLite). Copying a remote server's preset
   into codebase-index gets this field wrong.
4. **Cross-check the description and the guard list** — a tool annotated not-readOnly should name
   its gate (env flag, approval token) in its description.

## Derive the current inventory — don't trust a hand list

```bash
node -e "for (const f of require('fs').readdirSync('contracts').filter(f=>f.endsWith('.json'))) { const c=require('./contracts/'+f); for (const t of (c.tools??c)) { const a=t.annotations??{}; if (a.readOnlyHint!==true) console.log(f, t.name, 'destructive='+a.destructiveHint, 'idempotent='+a.idempotentHint); } }"
```

Then `cd <server> && npm run build && cd .. && npm run contracts:update -- --server <key>` and read
`git diff contracts/` — the hint change must be the only surprise in it.

## Output

Annotation map per changed tool (effects → four values → reason), plus mismatches and fixes.

## Authoritative reference

`docs/servers/tool-development.md` §2 (field meanings, presets, precedent table). Presets:
`packages/sdk/src/defineTool.ts` (`packages/sdk/README.md`). Live values: `contracts/*.json`.
