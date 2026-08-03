# Package Overview

Six packages under `packages/*`. They are the only npm workspace members — the four servers are
deliberately outside it ([ADR 0001](../decisions/0001-workspace-native-deps.md)) and consume these through
`file:` dependencies.

Each package's own `README.md` is the detailed reference. This page is the map: what each one is
for, what it may import, and what it must never know.

```bash
node packages/cli/dist/bin/mcp-platform.js packages   # list packages and their tiers
npm run build:packages                                # tsc -b over all six
npm run test:packages                                 # npm test --workspaces
```

---

## The six

| Tier | Package | Purpose | Depends on | Public surface |
|---|---|---|---|---|
| 0 | [`@mcp/core`](../../packages/core/README.md) | Zero-dependency primitives: `Result`, error taxonomy, env reader, logger, redaction, profiles, limits, paths | *(nothing)* | `.` |
| 1 | [`@mcp/sdk`](../../packages/sdk/README.md) | The tool builder and the MCP runtime. **The only importer of `@modelcontextprotocol/sdk`** | `@mcp/core`, `zod`, protocol SDK | `.` |
| 2 | [`@mcp/shared`](../../packages/shared/README.md) | Capabilities: approval tokens, SQL guardrails, HTTP client, path allowlist | `@mcp/core` | `.`, `./approval`, `./sql`, `./http`, `./fs` |
| 3 | [`@mcp/testing`](../../packages/testing/README.md) | Harness for invoking tools without a server, leak assertions, contract snapshots | `@mcp/core`, `@mcp/sdk` | `.` |
| 4 | [`@mcp/cli`](../../packages/cli/README.md) | The architecture guards and the `mcp-platform` command | `@mcp/core` | `.` |
| 5 | [`@mcp/manifest`](../../packages/manifest/README.md) | Workspace tooling data: which servers exist, their entry points, their env contracts | `@mcp/core` | `.` |

All six are `"private": true` with an `exports` map, so a deep import is unresolvable rather than
merely discouraged.

---

## `@mcp/core` — tier 0

**Zero runtime dependencies, permanently.** Adding one requires an ADR. That is what lets every
other tier depend on it without inheriting a dependency graph.

| Module | Provides |
|---|---|
| `result` | `Result<T,E>`, `ok`, `err`, `isOk`, `isErr`, `mapOk`, `mapErr`, `allOk`, `unwrapOr` |
| `errors` | `PlatformError`, `PolicyViolationError`, `ERROR_CODES`, `toPlatformError`, per-code factories (`validationError`, `notFound`, `policyViolation`, `upstreamError`, …) |
| `redaction` | `maskSecret`, `maskUriCredentials`, `redactValue`, `redactObject`, `createRedactor`, `isSecretKey` |
| `env` | `createEnvReader`, `defaultEnvSource` — **the only permitted `process.env` reader in the platform** |
| `logging` | `createLogger` (stderr only), `createEventLogger`, `createNullLogger`, `parseLogLevel` |
| `profiles` | `ResponseProfile` (`nano \| compact \| standard \| verbose`), `parseResponseProfile`, `shouldPrettyPrint`, `shouldDropNullish` |
| `limits` | `createLimitPolicy`, `resolveBound`, `resolveLimit`, `resolveTimeoutMs` |
| `json` | `isPlainObject`, `normalizePayload`, `stableStringify` |
| `paths` | `toPosixPath`, `isPathWithin`, `normalizePosixPath`, `pathSegments` |

**Invariants.** stderr only — `createLogger` never touches stdout. No import-time side effects —
`defaultEnvSource()` is a function, not a constant. `toPlatformError` puts the original message on
`cause` (logged) and never in `details` (returned).

---

## `@mcp/sdk` — tier 1

The tool builder and the MCP runtime. A protocol-SDK major upgrade is a change to
`src/createServer.ts`, not to every server.

### The builder family

One vocabulary across the three MCP surfaces. Every `create*` builds frozen, protocol-free data and
validates it at construction; every `register*` assembles many of them into the one thing
`createServer` takes, flattening nested groups and **rejecting a duplicate name at assembly** so a
collision fails at start-up rather than shadowing silently at call time.

| Surface | Declare one | Assemble | Served over |
|---|---|---|---|
| Tools | `createTool` (= `defineTool`) | `registerTool` | `tools/list`, `tools/call` |
| Resources | `createResource` | `registerResource` | `resources/list`, `resources/read` |
| Prompts | `createPrompt` | `registerPrompt` | `prompts/list`, `prompts/get` |

