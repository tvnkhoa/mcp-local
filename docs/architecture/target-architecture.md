# Target Architecture — Internal Local MCP Platform

**Written** — 2026-07-27
**Input** — `docs/architecture/audit-report.md`

> **Provenance.** Produced as Phase 1 of the architecture engagement under the constraint
> *"DO NOT MOVE ANY FILE. DO NOT IMPLEMENT ANY CODE"*, so it was originally delivered as a design
> rather than committed. Recorded here retroactively. §9 reconciles the design against what has
> since actually been built, and marks what is still target-only.

---

## 0. Goals and the constraints they impose

| Requirement | What it rules out |
|---|---|
| Local-first, internal only | No telemetry, no package publishing, no cloud service dependency. Every package `"private": true` |
| No cloud dependency | No hosted registry for the shared packages; they resolve from disk |
| Monorepo | One repository, one shared compiler contract, one command to verify everything |
| Shared SDK + shared core | Protocol handling and primitives each live in exactly one place |
| Independent MCP servers | A server must remain separately buildable and runnable. **No server may import another** |
| Reusable tool builder | Declaring a tool is data + a handler, not hand-written protocol plumbing |
| Consistent folder conventions | Same concern, same path, in every server |
| Easy onboarding | A new contributor reaches a working install without reading source |
| Easy scalability | Adding server #5 is additive: one manifest entry, one directory |

Two constraints come from the audit rather than the goals, and they dominate the design:

- **Native modules must not be hoisted.** `better-sqlite3`, `tree-sitter`, and `sqlite-vec` are
  compiled. Restructuring `node_modules` risks a rebuild that needs VS C++ Build Tools. Therefore
  **servers are not npm workspace members** — workspaces are scoped to `packages/*`, and servers
  consume shared code through `file:` dependencies, which npm satisfies with a symlink.
- **`~/.claude.json` is live machine state.** Server directory names and entry points are recorded
  there. Any change to them breaks every agent session until re-registration, so directory moves
  are treated as separate, explicitly-approved steps.

---

## 1. Folder tree

```
mcp-local/
├── package.json                     workspaces: ["packages/*"] + aggregate scripts
├── tsconfig.base.json               the one compiler contract for packages
├── tsconfig.json                    solution file — project references only
├── tsconfig.test.json               type-checks the *.test.ts each package excludes
│
├── packages/                        shared platform code (workspace members)
│   ├── core/                        L0  zero runtime dependencies
│   │   ├── src/
│   │   │   ├── result.ts            Result<T,E> — the cross-boundary return type
│   │   │   ├── errors.ts            PlatformError taxonomy + PolicyViolationError
│   │   │   ├── env.ts               the ONLY permitted reader of process.env
│   │   │   ├── logging.ts           stderr-only logger + event logger
│   │   │   ├── redaction.ts         secret masking, URI credential masking
│   │   │   ├── json.ts              payload normalization, stable stringify
│   │   │   ├── profiles.ts          nano | compact | standard | verbose
│   │   │   ├── limits.ts            bound resolution for limit / timeoutMs
│   │   │   ├── paths.ts             posix normalization, containment checks
│   │   │   └── index.ts             barrel
│   │   ├── README.md  package.json  tsconfig.json
│   │
│   ├── sdk/                         L1  the ONLY importer of the protocol SDK
│   │   └── src/  schema, toolDefinition, defineTool, guards, responses,
│   │             registry, dispatch, lifecycle, console, healthTool, createServer
│   │
│   ├── shared/                      L2  capabilities — no protocol knowledge
│   │   └── src/  approval/  sql/  http/  fs/
│   │
│   ├── testing/                     L3  harness, golden contracts, leak assertions
│   ├── cli/                         L4  dependency + convention guards
│   └── manifest/                    L5  which servers exist, their entry points and env
│                                        — tooling data; a server may NOT import it
│
├── codebase-index-mcp/              independent server (NOT a workspace member)
│   ├── src/
│   │   ├── index.ts                 entry point
│   │   ├── errors.ts                error taxonomy
│   │   ├── config/                  config + env resolution
│   │   ├── guardrails/              ALL safety / validation logic
│   │   ├── response/                response shaping
│   │   └── <domain>/                extractors/ handlers/ schemas/ …
│   ├── scripts/
│   │   ├── smoke-test.mjs           integration entry — same name in every server
│   │   └── test/                    test harnesses + fixtures
│   ├── docs/                        everything except README / CLAUDE
│   ├── skill/SKILL.md               skill template (installer renders from this)
│   ├── README.md  CLAUDE.md
│   └── package.json  tsconfig.json
│
├── postgres-mcp/   observe-mcp/   bitbucket-mcp/     same shape
│
├── contracts/                       golden tools/list snapshots, one per server
├── scripts/                         installer / doctor / skill generator
│   └── lib/manifest.mjs             re-export shim for @mcp/manifest (S-34; to be deleted)
├── docs/
│   ├── architecture/                this document + the audit
│   ├── migration/                   plan + per-phase notes
│   └── refactor/                    extraction reports
└── .claude/                         rules + authoring skills
```

