# Standard Structure Refactor — Compatibility Report

**Scope** — all four servers: `codebase-index-mcp`, `postgres-mcp`, `observe-mcp`, `bitbucket-mcp`
**Change class** — file moves and import rewrites. No behaviour change, no API change.

---

## 1. The target, and the rule that fills it

```
<server>/src/
  tools/          MCP tool definitions (name, description, JSON Schema) + the handlers that implement them
  resources/      MCP resource providers — resources/list + resources/read
  prompts/        MCP prompt definitions
  middleware/     Cross-cutting call-pipeline concerns: guardrails, response serialization, error mapping
  services/       Domain logic
  repositories/   Data access and persistence
  config/         Configuration loading
  types/          Shared type and schema declarations
  index.ts        Entry point
```

A folder exists **only where the server has that concern**. This is not a shortcut — it is
target-architecture rule S2, which the refactor updated rather than replaced: *concerns that exist
are at the conventional path; concerns that do not exist are absent.* An empty `prompts/` in a
server that declares no prompts asserts a capability that is not there, and four identical empty
directories would teach a reader nothing about which server does what. §4 lists every N/A slot.

The layer rule above is what decides placement, and it is worth stating the two calls that were not
obvious:

- **Handlers are `tools/`, not `services/`.** A `*Handler.ts` file exists to answer one named tool
  call. It sits under `tools/handlers/`, beside the declaration whose contract it satisfies. What
  the handler *calls into* — the indexer, the extractor, the EF migration runner — is `services/`.
- **`middleware/` is the call pipeline, not a web-framework analogue.** Guardrails, response
  serialization and error mapping are the three things every call passes through regardless of
  which tool it is. They were previously split across `guardrails/`, `response/` and a root-level
  `errors.ts` / `errorHandler.ts`; they are now one slot.

---

## 2. Per-server map

### bitbucket-mcp — 6 files moved

| Before | After |
|---|---|
| `tools.ts` | `tools/index.ts` |
| `tools.test.ts` | `tools/tools.test.ts` |
| `bitbucketClient.ts` | `services/bitbucketClient.ts` |
| `errors.ts` | `middleware/errors.ts` |
| `response/responseFormatter.ts` | `middleware/responseFormatter.ts` |
| `response/responseFormatter.test.ts` | `middleware/responseFormatter.test.ts` |

Unchanged: `config/index.ts`, `index.ts`.

### observe-mcp — 12 files moved

| Before | After |
|---|---|
| `tools.ts` | `tools/index.ts` |
| `tools.test.ts` | `tools/tools.test.ts` |
| `observeClient.ts` | `services/observeClient.ts` |
| `queryBuilder.ts` (+ test) | `services/queryBuilder.ts` (+ test) |
| `logParser.ts` (+ test) | `services/logParser.ts` (+ test) |
| `errors.ts` | `middleware/errors.ts` |
| `guardrails/sqlGuardrails.ts` (+ test) | `middleware/sqlGuardrails.ts` (+ test) |
| `response/responseFormatter.ts` (+ test) | `middleware/responseFormatter.ts` (+ test) |

Unchanged: `config/index.ts`, `index.ts`.

### postgres-mcp — 17 files moved, 1 provider extracted

| Before | After |
|---|---|
| `write/writeHandlers.ts` | `tools/handlers/writeHandlers.ts` |
| `migration/migrationHandlers.ts` | `tools/handlers/migrationHandlers.ts` |
| `write/{approval,auditLog,previewStore}.ts` (+ test) | `services/write/…` |
| `migration/{efRunner,schemaSnapshot}.ts` | `services/migration/…` |
| `db/{connectionManager,introspection}.ts` | `repositories/…` |
| `errors.ts` | `middleware/errors.ts` |
| `guardrails/{ident,sqlGuardrails,writeGuardrails}.ts` (+ test) | `middleware/…` |
| `response/responseFormatter.ts` (+ test) | `middleware/responseFormatter.ts` (+ test) |
| `buildSchemaResources` — a function inside `tools/index.ts` | `resources/schemaResources.ts` |

Unchanged: `config/*`, `tools/{common,index,migrationTools,readTools,writeTools}.ts`, `index.ts`.

The last row is the one edit that is not a pure move. `buildSchemaResources` is the
`schema://<env>` resource provider and had been living in the tool table. Its body was transplanted
byte-for-byte into `resources/schemaResources.ts` — same URI regex, same descriptors, same
`undefined`-on-no-match contract that `@mcp/sdk` turns into the protocol's invalid-params rejection.
`tools/index.ts` lost the function and two now-unused imports; nothing else changed.

### codebase-index-mcp — 118 files moved, 1 file split

