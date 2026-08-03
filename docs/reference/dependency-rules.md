# Dependency Rules

Ten rules. Nine of them are checked by `npm run guard:deps`; the tenth is checked by a per-server
script. None of them is a preference.

Source of truth for the data behind them: **`packages/cli/src/guards/rules.ts`**. The prose here
describes that file; if the two disagree, the file is right and this page is a bug.

```bash
npm run guard:deps                       # the check
node packages/cli/dist/bin/mcp-platform.js rules    # print the tier matrix
```

---

## 1. The tier matrix

Imports flow **downward only** — never sideways, never up.

| Tier | Package | May import (internal) | May import (external) |
|---|---|---|---|
| 0 | `@mcp/core` | *(nothing)* | **none** — Node builtins and type-only imports only |
| 1 | `@mcp/sdk` | `@mcp/core` | `@modelcontextprotocol/sdk`, `zod` |
| 2 | `@mcp/shared` | `@mcp/core` | **none** · forbidden: `@modelcontextprotocol/sdk`, `@mcp/sdk` |
| 3 | `@mcp/testing` | `@mcp/core`, `@mcp/sdk` | `zod` |
| 4 | `@mcp/cli` | `@mcp/core` | **none** |
| 5 | `@mcp/manifest` | `@mcp/core` | **none** |

Tier 5 is above tier 1 and 2 numerically, which looks odd until you read it as *"nothing in the
platform may reach it"*. `@mcp/manifest` is workspace tooling data — which servers exist, where
their entry points are, what env each needs — not a runtime capability. It sits at the top so it
can use `@mcp/core`'s path helpers while remaining unreachable from everything below.

A package with **no row** in this matrix fails `tier/unknown-package`. That is the point: adding a
package forces an explicit decision about what it may import, at review time, rather than
discovering the answer later from an import that already shipped.

---

## 2. The ten rules

| # | Rule | Guard finding | Why |
|---|---|---|---|
| 1 | Imports flow to a strictly lower tier | `tier/violation` | A cycle between platform packages is unfixable without a rewrite |
| 2 | `@mcp/core` has **zero** runtime dependencies | `tier/zero-dependency` | Every tier depends on it; a dependency here is inherited by all of them. Adding one requires an ADR |
| 3 | `@mcp/sdk` is the **only** importer of `@modelcontextprotocol/sdk` — **`packages/*` only**, see below | `imports/protocol-sdk` | Keeps a protocol-SDK major upgrade inside `packages/sdk`. Not enforced in servers, where 41 imports remain |
| 4 | `@mcp/shared` may not import `@mcp/sdk` or the protocol SDK | `tier/forbidden-import` | A capability must never reach the wire format. Declared as a hard `forbidden` list, not merely omitted from `mayImport` |
| 5 | No server imports another server | `servers/cross-import` | A shared need is promoted into `packages/`, where a guard governs it |
| 5b | No server imports `@mcp/manifest` or `@mcp/cli` | `servers/tooling-import` | A server should know its own config and nothing about its siblings' directories or env contracts |
| 6 | No deep imports past a package entry point — **`packages/*` only** | `imports/deep-import` | The `exports` map makes these unresolvable rather than merely discouraged. If a symbol is missing, re-export it from `src/index.ts` |
| 7 | Every import is declared in the importing `package.json` | `imports/undeclared-dependency` | Otherwise it resolves only by hoisting accident |
| 8 | `process.env` is read in one place per unit | `env/direct-access` | See §3 |
| 9 | Servers are **not** npm workspace members | *(structural, not a guard)* | ADR 0001 — hoisting relocates `better-sqlite3`'s native binary, and a hoisted duplicate makes `instanceof` fail across the boundary |
| 10 | No runtime LLM invocation in `codebase-index-mcp` | `npm run guard:no-llm-runtime` | A hard product constraint. `CODEBASE_INDEX_LLM_ENABLED=true` fails startup by design |