**Deliberately not `servers/`.** Directory symmetry with `packages/` is cosmetic, and the move is
the only change in the whole plan that rewrites `~/.claude.json`. Deferred behind an explicit
go/no-go (plan step S-42, recommended skip).

---

## 2. Package boundaries

Five packages, each defined by *what it is allowed to know*:

| Package | Tier | Knows about | Must never know about |
|---|---|---|---|
| `@mcp/core` | L0 | Node builtins only | Anything. Zero runtime dependencies |
| `@mcp/sdk` | L1 | `@mcp/core`, `@modelcontextprotocol/sdk`, `zod` | Any capability, any server |
| `@mcp/shared` | L2 | `@mcp/core` | **The protocol SDK and `@mcp/sdk`** — a capability must never reach the wire format |
| `@mcp/testing` | L3 | `@mcp/core`, `@mcp/sdk` | Server internals |
| `@mcp/cli` | L4 | `@mcp/core` | Everything else — it reads source as text |

The boundary that carries the most weight is **`@mcp/shared` must not import the protocol SDK**.
It is what keeps SQL guardrails, approval tokens and HTTP clients testable as plain functions, and
reusable by something that is not an MCP server at all.

`@mcp/core` being **zero-dependency** is the second load-bearing rule: it is what lets every other
tier depend on it without inheriting a dependency graph.

---

## 3. Dependency rules

Enforced statically by `@mcp/cli` (`guard deps`), not by convention:

1. **Imports flow to a strictly lower tier.** Never sideways, never up.
2. **`@mcp/core` has zero runtime dependencies.** Adding one requires an ADR.
3. **`@mcp/sdk` is the only importer of `@modelcontextprotocol/sdk`.** Everything else depends on
   `@mcp/sdk`.
4. **`@mcp/shared` may not import `@mcp/sdk` or the protocol SDK.** Declared as a hard `forbidden`
   list, not merely an omission from `mayImport`.
5. **No server imports another server.** Any shared need is promoted into `packages/`.
6. **No deep imports.** Import a package's entry point; if a symbol is missing, re-export it from
   the index. Enforced by an `exports` map plus the guard.
7. **Every import must be declared** in the importing package's `package.json`.
8. **`process.env` is read in one place per unit** — `@mcp/core/env.ts` for the platform, and each
   server's config module for that server. Everything else receives a typed snapshot.
9. **Servers are not workspace members.** They consume `packages/*` via `file:` dependencies. This
   is a deliberate exception to normal monorepo practice, taken to protect native builds.
10. **Runtime LLM invocation is prohibited** in `codebase-index-mcp` and platform-wide by default,
    verified by a static guard.

**Ordering consequence:** because servers consume `packages/*/dist`, a fresh clone must run
`npm run build:packages` before any server build.

---

## 4. Naming convention