| Before | After | Files |
|---|---|---|
| `handlers/*Handler.ts`, `refactor*Handlers.ts`, `refactorApplyGate.ts`, `handlerContext.ts` | `tools/handlers/` | 15 |
| `handlers/resourceHandler.ts` | `resources/resourceHandler.ts` | 1 |
| `store/*` | `repositories/` | 11 |
| `guardrails/*`, `response/*`, `errorHandler.ts` | `middleware/` | 5 |
| `types.ts`, `vendor.d.ts`, `schemas/*` | `types/index.ts`, `types/vendor.d.ts`, `types/schemas/*` | 9 |
| `analysis/ extractors/ graph/ impact/ indexing/ refactor/ search/ watch/`, `gitHelpers.ts` | `services/<same>/` | 77 |

Final shape — `services/` keeps every sub-domain name it had:

```
src/  index.ts  server.ts
      tools/ 23   services/ 77   repositories/ 11   types/ 9
      middleware/ 5   config/ 3   resources/ 2

      services/  extractors/ 21   analysis/ 14   indexing/ 10
                 graph/ 8   impact/ 7   refactor/ 7   search/ 7   watch/ 2
```

**The split.** `serverUtils.ts` held two functions with nothing in common but being needed at
start-up: `resolveServerVersion` (configuration resolution) and `parseRepoResourceUri` (resource
routing). It had exactly two importers, one per function, so the boundary was already there. It
became `config/serverVersion.ts` and `resources/repoResourceUri.ts`, function bodies unchanged. The
private `clamp` helper stayed private to the resource half rather than being merged with the
similarly-named export in `middleware/indexGuardrails.ts` — merging them would have been a
behaviour change dressed up as tidying.

---

## 3. Deviations from the target

**`codebase-index-mcp/src/server.ts` stays at the root, beside `index.ts`.** It is the second half
of the entry point: `index.ts` owns env parsing and construction, `server.ts` owns protocol wiring
(`formatError`, `renderResult`, `wrapCall`, the resource provider registration). The two are one
composition root split across two files because a combined file would breach the 600-line hard cap.
Filing `server.ts` under `middleware/` would put a `createMcpServer` call — the thing that *builds*
the pipeline — inside the pipeline's own folder. The other three servers have no equivalent file;
they construct the server inline in `index.ts`, which is what rule S1 describes.

---

## 4. Slots that are N/A, and why

| | `tools/` | `resources/` | `prompts/` | `middleware/` | `services/` | `repositories/` | `config/` | `types/` |
|---|---|---|---|---|---|---|---|---|
| codebase-index-mcp | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ |
| postgres-mcp | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | — |
| observe-mcp | ✅ | — | — | ✅ | ✅ | — | ✅ | — |
| bitbucket-mcp | ✅ | — | — | ✅ | ✅ | — | ✅ | — |

- **`prompts/` — absent everywhere.** No server declares an MCP prompt. `@mcp/sdk`'s
  `createMcpServer` has no `prompts` option, so this is not a gap in the servers but a capability
  the platform has never needed.
- **`resources/` — absent in observe-mcp and bitbucket-mcp.** Neither advertises the `resources`
  capability. The SDK derives that capability from whether a provider is supplied, so an empty
  folder here would be actively misleading.
- **`repositories/` — absent in observe-mcp and bitbucket-mcp.** Both are stateless HTTP clients
  against a remote API. Their `services/{observeClient,bitbucketClient}.ts` are the whole data
  path; there is no local store to separate.
- **`types/` — present only in codebase-index-mcp.** It is the only server with type and schema
  declarations that are already separate modules (9 files). In the other three, types are declared
  beside the single function or client that uses them. Hoisting them into a `types/` folder would
  have meant editing file bodies to serve the folder chart — the opposite of a no-behaviour-change
  refactor, and it would separate every payload shape from the client that parses it.

---

## 5. Compatibility

### What is guaranteed unchanged

**The MCP wire contract.** `contracts/` holds a golden `tools/list` snapshot per server;
`contracts:check` boots all four over a real stdio handshake and diffs against it. All four are
byte-identical: 43 + 17 + 8 + 8 = **76 tools**, same names, same descriptions, same JSON Schemas,
same order. Resource URIs (`repo://…`, `schema://…`) and the per-server error envelopes are
unchanged, and are covered by the call-level tests rather than the snapshot.

**Every server's entry point.** `src/index.ts` → `dist/index.js` for all four. `~/.claude.json`
records that path, so no re-registration is needed and no running agent session breaks.
`resolveServerVersion` resolves `package.json` relative to `dist/`, which did not move.

**Runtime path resolution.** Two places compute paths at runtime rather than through the module
graph, and both were checked rather than assumed:
- `extractionWorkerPool.ts` spawns its worker via `new URL("./extractionWorker.js", import.meta.url)`.
  Pool and worker moved together into `services/extractors/`, so the same-directory relative path
  still resolves. The import rewriter deliberately does not touch non-specifier string literals,
  which is what would have corrupted this.
- `graphStore.ts` loads `sqlite-vec` through `createRequire(import.meta.url)`. Node resolution walks
  up to the package root either way; `store/` → `repositories/` keeps the same depth.

