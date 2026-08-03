# Folder Convention

Where a file goes, and what decides it. Two layouts — one for the platform packages, one for the
servers — plus the workspace root.

The structural half of this is enforced by `npm run guard:convention`
(`packages/cli/src/guards/conventionGuard.ts`). The placement half is not checked by anything; it is
maintained by review, and §2's layer rule is what a reviewer applies.

---

## 1. Workspace root

```
mcp-local/
├── package.json              workspaces: ["packages/*"] + every aggregate script
├── tsconfig.base.json        the one compiler contract for packages/*
├── tsconfig.json             solution file — project references only
├── tsconfig.test.json        type-checks the *.test.ts each package's build excludes
├── .gitignore                the ONLY gitignore (ADR 0003) — its **/ patterns decide every path
│
├── packages/                 the platform — npm workspace members
│   ├── core/  sdk/  shared/  testing/  cli/  manifest/
│
├── codebase-index-mcp/       independent servers — NOT workspace members
├── postgres-mcp/
├── observe-mcp/
├── bitbucket-mcp/
│
├── contracts/                golden tools/list snapshots, one JSON per server
├── templates/server/         the scaffold `npm run new:server` copies
├── scripts/                  installer · doctor · generators · scaffolder · runners
│   ├── lib/                  shared script modules (+ their .test.mjs)
│   └── restructure/          the standard-structure move map, kept as the reviewable artifact
├── docs/                     architecture/ · migration/ · refactor/ · adr/ + top-level guides
└── .claude/                  rules/ (always-on policy) · skills/ (authoring) · commands/
```

**No per-server `.gitignore`.** The root file's `**/`-prefixed patterns already decide every path
(`**/node_modules/`, `**/dist/`, `.env`, `.env.*`, `**/*.tsbuildinfo`). Four copies of the same rules
with nothing checking they agree is the duplication this workspace spent a migration removing —
[ADR 0003](adr/0003-single-root-gitignore.md).

---

## 2. Server `src/` — the nine slots

```
<server>/src/
  index.ts          entry point — the only one
  tools/            MCP tool declarations + handlers/
  resources/        MCP resource providers  (resources/list, resources/read)
  prompts/          MCP prompt declarations (prompts/list, prompts/get)
  middleware/       the call pipeline: guardrails, response serialization, error mapping
  services/         domain logic
  repositories/     data access and persistence
  config/           configuration loading — the only reader of process.env
  types/            shared type and schema declarations
```

**A folder exists only where the server has that concern.** This is target-architecture rule S2, not
a shortcut. An empty `prompts/` in a server that declares no prompts asserts a capability that is not
there, and four identical empty directories teach a reader nothing about which server does what.

### The two placement calls that are not obvious

- **Handlers are `tools/`, not `services/`.** A `*Handler.ts` exists to answer one named tool call,
  so it sits under `tools/handlers/`, beside the declaration whose contract it satisfies. What the
  handler *calls into* — the indexer, the extractor, the EF migration runner — is `services/`.
- **`middleware/` is the call pipeline, not a web-framework analogue.** Guardrails, response
  serialization and error mapping are the three things every call passes through regardless of which
  tool it is. They were previously spread across `guardrails/`, `response/` and a root-level
  `errors.ts`; they are one slot now.

### Which slots each server actually has

| | `tools/` | `resources/` | `prompts/` | `middleware/` | `services/` | `repositories/` | `config/` | `types/` |
|---|---|---|---|---|---|---|---|---|
| codebase-index-mcp | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ |
| postgres-mcp | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | — |
| observe-mcp | ✅ | — | — | ✅ | ✅ | — | ✅ | — |
| bitbucket-mcp | ✅ | — | — | ✅ | ✅ | — | ✅ | — |

- **`prompts/` — absent everywhere.** No server declares an MCP prompt. `@mcp/sdk` supports them
  (`createPrompt` / `registerPrompt`, and `createServer` wires `prompts/list` and `prompts/get`), so
  this is a platform capability with no user yet, not a gap in the servers.
- **`resources/` — absent in observe-mcp and bitbucket-mcp.** Neither advertises the `resources`
  capability, and the SDK derives that capability from whether a provider was supplied. An empty
  folder here would be actively misleading.
- **`repositories/` — absent in observe-mcp and bitbucket-mcp.** Both are stateless HTTP clients
  against a remote API; `services/{observeClient,bitbucketClient}.ts` is the whole data path.
- **`types/` — only in codebase-index-mcp.** It is the only server whose type and schema declarations
  are already separate modules. In the other three, types live beside the single function or client
  that uses them; hoisting them would separate every payload shape from the code that parses it.

### The one deviation