### Which of these the guard actually applies to a server

`dependencyGuard` runs **two** loops, and they do not check the same things. The package loop walks
`packages/*` and applies rules 1–4, 6 and 7. The server loop
(`packages/cli/src/guards/dependencyGuard.ts`, the `options.serverDirs` block) applies exactly
three: `env/direct-access`, `servers/cross-import`, `servers/tooling-import`.

| | `packages/*` | a server's `src/` |
|---|---|---|
| 1 tier flow · 2 zero-dependency · 4 forbidden import | ✅ | — *(no tier row exists for a server)* |
| 3 protocol SDK has one importer | ✅ | **—** |
| 6 no deep imports · 7 imports declared | ✅ | **—** |
| 5 · 5b no cross-server / tooling import | n/a | ✅ |
| 8 `process.env` in one place | ✅ | ✅ |

Rules 5 and 5b need the guard to be told where the servers are, which the root script does:

```jsonc
"guard:deps": "… guard deps --servers codebase-index-mcp,postgres-mcp,observe-mcp,bitbucket-mcp"
```

**Rule 3 is therefore a package-level rule, not a workspace-level one**, and its stated payoff —
"a protocol-SDK major upgrade is a change to `packages/sdk/src/createServer.ts`, not to every
server" — does not hold as written today. Server `src/` currently holds **41** imports of
`@modelcontextprotocol/sdk` (26 `import type`, 15 value). The value imports are `McpError` and
`ErrorCode`; three servers confine theirs to a single `middleware/errors.ts`, which is deliberate —
`createErrorMapper` takes its error classes as parameters precisely because `instanceof` cannot
cross the boundary (§4), so *something* local has to import the class. `codebase-index-mcp` is the
outlier at 12 files.

Rule 6 is likewise packages-only, and could not be applied to servers unchanged:
`@modelcontextprotocol/sdk/types.js` is itself a deep import.

Re-derive both numbers with:

```bash
grep -rn 'from "@modelcontextprotocol/sdk' */src --include="*.ts" | grep -v '\.test\.ts' | wc -l
```

---

## 3. Who may read `process.env`

Exactly two kinds of file, matched as a path suffix in `ENV_ACCESS_ALLOWLIST`:

```
packages/core/src/env.ts        the platform's one reader
/src/config/index.ts            each server's config module
/src/config/environments.ts     postgres-mcp — resolves several environments
/src/config/envConfig.ts        codebase-index-mcp — env parsing
/src/config/performanceConfig.ts   codebase-index-mcp — the profile derived from it
```

(`packages/cli/src/guards/{dependencyGuard,rules}.ts` are also listed: the guard has to name the
pattern it searches for.)

Everything else receives a typed config object, loaded once at startup and passed down.

**Test files are exempt.** A test that pins behaviour *across* env values has to set them, and
routing that through the config module would defeat the isolation the test exists for. `isTestFile`
matches `*.test.ts` and anything under a `scripts/test/` directory.

**Spreading the environment into a child process is inheritance, not configuration.**
`postgres-mcp/src/services/migration/efRunner.ts` does `{ ...process.env, CH_DB_CONNECTION: … }` so
`dotnet ef` inherits `PATH` and `DOTNET_ROOT`. The guard's pattern is narrowed to `process.env.X` /
`process.env["X"]` so it does not report that.

A determined author can still evade the guard by aliasing. It is a tripwire for drift, not a
sandbox.

---

## 4. The consequences you will actually hit

**Build order.** Servers consume `packages/*/dist` through `file:` dependencies, and `dist/` is
gitignored. A fresh clone must run `npm run build:packages` before any server builds. `npm run setup`
and `npm run mcp:install` do it for you; the other entry points do not.