**Public package surface.** Servers are `"private": true` applications with no `exports` map and no
consumers. Their internal module paths were never an API. The `packages/*` tier — which *does* have
an `exports` map and is the platform's actual public surface — was not touched.

### What did change, and who had to be told

Internal relative imports: **304 specifiers across 114 files**, all rewritten mechanically and
verified by the compiler. Beyond `src/`, three categories needed updating by hand:

1. **Integration harnesses import compiled modules by path.** `codebase-index-mcp/scripts/test/*.mjs`
   do `import { GraphStore } from "../../dist/store/graphStore.js"`. `tsc` cannot see these, so they
   fail at `ERR_MODULE_NOT_FOUND` rather than at build time — 20 of 34 harnesses broke on the first
   run and were caught only because the suite was run. Nine `dist/` prefixes retargeted.

   **Nine harnesses in that directory are wired to no npm script** (`test-extractor.mjs`,
   `test-index-debug.mjs`, `test-markdown-extraction.mjs`, `test-new-tools.mjs`,
   `test-orphan-edges.mjs`, `test-property-edges.mjs`, `test-property-edges-real.mjs`,
   `test-route-map-roundtrip.mjs`, `test-csharp-parser.mjs`). `run-tests.mjs` discovers suites from
   `package.json`, so these never run. They received the same mechanical `dist/` retarget as the
   rest and are therefore no *more* broken than before — but that is an argument from the rewrite
   rule, not from a green run. They were already unverified before this change; nothing here fixed
   or worsened that.
2. **Two scripts pin source paths as fixtures.** `benchmark-plan-mode.mjs` measures a fixed file
   (`BENCH_CONTEXT_FILE`, now `src/repositories/graphStore.ts`) and `smoke-test.mjs` probes
   `filePathPrefix` OR-semantics against two real subtrees (now `src/repositories/`, `src/tools/`).
   The benchmark's `existsSync` guard — added after S-41 broke exactly this way — did its job and
   failed loudly instead of silently measuring an empty payload.
3. **Docs describing current state.** `CLAUDE.md` (root and codebase-index), `target-architecture.md`
   §1 and §S2, `conventions.md`, `adr/0002`, `backlog.md`, `EXAMPLES.md`, and the
   `templates/server/` scaffold, which now emits the standard structure so server #5 is born
   conformant.

**Historical records were deliberately left alone**: `CHANGELOG.md`, `docs/archive/migration/*`, and the two
issue registries. An entry reading *"fixed 2026-07-30 (`src/store/vectorStore.ts`)"* was accurate at
the commit it describes. Rewriting it would make the record claim something that never happened.

### Evidence

| Check | Result |
|---|---|
| `contracts:check` — real stdio handshake, all four servers | 4 contracts verified, 76 tools, no diff |
| `generate:check` — tool lists, `.env.example`, README blocks | up to date, no drift |
| `guard:all` — dependency tiers + convention rules | 0 errors, 20 warnings, 1 accepted exemption, across 496 files |
| `guard:no-llm-runtime` (codebase-index) | passed |
| bitbucket-mcp `build` / `typecheck` / `test` | 25/25 |
| observe-mcp `build` / `typecheck` / `test` | 56/56 |
| postgres-mcp `build` / `typecheck` / `test` | 64/64 |
| codebase-index-mcp `test:unit` | 39/39 |
| codebase-index-mcp full suite (unit + 26 integration harnesses) | 34/34 |
| `verify:all` (the CI gate) | passed |

Every server was rebuilt from a deleted `dist/` before its suite ran. `tsc` does not prune, so a
stale module at an old path will still load and can hide a broken import — the one failure mode this
refactor was most exposed to.

The 20 guard warnings are the pre-existing file-size warnings, unchanged in substance: every one is
a file this refactor moved without editing, now reported at its new path. No new warning was
introduced — the three files created here (`resources/schemaResources.ts`,
`config/serverVersion.ts`, `resources/repoResourceUri.ts`) are 43, 31 and 32 lines, and
`postgres-mcp/src/tools/index.ts` got *shorter* by losing the resource provider. The dependency
guard matters more than the size guard here, and it is at 0: no move crossed a tier boundary,
introduced a cross-server import, or moved `process.env` access out of `config/`.

### How the moves were made

`scripts/restructure/` — `move-map.mjs` declares the per-server mapping, `apply.mjs` executes it.
Imports are rewritten *before* the files move (resolving against the old tree, emitting against the
new one), then `git mv` performs the moves so rename detection survives: of the 158 relocations,
**157 are tracked as renames** and the single delete is `serverUtils.ts`, whose two halves became
new files. (A further 63 files are edited in place — the importers that did not themselves move,
plus the scripts and docs from the previous section.) The script validates
the map against the tree before writing anything, and refuses to run on a missing source, an
occupied target, or a duplicate destination.

The map is kept because it is the reviewable artifact — it states, per file, where the thing went
and why the folder is right. Re-running it on the migrated tree is a no-op that fails loudly.
