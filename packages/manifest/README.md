# @mcp/manifest

**Tier 5 · Stability: evolving · Depends on: `@mcp/core`**

Workspace tooling data: which MCP servers exist, where their entry points are, and what
environment each one needs. Consumed by `scripts/`; **a server must never import it.**

Promoted from `scripts/lib/manifest.mjs` in migration-plan step S-34.

## The one rule that matters

Adding a server means appending one entry to `src/servers.ts` and adding
`<dir>/skill/SKILL.md`. The installer, doctor, uninstaller, updater, skill renderer, contract
snapshotter and server runner all read from here, so none of them needs editing.

That also means this data is what `~/.claude.json` gets written from. A tidy-up here silently
rewrites working agent configuration on the next install — which is why the S-34 port changed
no value, and why an equivalence check proved it rather than a review claiming it.

## Exports

| Export | Purpose |
|---|---|
| `SERVERS` | Every server, in registration order |
| `getServer(key)` | One server, or `null` |
| `serverKeys()` | Just the keys |
| `evaluateEnv(server, presentKeys)` | "Is this server's environment satisfied?" |
| `WORKSPACE_ROOT` | Absolute path to the workspace root |
| `serverEntryPath(server)` / `serverDirPath(server)` | Absolute paths |
| `ServerDescriptor`, `EnvField`, `ServerBuild`, `EnvEvaluation` | The types |

## Why servers may not import this

Enforced as an error by `guard deps` (`servers/tooling-import`), not left to convention.

A server that imported the manifest would gain its siblings' directories and env contracts —
cross-server coupling laundered through a package, which is precisely what the tier model
exists to prevent. `servers/cross-import` already blocks the direct form. A server needs its
own config and nothing about anyone else's.

The tier matrix cannot express this by itself: it governs imports between *packages*, and a
server is not a row in that matrix. Hence the separate `TOOLING_PACKAGES` list, which covers
`@mcp/cli` for the same reason.

## `evaluateEnv` — the shared predicate

The installer and the doctor must never disagree about whether a configuration is usable, so
there is one implementation. Three rules interact:

- **`required`** — the server cannot start without it.
- **`group`** — "at least one of these". A grouped variable is *never* reported as individually
  missing, even when it also carries `required: true`; otherwise the installer would print a
  contradiction for `CODEBASE_INDEX_ALLOWED_ROOTS`, which is both.
- **`prefix`** — marks a *family*. `PG_ENV_*` is not a real variable name; any set variable
  starting with `PG_ENV_` satisfies it. The trailing underscore is part of the prefix, so
  `PG_ENVIRONMENT` does **not** count — pinned by a test, because trimming the prefix to
  `PG_ENV` is an easy "fix" that would let an unrelated variable pass as a connection source.

## `WORKSPACE_ROOT` is the fragile part

It counts `..` segments from this module, so it depends on where the module sits at runtime.
Three levels is correct for both layouts in use — `dist/` when `scripts/` loads it, `src/` when
the tests do — and it breaks silently if `dist` ever becomes nested or the package moves.

No type check can see that, so the test suite asserts the resolved directory really is the
workspace root by looking for `tsconfig.base.json` and the root `package.json` name.

## Known drift: `tools`

`tools` is a hand-maintained subset for the generated skill, not the server's real `tools/list`.
`codebase-index-local` names 12 of its 43; `postgres-mcp` names 16 of 17. Step **S-36** derives
these from each server's registry and removes the possibility. Until then, treat the list as
documentation, and `contracts/` as the truth.

## Test

```bash
npm test --workspace @mcp/manifest
```

Covers the export surface, the `evaluateEnv` branches, the `WORKSPACE_ROOT` markers, and two
hygiene invariants: no path default may contain a backslash (these strings land in JSON, where
it is an escape character), and no `secret` field may carry a committed default.
