# @mcp/cli

**Tier 4 · Stability: evolving · Depends on: `@mcp/core`**

Workspace tooling: the architecture guards and the `mcp-platform` command.
Nothing may import this package — it consumes lower tiers and is consumed by
npm scripts and CI only.

## Commands

```bash
mcp-platform guard [deps|convention|all] [--strict] [--servers a,b]
mcp-platform packages     # list workspace packages and their tiers
mcp-platform rules        # print the dependency tier matrix
```

From the workspace root:

```bash
npm run guard:deps
npm run guard:convention
npm run guard:all
```

## Warn mode

Guards ship reporting-only: findings print, the exit code stays 0 unless a
blocking **error** exists. `--strict` fails on warnings too.

This is deliberate. The guards are introduced *before* the code satisfies them,
so the reported count becomes the number the migration drives to zero. They flip
to blocking in the migration plan's step S-41.

## What `guard deps` enforces

The tier matrix in `src/guards/rules.ts`, as data:

| Rule | Check |
|---|---|
| `tier/violation` | Imports flow to a strictly lower tier only |
| `tier/zero-dependency` | `@mcp/core` acquired a runtime dependency |
| `tier/forbidden-import` | A capability reached the protocol layer |
| `imports/protocol-sdk` | Only `@mcp/sdk` imports `@modelcontextprotocol/sdk` |
| `imports/deep-import` | No `@mcp/x/src/...` past a package entry point |
| `imports/undeclared-dependency` | Every import is declared in `package.json` |
| `env/direct-access` | Only `@mcp/core/env` and a server `config.ts` read `process.env` |
| `servers/cross-import` | No server imports another server (`--servers`) |
| `servers/tooling-import` | No server imports `@mcp/manifest` or `@mcp/cli` |

Adding a package means adding a row to the matrix — which forces an explicit
decision about what it may import, at review time.

## What `guard convention` enforces

Required files (`package.json`, `tsconfig.json`, `README.md`, `src/index.ts`),
the shared script vocabulary (`build`, `typecheck`, `test`), `private: true`,
an `exports` map, file-size caps (soft 400 / hard 600 lines), no default
exports, and no `console.log` — which would corrupt the MCP transport.

Test files are exempt from the **soft** cap: length there tracks case count, not
production complexity. The hard cap still applies.

### Exempting a file from a size cap

A line count is a proxy for complexity, and a proxy sometimes measures the wrong
thing — a pure delegation façade is long without being complex. A file can waive
a size cap by stating why, in a `//` comment or a `*` JSDoc line:

```ts
// @convention-exempt size/hard-cap: <why this file is the exception>
```

The exemption is **reported, not silent**: the finding comes back as `info` with
the reason attached, so `guard convention` output shows what was waived and on
what grounds. `info` never affects the exit code, including under `--strict` —
that is the point of the severity, so an accepted exemption survives S-41.

Three things are deliberately not permitted:

- **Only `size/hard-cap` and `size/soft-cap` are exemptable.** The other rules
  catch defects rather than proxies for them: `logging/console-log` catches a
  write to the MCP transport itself, and no reason makes that acceptable.
  Exempting a non-exemptable rule is an **error**.
- **A pragma with no reason does not apply**, and is reported as an error. An
  unexplained waiver is indistinguishable from an accident.
- **An exemption that suppresses nothing is a warning** (`exemption/stale`), so
  the pragma gets deleted when the file is finally split instead of lingering and
  implying a constraint that no longer binds.

The pattern is anchored to the start of a line, which is what keeps quoted
examples — including the ones in this guard's own hint strings and tests — from
registering as live exemptions. Both did, on the first run.

## Implementation note

The import scanner is regex-based and dependency-free. A parser would be more
precise, but a guard's job is to make violations visible, and a false positive
is a two-second read — whereas a permanent runtime dependency in the tooling
tier is not. The scanner strips comments, skips lines whose code begins with a
quote (string fixtures), and discards specifiers that cannot be module names.

## Test

```bash
npm test --workspace @mcp/cli
```

Two of its tests run the guards against this workspace and assert zero errors —
so the foundation is held to its own rules.