| Thing | Rule | Example |
|---|---|---|
| Package | `@mcp/<noun>`, singular, lowercase | `@mcp/core`, `@mcp/shared` |
| Server directory | `<domain>-mcp`, kebab-case | `postgres-mcp` |
| Server key (manifest / registration) | kebab-case, matches the directory unless history forbids | `bitbucket-mcp` |
| MCP tool name | `snake_case`, verb-first, `^[a-z][a-z0-9]*(_[a-z0-9]+)*$` | `search_symbols`, `write_preview` |
| Source file | `camelCase.ts`, named for its export | `sqlGuardrails.ts` |
| Directory inside `src/` | lowercase, plural when a collection | `guardrails/`, `handlers/` |
| Type / interface / class | `PascalCase`, no `I` prefix | `ToolDefinition`, `PlatformError` |
| Function | `camelCase`, verb-first | `resolveBound`, `issuePreviewToken` |
| Constant | `SCREAMING_SNAKE_CASE` | `ERROR_CODES`, `DEFAULT_UPSTREAM_BACKOFF_MS` |
| Env var | `<SERVER>_<THING>`, one prefix per server | `POSTGRES_WRITE_ENABLED` |
| Error code | stable, machine-readable, `snake_case` for platform codes | `validation_error` |
| Test file | `<subject>.test.ts` beside its subject; harnesses `test-<subject>.mjs` | `sql.test.ts` |

**Factory over constructor**: prefer `createX(options)` returning a frozen object to `new X()`.
It keeps dependencies injectable, which is what makes the shared packages testable without mocks.

---

## 5. Coding convention

- **TypeScript strict**, ESM, `module: NodeNext`, `verbatimModuleSyntax`. Local imports carry the
  `.js` extension, as the build output requires.
- **`Result<T,E>` at boundaries; exceptions inside.** A tool handler returns a `Result`; it does not
  throw across a package boundary. Guards fail closed — a guard that throws is a refusal.
- **No `any`.** Prefer explicit unions. `unknown` at the edges, narrowed immediately.
- **Validate external input with `zod`** before business logic. Hand-written JSON Schema is used
  only for what `tools/list` advertises.
- **Never log to stdout.** stdout is the MCP transport. `console.log` is a build-blocking error;
  the injected logger writes to stderr.
- **Never log secrets.** Redaction happens in the logger, not at each call site, so it cannot be
  forgotten.
- **Named exports only.** No default exports — they are not greppable and survive renames badly.
- **File size caps:** 400 lines soft (warning), 600 hard (error). Test files are exempt from the
  soft cap only. This is the mechanism that prevents another 2,000-line entry point.
- **Comments explain *why*.** The mechanism is readable from the code; the reason a security check
  exists, or why a divergence is intentional, is not.
- **Mechanism, not policy.** A shared module takes its policy as a parameter. `@mcp/shared` ships
  no forbidden-token list; the caller supplies one. This is what allows one implementation to serve
  three servers with three different rules.

---

## 6. Server convention

Every server, without exception:

| # | Rule |
|---|---|
| S1 | `src/index.ts` is the only entry point |
| S2 | Layout is `src/{config,guardrails,response,<domain>}/` + `errors.ts`. Concerns that exist are at the conventional path; concerns that do not exist are absent (a server with no SQL surface has no `guardrails/`) |
| S3 | Config is loaded **once**, at startup, into a typed object, and passed down. No module reads `process.env` except the config module |
| S4 | Script vocabulary is identical everywhere: `build`, `typecheck`, `test`, `start`, `dev`, `smoke-test` |
| S5 | `scripts/smoke-test.mjs` performs a real MCP handshake over stdio and lists tools. It is the check that catches what typecheck and unit tests cannot — module initialization order, transport wiring, startup failure |
| S6 | **Fail fast on invalid config.** A missing credential is a startup error, not a per-call error |
| S7 | Destructive operations are `preview → apply → rollback`, gated by an HMAC approval token bound to the previewed plan |
| S8 | Write capability is **off** unless an explicit env flag enables it, parsed strictly (exact `"true"` / `"1"`) |
| S9 | Read paths are read-only in depth: validated input **and** a read-only transaction where the engine supports one |
| S10 | Tools are declared through `@mcp/sdk`, never by hand-writing protocol plumbing |
| S11 | `tools/list` output is snapshotted in `contracts/`; a change to it is a reviewed diff |
| S12 | `README.md` and `CLAUDE.md` at the server root; all other docs in `docs/` |
| S13 | Registered via `@mcp/manifest` — adding a server means adding a manifest entry, not editing the installer |

---

## 7. Package convention

