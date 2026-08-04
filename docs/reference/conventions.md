# Conventions

The rules this workspace runs on, sorted by the only distinction that matters in practice:
**whether something checks them.**

A convention nobody checks is a preference. Three hand-copied SQL guardrail implementations drifted
apart in this repo precisely because the rule against duplicating them was written down and not
enforced (`adr/0002-sql-guardrail-token-lists.md`). So each rule below says what enforces it.

---

## 1. Enforced by `guard deps`

Run: `npm run guard:deps`. Source of truth: `packages/cli/src/guards/rules.ts` (data, not code).

Every rule below is an **error** and fails the build. Since S-41 that is not a claim on trust:
each one has been shown to reject a deliberate violation (see §8).

| Rule | What fails |
|---|---|
| `tier/violation` | a package imports one at the same or a higher tier — imports flow downward only |
| `tier/unknown-package` | a package with no row in the tier matrix. Adding a package forces an explicit decision about what it may import |
| `tier/zero-dependency` | `@mcp/core` (or any package declaring `allowedExternal: []`) acquires a runtime dependency. Needs an ADR |
| `tier/forbidden-import` | an always-forbidden import regardless of tier — e.g. `@mcp/shared` reaching the protocol layer |
| `tier/undeclared-external` | an external import not in the package's `allowedExternal` list |
| `imports/protocol-sdk` | anything other than `@mcp/sdk` imports `@modelcontextprotocol/sdk` |
| `imports/deep-import` | an import past a package entry point. The `exports` map makes these unresolvable, not merely discouraged |
| `imports/undeclared-dependency` | an import missing from the package's `package.json` |
| `env/direct-access` | `process.env` read outside the permitted files (see §3) |
| `servers/cross-import` | one server imports another. The shared need belongs in `packages/shared` |
| `servers/tooling-import` | a server imports `@mcp/manifest` or `@mcp/cli`. Tooling data belongs to `scripts/`; a server should know only its own config |

## 2. Enforced by `guard convention`

Run: `npm run guard:convention`. Errors except where marked.

| Rule | What fails |
|---|---|
| `size/hard-cap` | a file over **600** lines *(error in `packages/*`; downgraded to a warning inside a server `src/`, see §5)* |
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

### Export only what another file uses

A `export` on something only its own module reads widens the surface for nothing and makes the
symbol look load-bearing to every later reader. Not enforced by a guard; measured on 2026-08-03 and
brought to zero for **values**:

| | unnecessary value exports | unnecessary type exports |
|---|---|---|
| `packages/*` | 0 | 0 |
| the four servers | 0 *(was 30, removed)* | 85 |

**The 85 type exports stay, deliberately.** An exported `interface` or `type` beside the function
whose argument or return it describes is documentation, and it costs nothing at runtime — TypeScript
erases it. The 30 that were removed were functions, classes and consts, where an export is a real
claim that someone else calls it. Re-derive with a word-frequency scan over each unit plus its
`scripts/` (harnesses import from `dist/` at runtime, so the compiler cannot vouch for them and they
must be in the corpus).

---

Env variables are **declared once**, in `packages/manifest/src/envSpecs/<server>.ts` — **98** across
the four servers (41 / 23 / 23 / 11), counted by
`node -e "import('@mcp/manifest').then(m => m.SERVERS.forEach(s => console.log(s.key, s.env.length)))"`.
A field carries either a `default` (which the installer *writes* into
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

## 5. File size

| Cap | Lines | `packages/*` | a server `src/` |
|---|---|---|---|
| soft | 400 | warning | warning |
| hard | 600 | **error** | warning (server trees are passed as `extraDirs`) |

`style/no-default-export` is **not** downgraded — it is an error everywhere.

**Canonical:** [`folder-convention.md`](folder-convention.md) §5 — the current findings, the waiver
pragma, and why the soft cap stays advisory. Re-derive the numbers from `npm run guard:all`, not from
either page.

## 6. Generated files — do not hand-edit

Each server's `.env.example`, the `<!-- BEGIN/END GENERATED -->` blocks in its `README.md`, and its
tool list are rendered from `@mcp/manifest`. Edit the manifest, then `npm run generate:all`.
`generate:check` fails on drift and runs inside `verify:all`.

**Canonical:** [`folder-convention.md`](folder-convention.md) §7 — the file-to-source table and what
regeneration preserves.

## 7. Naming and layout

Server `src/` follows the nine-slot standard structure —
`{tools,resources,prompts,middleware,services,repositories,config,types}/` plus `index.ts`.
Concerns that exist sit at the conventional path; concerns that do not exist are absent.
`src/index.ts` is the only entry point. Tests colocate as `*.test.ts` beside their subject.

Full rules, the per-server slot map, and the naming table: [`folder-convention.md`](./folder-convention.md).
The per-folder ownership table for the largest server is in `codebase-index-mcp/CLAUDE.md`.

*(This section previously described `{config,guardrails,response,<domain>}/`, which the
standard-structure refactor superseded — `refactor/standard-structure-report.md`.)*

## 8. Proof that the guards guard (S-41)

A guard that has never been shown to fail is a guard on trust. Each mechanism below was given a
deliberate violation, confirmed to reject it, and reverted:

| Mechanism | Violation injected | Result |
|---|---|---|
| `guard deps` · `env/direct-access` | `process.env.SNEAKY_VALUE` added to `postgres-mcp/src/index.ts` | rejected |
| `guard deps` · `servers/cross-import` | `observe-mcp` importing `codebase-index-mcp`'s graph store | rejected |
| `guard deps` · `servers/tooling-import` | `bitbucket-mcp` importing `@mcp/manifest` | rejected |
| `guard convention` · `size/hard-cap` | a 700-line file added to `packages/core` | rejected |
| `guard convention` · `style/no-default-export` | a default export added to `packages/core/src/paths.ts` | rejected |
| `guard:no-llm-runtime` | `import OpenAI from "openai"` added to `codebase-index-mcp` | rejected |
| `contracts:check` | renamed `create_pull_request` in the bitbucket snapshot | rejected |
| `generate:check` | hand-edit appended to `observe-mcp/.env.example` | rejected |

Five rules were flipped from warning to error in S-41, once the migration had driven each to zero:
`env/direct-access`, `tier/undeclared-external`, `package/exports-map`, `style/no-default-export`,
`exemption/stale`. CI runs `guard:all` **without** `--strict`, so errors block and `size/soft-cap`
stays advisory.

Re-run the proof with `scripts/prove-guards.sh`.

## 9. Conventions nothing checks yet

Honest list — these are preferences until something enforces them:

- **Comment density and tone.** Comments should explain *why*, not restate the code.
- **A barrel keeps its importers unchanged.** When a file is split, the original filename stays as a
  re-export barrel so no caller changes. Verified by hand (diffing `Object.keys` of the built
  barrel against the original's exports), not by a guard.
- **`dist/` is not pruned by `tsc`**, and servers have no `clean` script. `mcp:doctor` detects the
  stale output but nothing prevents it — [`../development/workflow.md`](../development/workflow.md) §7.

## 10. Documentation language

**New documents are written in English.** The two Vietnamese server READMEs (`postgres-mcp`,
`bitbucket-mcp`) predate this and stay as they are — translating them would churn a working document
for symmetry alone, and their generated blocks are language-independent. Everything a second
maintainer must read to work here is English: the portal, the guides, the reference, the decisions.