`codebase-index-mcp/src/server.ts` stays at the root beside `index.ts`. The two are one composition
root split across two files because a combined file would breach the 600-line hard cap: `index.ts`
owns env parsing and construction, `server.ts` owns protocol wiring (`formatError`, `renderResult`,
`wrapCall`, resource registration). Filing it under `middleware/` would put the call that *builds*
the pipeline inside the pipeline's own folder. The other three servers construct the server inline
in `index.ts`, which is what rule S1 describes.

### Everything outside `src/`

```
<server>/
  scripts/smoke-test.mjs    real stdio handshake + tools/list — same name in every server
  scripts/test/             integration harnesses (codebase-index-mcp only, 42 files)
  skill/SKILL.md            the operational-skill template the installer renders
  docs/                     everything except README.md and CLAUDE.md
  README.md                 hand-written, with two generated blocks
  CLAUDE.md                 per-server agent guidance (codebase-index-mcp only)
  .env.example              GENERATED from the manifest — do not hand-edit
  package.json  tsconfig.json  tsconfig.test.json
```

---

## 3. Package layout

```
packages/<name>/
  src/
    index.ts        barrel — the ONLY public surface
    <module>.ts     one concern per file, named for its export
    <module>.test.ts   colocated beside its subject
  README.md         states the tier, what it is for, what it must never import
  package.json      "private": true, an "exports" map
  tsconfig.json     extends ../../tsconfig.base.json and adds nothing but paths
```

`@mcp/shared` is the exception to the flat `src/`: each capability is a directory
(`approval/`, `sql/`, `http/`, `fs/`) with its own `index.ts`, because each is independently
importable and **no module there imports a sibling**.

---

## 4. Naming

| Thing | Rule | Example |
|---|---|---|
| Package | `@mcp/<noun>`, singular, lowercase | `@mcp/core` |
| Server directory | `<domain>-mcp`, kebab-case | `postgres-mcp` |
| Server key (manifest / MCP registration) | kebab-case; matches the directory unless history forbids | `codebase-index` (dir: `codebase-index-mcp`) |
| MCP tool name | `snake_case`, verb-first, `^[a-z][a-z0-9]*(_[a-z0-9]+)*$` | `search_symbols` |
| Source file | `camelCase.ts`, named for its export | `sqlGuardrails.ts` |
| Directory in `src/` | lowercase, plural when a collection | `handlers/`, `extractors/` |
| Type / interface / class | `PascalCase`, no `I` prefix | `ToolDefinition` |
| Function | `camelCase`, verb-first | `issuePreviewToken` |
| Constant | `SCREAMING_SNAKE_CASE` | `DEFAULT_UPSTREAM_BACKOFF_MS` |
| Env var | `<SERVER>_<THING>`, one prefix per server | `POSTGRES_WRITE_ENABLED` |
| Unit test | `<subject>.test.ts` beside its subject | `sql.test.ts` |
| Integration harness | `test-<subject>.mjs` in `scripts/test/` | `test-refactor-engine.mjs` |

**Factory over constructor.** Prefer `createX(options)` returning a frozen object to `new X()` — it
keeps dependencies injectable, which is what makes the shared packages testable without mocks.

---

## 5. File size caps

| Cap | Lines | Severity in `packages/*` | Severity in a server `src/` |
|---|---|---|---|
| soft | 400 | warning | warning |
| hard | 600 | **error** | warning |

Server directories are passed to the guard as `extraDirs`, which marks them *not migrated* and
downgrades `size/hard-cap` and `logging/console-log` to warnings there. `style/no-default-export`
is **not** downgraded — it is an error everywhere.

Test files are exempt from the **soft** cap only; length there tracks case count, not production
complexity.

### Current state

```
0 errors · 20 warnings · 1 accepted exemption · across 508 files
```

Of the 20 warnings, **18 are `size/soft-cap`** and **two are `size/hard-cap`**, both in
`codebase-index-mcp` (therefore warnings rather than errors):

| File | Lines |
|---|---|
| `src/repositories/vectorStore.ts` | 716 |
| `src/services/graph/edgeResolverCalls.ts` | 622 |

The accepted exemption is `src/repositories/graphStore.ts` at 841 lines, reported as `info` with its
reason attached.

> Some documents in `docs/` still say *"no hard-cap finding since S-41"* and *"every remaining
> warning is `size/soft-cap`"*. That was true when written; the two files above have since crossed
> the cap. Re-derive the number from `npm run guard:all` rather than from prose.

### Waiving a cap

```ts
// @convention-exempt size/hard-cap: <why this file is the exception>
```

Anchored to the start of a line, in a `//` comment or a `*` JSDoc continuation. Then:

- Only `size/hard-cap` and `size/soft-cap` are exemptable. The other rules catch defects rather than
  proxies for them — `logging/console-log` catches a write to the MCP transport itself, and no
  reason makes that acceptable. Exempting a non-exemptable rule is an **error**.
- A pragma with **no reason** is an error. An unexplained waiver is indistinguishable from an
  accident.
- An exemption that suppresses nothing is `exemption/stale`, an **error** — so the pragma gets
  deleted when the file is finally split instead of implying a constraint that no longer binds.
- An applied exemption is reported as `info` with the reason, so guard output shows what was waived
  and on what grounds. `info` never affects the exit code, including under `--strict`.

Some files are legitimately long because they are **one** thing. `services/indexing/indexPipeline.ts`
(572) is a batch loop whose parts share a mutable accumulator and an abort signal checked at four
points; splitting it further would mean inventing a context object to pass the same state around.
Prefer splitting — but when the file really is one thing, say so in writing.

---

## 6. What `guard convention` enforces

| Rule | Fails when |
|---|---|
| `package/required-file` | a package is missing `package.json`, `tsconfig.json`, `README.md`, or `src/index.ts` |
| `package/required-script` | a package is missing `build`, `typecheck`, or `test` |
| `package/must-be-private` | a package lacks `"private": true` — internal platform, never published |
| `package/exports-map` | a package has no `exports` map, so deep imports cannot be prevented |
| `style/no-default-export` | a default export. Named exports stay greppable and survive renames |
| `logging/console-log` | `console.log`. On stdio, stdout **is** the protocol channel |
| `size/hard-cap` · `size/soft-cap` | see §5 |
| `exemption/not-exemptable` · `exemption/no-reason` · `exemption/stale` | see §5 |

Proven to reject a violation (`scripts/prove-guards.sh`):

| Mechanism | Violation injected | Result |
|---|---|---|
| `size/hard-cap` | a 700-line file added to `packages/core` | rejected |
| `style/no-default-export` | a default export added to `packages/core/src/paths.ts` | rejected |
| `generate:check` | hand-edit appended to `observe-mcp/.env.example` | rejected |
| `contracts:check` | `create_pull_request` renamed in the bitbucket snapshot | rejected |

---

## 7. Generated files — do not hand-edit

| File | Rendered from |
|---|---|
| `<server>/.env.example` | `packages/manifest/src/envSpecs/<server>.ts` |
| the `<!-- BEGIN/END GENERATED: env-table -->` block in `<server>/README.md` | same |
| the `<!-- BEGIN/END GENERATED: tool-list -->` block in `<server>/README.md` | `packages/manifest/src/generated/toolLists.ts` |
| `packages/manifest/src/generated/toolLists.ts` | `contracts/<key>.json` |

Everything **outside** the markers is preserved byte-for-byte, which is what makes regeneration safe
against a README that is mostly hand-written prose — two of them are in Vietnamese, and
`codebase-index-mcp`'s carries an annotated tool catalogue more useful than any generated list.

```bash
npm run generate:all      # tools → env → README blocks
npm run generate:check    # fails on drift
```

`generate:check` runs inside `verify:all` and `mcp:doctor` reports a stale generated file per server
as a warning. Note it is **not** in CI — see [Development Guide](development.md) §4.

---

## 8. Not checked by anything

Honest list. These are preferences until something enforces them:

- **Comments explain *why*, not what.** The mechanism is readable from the code; the reason a check
  exists, or why a divergence is intentional, is not.
- **A barrel keeps its importers unchanged.** When a file is split, the original filename stays as a
  re-export barrel so no caller changes. Verified by hand — diffing `Object.keys` of the built barrel
  against the original's exports — not by a guard.
- **`tsc` does not prune `dist/`.** After renaming or moving a source file, the old compiled module
  stays at the old path and still loads. `npm run mcp:doctor` now reports this as
  `WARN dist stale build output: …`, but there is no `clean` script for servers — the remedy is
  `rm -rf dist && npm run build`.
- **A rebuild does not reach a server that is already running.** The doctor's `start` check spawns a
  *fresh* process, so it confirms the build on disk works and nothing about the process your agent
  is connected to. `WARN running live server predates the current build` is the check that closes
  that gap (`scripts/lib/runningServers.mjs`); the remedy is to restart the MCP server. This is not
  hypothetical — it produced a `codebase-index` server whose every parse failed while `mcp:doctor`
  reported PASS 4/4 and `health_check` reported the index fresh at HEAD.

---

## Related

- [Dependency Rules](dependency-rules.md) — what may import what
- [Server Development Guide](server-development.md) — building a server into these slots
- `docs/refactor/standard-structure-report.md` — the per-server before/after map and the
  compatibility evidence for the move that created this layout
- [ADR 0003](adr/0003-single-root-gitignore.md) — one root `.gitignore`
