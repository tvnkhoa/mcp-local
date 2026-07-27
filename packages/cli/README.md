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

Adding a package means adding a row to the matrix — which forces an explicit
decision about what it may import, at review time.

## What `guard convention` enforces

Required files (`package.json`, `tsconfig.json`, `README.md`, `src/index.ts`),
the shared script vocabulary (`build`, `typecheck`, `test`), `private: true`,
an `exports` map, file-size caps (soft 400 / hard 600 lines), no default
exports, and no `console.log` — which would corrupt the MCP transport.

Test files are exempt from the **soft** cap: length there tracks case count, not
production complexity. The hard cap still applies.

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