`createServer` (= `createMcpServer`) wires them; `runServer` owns the entry point's start-and-exit
tail and is the one reviewed place that calls `process.exit`.

`createTool`/`createServer` are **aliases, not replacements**. All four servers call
`defineTool`/`createMcpServer`; renaming those call sites would be churn with no behavioural gain.

### The rest of the surface

| Module | Provides |
|---|---|
| `schema` | `schema.object/string/integer/enumOf/…` — the hand-written JSON Schema `tools/list` advertises |
| `defineTool` | `defineTool`, `createTool`, `annotations.{read,readRemote,preview,apply,create}` |
| `guards` | `defineGuard`, `featureFlagGuard`, `immutableTargetGuard`, `runGuards` |
| `errorMapper` | `createErrorMapper`, `abortRule`, `stringProperty` — the shared branch order, classes **injected** |
| `responses` | `asText`, `asError`, `asErrorPayload`, `asFatalError`, `serializePayload` |
| `registry` / `dispatch` | `createToolRegistry`, `registerTool`, `dispatchToolCall`, `LegacyBridge` |
| `resources` / `prompts` | `createResource`/`registerResource`, `createPrompt`/`registerPrompt` |
| `lifecycle` / `console` | `createLifecycle`, `assertConfigValid`, `redirectConsoleToStderr` |
| `healthTool` | `createHealthCheckTool` — the identical `health_check` every server exposes |
| `createServer` / `runServer` | the runtime |

### Dispatch pipeline

```
resolve → profile → validate → guards → handle → serialize
```

Nothing throws out of dispatch. A handler exception becomes an `internal_error` whose detail is
logged and never returned.

---

## `@mcp/shared` — tier 2

Capabilities. Each is independent — **no module here imports a sibling** — and each provides
*mechanism* while taking *policy* as a parameter.

| Import | Provides |
|---|---|
| `@mcp/shared/approval` | `createApprovalService`, `issuePreviewToken`, `verifyPreviewToken`, `resolveApprovalSecret`, `generateApprovalSecret` — HMAC-SHA256 issue/verify with TTL and timing-safe compare |
| `@mcp/shared/sql` | `createReadOnlySqlValidator`, `scanSql`, `stripStringsAndComments`, `findForbiddenToken`, `hasMultipleStatements`, `isSelectLike` |
| `@mcp/shared/http` | `createHttpClient`, `computeBackoffMs`, `isRetryableStatus`, `encodePathSegment`, `truncateForLog` |
| `@mcp/shared/fs` | `createPathAllowlist` — root allowlist with traversal defence |

**Mechanism, not policy** is this package's defining rule, and it exists because of a real defect:
the audit found three hand-copied SQL guards whose forbidden-token lists had silently diverged
(Postgres forbade 18 tokens, the OpenObserve copy 13). So `@mcp/shared/sql` ships **no token list** —
the caller supplies one, and the divergence becomes a reviewable data change rather than an invisible
fork ([ADR 0002](../decisions/0002-sql-guardrail-token-lists.md)).

**A capability must never reach the protocol layer.** `@modelcontextprotocol/sdk` and `@mcp/sdk` are
on this package's hard `forbidden` list, not merely absent from `mayImport`. It is what keeps SQL
guardrails and approval tokens testable as plain functions.

**Security notes.** Approval tokens are bound to a subject — a token issued for one preview cannot
apply another. `resolveApprovalSecret(undefined)` generates an ephemeral per-process secret, so
tokens simply do not survive a restart; that is a safe default, not a failure. The HTTP client's
`describe()` reports `authConfigured: true/false` and never a header value.

---

## `@mcp/testing` — tier 3

Nothing in the platform may depend on this outside of its own tests.

The harness routes through the **real** `dispatchToolCall`, so validation, guard evaluation, error
mapping and profile serialization are production code paths — a test that passes here cannot pass
for a reason the server would not reproduce.

```ts
const invocation = await invokeTool<{ things: string[] }>(listThings, { limit: 10 });
const payload = assertToolOk(invocation);
```

| Assertion | Checks |
|---|---|
| `assertToolOk` | succeeded; returns the payload typed |
| `assertToolError(inv, code?)` | failed, optionally with a specific code |
| `assertNoLeak(inv, ...secrets)` | the secret appears in neither the response **nor the captured logs** |
| `assertMinified` | the response is minified (any profile but `verbose`) |
| `assertPosixPaths` | no Windows separators in the response |