**`instanceof` does not cross the boundary.** Each server owns its own copy of `zod` and
`@modelcontextprotocol/sdk` (rule 9's accepted cost, ADR 0001). A `ZodError` thrown inside
`observe-mcp` is **not** an instance of the `ZodError` class a shared package imported. This is why
`createErrorMapper` takes its error classes as *parameters*:

```ts
export const mapError = createErrorMapper({
  validation: { type: z.ZodError, message: "Invalid arguments.", rootLabel: "(root)" },
  coded: [PolicyViolationError, BitbucketHttpError],
  mcpError: McpError,
  rules: [abortRule("Request to Bitbucket timed out.")]
});
```

Duck-typing on `.name` was the escape hatch ADR 0001 originally suggested; injection is strictly
safer, and `errorMapper.test.ts` pins a same-named, same-shaped `RivalZodError` reaching
`internal_error` to prove it.

**A duplicated table sometimes has to stay.** `postgres-mcp`'s deprecated-alias table exists twice —
once in `packages/manifest` (to generate `.env.example`, the README table and installer prompts) and
once in `postgres-mcp/src/config/aliases.ts` (needed at runtime) — precisely *because* rule 5b
forbids the server from importing the manifest. `scripts/lib/envAliases.test.mjs` diffs the copies.

---

## 5. Adding a package

1. Create `packages/<name>/` with `package.json` (`"private": true`, an `exports` map),
   `tsconfig.json`, `README.md`, `src/index.ts`.
2. Add a row to `TIER_RULES` in `packages/cli/src/guards/rules.ts`. Without it,
   `tier/unknown-package` fails the build.
3. Add it to the root `tsconfig.json` project references.
4. `packages/cli/src/cli.test.ts` pins the package list exactly — update it.

Three deliberate edits in three places, rather than one accidental one. See
[Package Overview](./packages.md) for what each existing package is for.

---

## 6. Proof that these guards guard

Each rule above was given a deliberate violation, confirmed to reject it, and reverted. The full
table — dependency rules and convention rules together — is in
[`conventions.md`](conventions.md) §8, and re-runnable via `scripts/prove-guards.sh`.

---

## 7. Import cycles — currently zero, and not yet gated

```
codebase-index-mcp 0 · postgres-mcp 0 · observe-mcp 0 · bitbucket-mcp 0
core 0 · sdk 0 · shared 0 · testing 0 · cli 0 · manifest 0
```

Rule 1 makes a cycle *between packages* impossible, but nothing stops one *inside* a unit, and
`guard:deps` does not look for it. The 2026-08-03 review found three in `codebase-index-mcp`, all
fixed in that pass:

| Cycle | Cause | Fix |
|---|---|---|
| `config/envConfig` ↔ `config/performanceConfig` | `performanceConfig` needs the env primitives; `envConfig` needed one pure profile parser back | Moved `parsePerformanceProfileEnv` down into `envConfig` |
| `services/graph/edgeResolverShared` ↔ `edgeResolverImports` | **an unused import** — the symbol survived only in a comment | Deleted the import |
| `services/impact/impactShared` ↔ `impactSurface` | same — unused import, symbol referenced only in a doc comment | Deleted the import |

Two of the three cost nothing to fix because nothing was using the edge. That is the argument for
checking: a cycle that exists only because an import outlived its call site is invisible to review
and free to remove, but it constrains module initialisation order for as long as it is there.

**Count only value imports.** `import type` is erased by `tsc`, so a path through one is not a cycle
in the emitted JavaScript. A detector that ignores this over-reports badly — on this repo it turned
3 real cycles into 8. `detect_circular_dependencies` does not currently make the distinction either,
so treat its output as a candidate list.

---

## Related

- [Package Overview](./packages.md) — what each package is for
- [Folder Convention](./folder-convention.md) — the structural rules `guard convention` enforces
- [Conventions](./conventions.md) — every rule, sorted by what enforces it
- [ADR 0001](../decisions/0001-workspace-native-deps.md) — why servers stay outside the workspace
- `docs/architecture/target-architecture.md` §2–3 — the design reasoning
