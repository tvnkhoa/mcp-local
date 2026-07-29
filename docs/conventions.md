# Conventions

The rules this workspace runs on, sorted by the only distinction that matters in practice:
**whether something checks them.**

A convention nobody checks is a preference. Three hand-copied SQL guardrail implementations drifted
apart in this repo precisely because the rule against duplicating them was written down and not
enforced (`adr/0002-sql-guardrail-token-lists.md`). So each rule below says what enforces it.

---

## 1. Enforced by `guard deps`

Run: `npm run guard:deps`. Source of truth: `packages/cli/src/guards/rules.ts` (data, not code).

| Rule | What fails |
|---|---|
| `tier/violation` | a package imports one at the same or a higher tier — imports flow downward only |
| `tier/unknown-package` | a package with no row in the tier matrix. Adding a package forces an explicit decision about what it may import |
| `tier/zero-dependency` | `@mcp/core` (or any package declaring `allowedExternal: []`) acquires a runtime dependency. Needs an ADR |
| `tier/forbidden-import` | an always-forbidden import regardless of tier — e.g. `@mcp/shared` reaching the protocol layer |
| `tier/undeclared-external` | an external import not in the package's `allowedExternal` list *(warning)* |
| `imports/protocol-sdk` | anything other than `@mcp/sdk` imports `@modelcontextprotocol/sdk` |
| `imports/deep-import` | an import past a package entry point. The `exports` map makes these unresolvable, not merely discouraged |
| `imports/undeclared-dependency` | an import missing from the package's `package.json` |
| `env/direct-access` | `process.env` read outside the permitted files (see §3) |
| `servers/cross-import` | one server imports another. The shared need belongs in `packages/shared` |
| `servers/tooling-import` | a server imports `@mcp/manifest` or `@mcp/cli`. Tooling data belongs to `scripts/`; a server should know only its own config |

## 2. Enforced by `guard convention`

Run: `npm run guard:convention`.

| Rule | What fails |
|---|---|
| `size/hard-cap` | a file over **600** lines |
| `size/soft-cap` | a file over **400** lines *(warning — advisory by design, see §5)* |
| `style/no-default-export` | a default export. Named exports keep a symbol greppable |
| `logging/console-log` | `console.log`. On a stdio transport, stdout **is** the protocol channel — writing to it corrupts the stream |
| `package/required-file` | a package missing `package.json`, `tsconfig.json`, `README.md`, or `src/index.ts` |
| `package/required-script` | a missing script from the vocabulary in §4 |
| `package/must-be-private` | a package without `"private": true`. Internal platform, never published |
| `package/exports-map` | a missing `exports` map |
| `exemption/*` | an exemption pragma with no reason, on a rule that cannot be waived, or that no longer applies |

## 3. Environment access

Exactly two kinds of file may read `process.env`:

- `packages/core/src/env.ts` — the platform's one reader
- each server's own config module, under `src/config/`

Test files are exempt: a test that pins behaviour *across* env values has to set them, and routing
that through the config module would defeat the isolation the test exists for.

Spreading the whole environment into a child process (`{ ...process.env }`) is **inheritance, not
configuration** — `postgres-mcp`'s `efRunner` must do it so `dotnet ef` inherits `PATH` and
`DOTNET_ROOT`. The guard's pattern is narrowed to `process.env.X` / `process.env["X"]` so it does not
report that. A determined author can still evade it by aliasing; the guard is a tripwire for drift,
not a sandbox.

Env variables are **declared once**, in `packages/manifest/src/envSpecs/<server>.ts` — 94 across the
four servers. A field carries either a `default` (which the installer *writes* into
`~/.claude.json`, pinning it) or a `codeDefault` (documentation of what the server falls back to when
unset, never written anywhere). Never both. No secret has a committed default.

## 4. Script vocabulary

Every server answers to the same four, which is what makes the root aggregates work uniformly:

```
build   typecheck   test   smoke
```

Packages use `build`, `typecheck`, `test`, `clean`.

Add a server to `packages/manifest/src/servers.ts` and the installer, doctor, skill generator, and
every root aggregate pick it up automatically — nothing else needs editing.

## 5. File size, and why the soft cap stays advisory

The hard cap is a boundary; the soft cap is a prompt to think. Some files are legitimately long
because they are **one** thing:

- `codebase-index-mcp/src/analysis/staticAnalyzerDeadCodeCSharp.ts` (437) is a single ordered `if`-chain where first-match
  wins and the winning branch decides which reason a suppression is reported under. Splitting it
  risks a reorder, which would change tool output while leaving every count the same.
- `codebase-index-mcp/src/indexing/indexPipeline.ts` (558) is a batch loop whose parts share a mutable accumulator and an
  abort signal checked at four points. Splitting it further would mean inventing a context object to
  pass the same state around — more indirection, no failure made easier to diagnose.

To waive a **hard** cap, state why in the file:

```ts
// @convention-exempt size/hard-cap: <reason>
```

The guard reports it as `info`, and `exemption/stale` fails once it no longer applies. An exemption
without a reason fails. Prefer splitting; when the file really is one thing, say so in writing.

## 6. Generated files — do not hand-edit

Rendered from `@mcp/manifest`; `generate:check` fails on drift and runs inside `verify:all`.

- each server's `.env.example`
- the `<!-- BEGIN/END GENERATED -->` blocks in each `README.md`
- each server's `tools` list (`packages/manifest/src/generated/toolLists.ts`, from `contracts/`)

Edit the manifest, then `npm run generate:all`. `mcp:doctor` reports a stale generated file as a
warning.

## 7. Naming and layout

Server `src/` follows `{config,guardrails,response,<domain>}/` — concerns that exist sit at the
conventional path; concerns that do not exist are absent. `src/index.ts` is the only entry point.
Tests colocate as `*.test.ts` beside their subject.

`codebase-index-mcp/CLAUDE.md` has the per-folder ownership table for the largest server.

## 8. Conventions nothing checks yet

Honest list — these are preferences until something enforces them:

- **Comment density and tone.** Comments should explain *why*, not restate the code.
- **A barrel keeps its importers unchanged.** When a file is split, the original filename stays as a
  re-export barrel so no caller changes. Verified by hand (diffing `Object.keys` of the built
  barrel against the original's exports), not by a guard.
- **`dist/` is not pruned by `tsc`.** After renaming or moving a source file, `rm -rf dist` before
  trusting a run — a stale module at the old path still loads and can mask a broken import. This has
  already produced one false "identical" verification result.
- **Servers have no `clean` script**, so the point above has no one-command remedy.