Also `createMemoryLogger` (fixed clock, so records are byte-stable) and the contract-snapshot
helpers `snapshotTools` / `diffSnapshots` / `formatDifferences`, sorted by tool name so ordering is
not a diff.

---

## `@mcp/cli` — tier 4

The guards, plus `mcp-platform`. Nothing may import it: it consumes lower tiers and is consumed by
npm scripts and CI only.

```bash
mcp-platform guard [deps|convention|all] [--strict] [--servers a,b]
mcp-platform packages     # packages and their tiers
mcp-platform rules        # the dependency tier matrix
```

`src/guards/rules.ts` holds the tier matrix **as data**, which is what makes adding a package force
an explicit decision. See [Dependency Rules](./dependency-rules.md) and
[Folder Convention](./folder-convention.md) §6 for what each guard enforces.

**The import scanner is regex-based and dependency-free.** A parser would be more precise, but a
guard's job is to make violations visible, and a false positive is a two-second read — whereas a
permanent runtime dependency in the tooling tier is not.

Two of its tests run the guards against this workspace and assert zero errors, so the foundation is
held to its own rules.

---

## `@mcp/manifest` — tier 5

The single source of truth for the workspace's servers. The installer, doctor, uninstaller, updater,
skill renderer, contract snapshotter, server runner and all three generators read from it.

| Export | What |
|---|---|
| `SERVERS`, `getServer(key)`, `serverKeys()` | the four `ServerDescriptor`s |
| `serverDirPath(key)`, `serverEntryPath(key)`, `WORKSPACE_ROOT` | resolved paths |
| `evaluateEnv`, `evaluateEnvValues` | what the installer and doctor report about an environment |
| `TOOL_LISTS`, `TOTAL_TOOL_COUNT` | generated from `contracts/` |

Env contracts live in `src/envSpecs/<server>.ts`, one file per server, so a change to one server's
contract has a diff that says so. **98 fields across four servers** —
`codebase-index` 41 · `postgres-mcp` 23 · `observe-mcp` 23 · `bitbucket-mcp` 11:

```bash
node -e "import('@mcp/manifest').then(m => m.SERVERS.forEach(s => console.log(s.key, s.env.length)))"
```

Two `EnvField` details are load-bearing:

- **`default` pins the value.** `install-mcp` writes any field carrying a `default` (or a `prompt`)
  into `~/.claude.json`. A tuning knob pinned at today's default stops tracking the code's default
  when that changes.
- **`codeDefault` documents without pinning.** It appears in `.env.example` (commented out) and in
  the README table; the installer stays silent. A test asserts no field declares both.

**This data is what `~/.claude.json` gets written from**, so a "tidy-up" here silently rewrites
working agent configuration on the next install.

`WORKSPACE_ROOT` resolves by walking up from its own module until it finds a directory holding
**both** `tsconfig.base.json` and a `package.json`, and throws with an actionable message if it
reaches the filesystem root. It used to count `..` segments, which broke silently if `dist/` ever
nested (backlog B-09).

> `scripts/lib/manifest.mjs` is a re-export shim over this package. It exists to convert
> `ERR_MODULE_NOT_FOUND` into *"run `npm run build:packages`"* — and it cannot be deleted without
> losing that message, because a static import is resolved during **linking**, before any module
> body runs. `scripts/lib/manifestShim.test.mjs` diffs the two export surfaces in both directions.
> See backlog B-10 for the measurement.

---

## Adding a package

1. `packages/<name>/` with `package.json` (`"private": true` + `exports`), `tsconfig.json`,
   `README.md`, `src/index.ts`.
2. A row in `TIER_RULES` (`packages/cli/src/guards/rules.ts`) — mandatory; `tier/unknown-package`
   fails otherwise.
3. A reference in the root `tsconfig.json`.
4. Update the pinned package list in `packages/cli/src/cli.test.ts`.

Three guards caught omissions when `@mcp/manifest` was added, each doing its job: the convention
guard required the README, `tier/unknown-package` required the matrix row, and `cli.test.ts` pins the
list exactly.

---

## Related

- [Dependency Rules](./dependency-rules.md) · [Folder Convention](./folder-convention.md)
- [Tool Development Guide](../servers/tool-development.md) — using `@mcp/sdk` in anger
- The per-package reference is linked from each row of *The six* above
- `docs/archive/migration/foundation-notes.md` — what the foundation contains and why
- `docs/archive/refactor/duplication-extraction-report.md` — the extraction, its measured behaviour deltas,
  and the one cluster deliberately left alone
