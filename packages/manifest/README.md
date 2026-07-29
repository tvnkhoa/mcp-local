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
| `TOOL_LISTS`, `TOTAL_TOOL_COUNT` | generated tool names per server (76 total) |
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
- **`prefix`** — marks a *family*. `POSTGRES_ENV_*` is not a real variable name; any set variable
  starting with `POSTGRES_ENV_` satisfies it. The trailing underscore is part of the prefix, so
  `POSTGRES_ENVIRONMENT` does **not** count — pinned by a test, because trimming the prefix to
  `POSTGRES_ENV` is an easy "fix" that would let an unrelated variable pass as a connection source.
- **`deprecatedAliases`** — former names still honoured at runtime (S-43). Satisfies the field for
  `evaluateEnv`, so an install carrying only pre-rename names is reported as configured rather than
  as missing a connection source. For a family the alias is the old *prefix* (`PG_ENV_`).

## `WORKSPACE_ROOT` is the fragile part

It counts `..` segments from this module, so it depends on where the module sits at runtime.
Three levels is correct for both layouts in use — `dist/` when `scripts/` loads it, `src/` when
the tests do — and it breaks silently if `dist` ever becomes nested or the package moves.

No type check can see that, so the test suite asserts the resolved directory really is the
workspace root by looking for `tsconfig.base.json` and the root `package.json` name.

## What is generated from this package

Three artifacts are rendered from the manifest, so each fact is declared once (S-35, S-36):

| Artifact | Written by | Source |
|---|---|---|
| `<server>/.env.example` | `generate:env` | the `env` arrays |
| `<server>/README.md` blocks | `generate:docs` | `env` + `tools`, spliced between `<!-- BEGIN/END GENERATED -->` markers |
| `<server>/skill/SKILL.md` → `~/.claude/skills/` | the installer | `{{ENV_TABLE}}` / `{{TOOL_LIST}}` placeholders |

`npm run generate:all` writes all of them; `npm run generate:check` fails on drift and runs inside
`verify:all`. `mcp:doctor` reports a stale file per server as a warning.

`tools` itself is **generated** into `src/generated/toolLists.ts` by `generate:tools`, from the
committed `contracts/` snapshots. It used to be hand-maintained and had drifted to 12 of
`codebase-index`'s 43 tools — so the installed skill advertised under a third of the server,
and nothing noticed. The manifest's tests now assert the lists against `contracts/` directly.

## `default` vs `codeDefault`

The distinction matters, because `install-mcp` writes any field with a `default` (or a `prompt`)
into `~/.claude.json` — which **pins** it.

- **`default`** — the installer should write this. Use for things a user must actually configure.
- **`codeDefault`** — documentation only, never written anywhere. What the server falls back to
  when the var is unset.

S-35 added 48 vars the code reads and the manifest had never declared. Almost all are tuning
knobs, so they carry `codeDefault`: they show up in `.env.example` **commented out** and in the
README table marked *(code)*, and the installer stays silent about them. Pinning 48 knobs at
today's values in every user's config would have been the wrong outcome, and is why the two
fields are separate rather than one `default` doing double duty.

## Test

```bash
npm test --workspace @mcp/manifest
```

Covers the export surface, the `evaluateEnv` branches, the `WORKSPACE_ROOT` markers, the tool
lists against `contracts/`, and the env hygiene invariants: no path default may contain a
backslash (these strings land in JSON, where it is an escape character), no `secret` field may
carry a committed default, no field may declare both `default` and `codeDefault`, and every field
must name a `section`.