| # | Rule |
|---|---|
| P1 | `"private": true`. Internal platform, never published |
| P2 | Required files: `package.json`, `tsconfig.json`, `README.md`, `src/index.ts` |
| P3 | `src/index.ts` is a barrel and the **only** public surface. An `exports` map makes deep imports unresolvable rather than merely discouraged |
| P4 | `tsconfig.json` extends `tsconfig.base.json` and adds nothing but paths |
| P5 | Script vocabulary: `build`, `typecheck`, `test`, `clean` |
| P6 | Tests colocate as `*.test.ts` beside their subject |
| P7 | A tier entry in `packages/cli/src/guards/rules.ts` is **mandatory** — a package with no rule fails the guard, forcing an explicit decision about what it may import at review time |
| P8 | `README.md` states the tier, what the package is for, and what it must never import |
| P9 | Mechanism only. No package encodes a server's policy |

---

## 8. How a new server is added

The measure of whether this architecture achieved "easy scalability":

1. `mkdir <domain>-mcp`, copy the conventional skeleton (§1).
2. Add `"@mcp/core": "file:../packages/core"` and `"@mcp/sdk": "file:../packages/sdk"`.
3. Declare tools with `defineTool` and register them with `createToolRegistry`.
4. Add one entry to `packages/manifest/src/servers.ts`, and a `skill/SKILL.md`.
5. `npm run setup`.

The installer, doctor, and skill generator pick it up with no further change. No protocol plumbing,
no response formatter, no guardrail scanner, no env parser is written by hand.

---

## 9. Reconciliation — built vs. still target

Refreshed at `61b1782` (S-34). Rows that moved since the original `829ecd9` snapshot are marked
**↑**, because a reader consulting this table to find remaining work was being told three things
that had already shipped.

| Element | Status |
|---|---|
| `tsconfig.base.json`, solution file, project references, `tsconfig.test.json` | **Built** |
| `packages/{core,sdk,shared,testing,cli}` with the tier model | **Built** |
| `packages/manifest` (L5 tooling data) | **↑ Built** (`61b1782`, S-34) — `scripts/lib/manifest.mjs` is now a re-export shim |
| Dependency guard (tiers, zero-dep, protocol ownership, deep imports, env access, cross-server, tooling-import) | **Built and enforcing** — 0 errors |
| Convention guard (required files/scripts, size caps, no default export, no `console.log`) | **Built and enforcing** |
| Consistent `src/{config,guardrails,response}/` in all four servers | **Built** (`3f5b702`) |
| Servers consuming `packages/*` via `file:` deps | **Built** — all four |
| Shared: response formatting, SQL guardrails, approval tokens, HTTP helpers, env parsing, logging, `PolicyViolationError` | **Built** (`829ecd9`) — 6 of 7 clusters |
| Servers declaring tools via `defineTool` / `createToolRegistry` (S10) | **↑ Built** — all four migrated (S-23…S-33); `codebase-index-mcp` last, at `b3454e1` |
| `contracts/` golden `tools/list` snapshots (S11) | **↑ Built** — `contracts/`, 76 tools across four servers |
| Uniform script vocabulary (S4) | **↑ Built** — all four answer `build` / `typecheck` / `test` / `smoke` (S-03) |
| CI | **↑ Built** — `.github/workflows/ci.yml`, Windows + Node 22, credential-free (S-05) |
| Config loaded once per server (S3) | **Partial** — `postgres-mcp/src/migration/efRunner.ts` still reads `process.env` directly |
| File size caps met by servers | **Not yet** — 34 warnings, 1 accepted exemption; eleven files in `codebase-index-mcp/src` exceed the hard cap. Blocks S-41 |
| `zod` / protocol SDK deduplicated across servers | **Not planned before S-09.** Measured consequence: `mapError` cannot be shared, because `instanceof` compares class identity across copies |
| `servers/` directory move | **Deliberately skipped** (S-42) |

### One design assumption the implementation corrected

The tiering assumed "shared code is strictly better than the copies it replaces". Extraction proved
that is not automatic. Three examples, all now encoded as tests:

- A finite `maxDepth` default in shared JSON normalization **truncated real data** that the server
  copies rendered in full.
- `shouldDropNullish` as `profile !== "verbose"` **changed the `standard` profile's response shape**
  relative to all four servers.
- Enabling Postgres dollar-quote scanning on a SQLite/DataFusion dialect **weakens** the guard: it
  blanks the span between `$…$` markers and hides a forbidden token that would otherwise be caught.

The rule this adds to §5: shared code must be *characterized against its consumers* before they
adopt it. "Mechanism, not policy" is necessary but not sufficient — the mechanism has to be proven
equivalent first.
