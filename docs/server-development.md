# Server Development Guide

Building a new MCP server, and working on an existing one. For the tools inside it, see
[Tool Development Guide](tool-development.md).

The measure this workspace holds itself to is that **adding server #5 is additive**: one directory,
one manifest entry, one env spec, one skill template. The installer, doctor, updater, skill
generator, contract snapshotter and every root aggregate pick it up with no further edit.

---

## 1. Scaffold

```bash
npm run new:server -- --key myserver
npm run new:server -- --key myserver --dir myserver-mcp --display "My Server MCP" --no-verify
```

Copies `templates/server/`, substituting `__KEY__`, `__DIR__`, `__PASCAL__`, `__CAMEL__`,
`__DISPLAY__`, `__ENV_PREFIX__`, `__DESC__`, then builds, typechecks, tests and smoke-tests it. The
result passes both guards with zero findings and needs no hand-editing to run.

You get:

```
myserver-mcp/
  src/index.ts                        entry point — config load, createMcpServer, runServer
  src/config/index.ts                 the ONLY reader of process.env
  src/tools/index.ts                  buildTools() + toWireError()
  src/tools/tools.test.ts             definition, happy path, rejection, error envelope
  src/middleware/errors.ts            the {code, message, detail?} wire envelope
  src/middleware/responseFormatter.ts
  scripts/smoke-test.mjs
  skill/SKILL.md                      the operational-skill template
  README.md  package.json  tsconfig.json  tsconfig.test.json
```

No `.gitignore` — the root one covers every server ([ADR 0003](adr/0003-single-root-gitignore.md)).
Only the slots with content are created; add `services/`, `repositories/`, `resources/`, `types/` as
the server grows ([Folder Convention](folder-convention.md) §2).

### The scaffold deliberately does not register the server

There is an ordering constraint it cannot satisfy: `servers.ts` **throws** for a server with no
generated tool list, the tool list comes from `contracts/`, and a contract snapshot needs a built
server. So the sequence is **scaffold → build → snapshot → register → generate**.

That omission is also what makes a scratch server free: delete the directory and `verify:all` still
exits 0, with nothing to clean up elsewhere.

---

## 2. Register it

Three steps, in this order, because each produces what the next reads.

### Step 1 — snapshot the contract

```bash
cd myserver-mcp && npm run build && cd ..
node scripts/contract-snapshot.mjs --server myserver
```

Writes `contracts/myserver.json` from a real stdio handshake.

### Step 2 — declare it in the manifest

**`packages/manifest/src/servers.ts`** — append one entry:

```ts
{
  key: "myserver",                     // the MCP registration key: mcp__myserver__<tool>
  displayName: "My Server MCP",
  dir: "myserver-mcp",                 // directory under the workspace root
  entry: "dist/index.js",              // POSIX-separated, relative to dir
  tagline: "One line. Shown in the generated skill and the install summary.",
  build: { install: true, guards: [] },   // guards = extra npm scripts run after build
  smokeTest: "node scripts/smoke-test.mjs",
  skillSource: "myserver-mcp/skill",
  tools: toolsFor("myserver"),         // generated — never hand-written
  env: myserverEnv
}
```

**`packages/manifest/src/envSpecs/myserver.ts`** — the environment contract, one file per server:

```ts
export const myserverEnv: readonly EnvField[] = [
  { name: "MYSERVER_BASE_URL", required: true, section: "Target",
    prompt: "Base URL of the upstream API", kind: "string" },

  { name: "MYSERVER_TOKEN", required: false, secret: true, group: "myserver-auth",
    section: "Auth", prompt: "API token" },

  { name: "MYSERVER_WRITE_ENABLED", required: false, default: "false", section: "Write gate",
    note: "Writes are DISABLED unless true." },

  { name: "MYSERVER_TIMEOUT_MS", required: false, codeDefault: "30000", section: "HTTP" }
];
```

Field semantics that are easy to get wrong:

| Field | Effect |
|---|---|
| `required: true` | not optional in the type — every field must state it, so adding a server forces the decision rather than defaulting to "not required" by omission |
| `secret: true` | never echoed by the doctor or the install summary |
| `default` | **written into `~/.claude.json`**, which *pins* the value. A tuning knob pinned at today's default stops tracking the code's default when that changes |
| `codeDefault` | documentation only — appears commented out in `.env.example` and marked *(code)* in the README table; the installer stays silent. **Never both `default` and `codeDefault`** (a test asserts it) |
| `prompt` | the installer asks interactively, and writes the answer (so it pins, like `default`) |
| `group` | "at least one var in this group must be set" |
| `kind` / `enumValues` | the shape `mcp:doctor` validates. Doctor must never print a value, so a check is only worth having if its failure can be described by the var's *name* and the expected shape alone |
| `deprecatedAliases` | former names still honoured at runtime, with a one-time deprecation warning. The canonical name wins when both are set |
| `section` | the heading in `.env.example` and the README table; ordering follows first appearance |

**No secret gets a committed default.** And never take a name another tool owns —
`POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` belong to the official postgres Docker image,
which is why the connection string is `POSTGRES_CONNECTION` and not `POSTGRES_DB_CONNECTION`.

If the server introduces a **package**, add a tier row in `packages/cli/src/guards/rules.ts` too —
see [Dependency Rules](dependency-rules.md) §5.

### Step 3 — generate and install

```bash
npm run generate:tools        # contracts/ → packages/manifest/src/generated/toolLists.ts
npm run generate:all          # tools → .env.example → README blocks
node scripts/install-mcp.mjs --server myserver
npm run mcp:doctor -- --server myserver
npm run verify:all
```

---

## 3. Write the operational skill

`<server>/skill/SKILL.md` is the **committed source of truth**; the installer renders it into
`~/.claude/skills/<key>/` (global) and `.claude/skills/<key>/` (project), both gitignored because
they carry machine-specific paths.

Placeholders in `{{DOUBLE_BRACES}}` are filled from the manifest: `{{KEY}}`, `{{DISPLAY_NAME}}`,
`{{TAGLINE}}`, `{{TOOL_NAMESPACE}}`, the tool list, the env table.

The `description:` line is the only thing a model sees when deciding whether to load the skill.
A vague one means it never loads. Name the phrases a user actually types.

A skill earns its place by describing **sequences**, not by listing one tool per heading — "call A,
then B with A's id" is something a tool list cannot express. State the guardrails too: what is
read-only versus gated, which env var opens the gate, the hard bounds, and anything irreversible
with the preview step that must precede it.

See the `mcp-skill-authoring` skill for the full contract.

---

## 4. The server conventions

Every server, without exception (target-architecture §6):

| # | Rule |
|---|---|
| S1 | `src/index.ts` is the only entry point |
| S2 | Layout is the nine-slot standard structure; concerns that do not exist are absent |
| S3 | Config is loaded **once** at startup into a typed object and passed down. No module reads `process.env` except `src/config/` |
| S4 | Script vocabulary: `build`, `typecheck`, `test`, `smoke` (plus `start`, `dev`) |
| S5 | `scripts/smoke-test.mjs` does a real stdio handshake and lists tools |
| S6 | **Fail fast on invalid config** — a missing credential is a startup error, not a per-call one |
| S7 | Destructive operations are `preview → apply → rollback`, HMAC-gated |
| S8 | Write capability is **off** unless an env flag enables it, parsed strictly (exact `"true"` / `"1"`) |
| S9 | Read paths are read-only in depth: validated input **and** a read-only transaction where the engine supports one |
| S10 | Tools are declared through `@mcp/sdk`, never by hand-written protocol plumbing |
| S11 | `tools/list` is snapshotted in `contracts/`; a change is a reviewed diff |
| S12 | `README.md` and `CLAUDE.md` at the server root; all other docs in `docs/` |
| S13 | Registered via `@mcp/manifest` — adding a server means a manifest entry, not editing the installer |

### The three files that carry the conventions

**`src/config/index.ts`** — the one reader of `process.env`, via `@mcp/core`'s reader. Validate here
so the server refuses to start rather than failing on the first call:

```ts
const env = createEnvReader(defaultEnvSource());

export function loadConfig(): MyserverConfig {
  const baseUrl = env.string("MYSERVER_BASE_URL", "");
  if (baseUrl === "") throw new Error("MYSERVER_BASE_URL is required — see .env.example");
  return { baseUrl, timeoutMs: env.positiveNumber("MYSERVER_TIMEOUT_MS", 30_000) };
}

/** Non-secret echo for health_check and the start-up log. Report whether a secret is PRESENT. */
export function describeConfig(config: MyserverConfig): Record<string, unknown> {
  return { baseUrl: config.baseUrl, timeoutMs: config.timeoutMs };
}
```

**`src/index.ts`** — construction only, no testable logic:

```ts
const config = loadConfig();
const eventLog = createEventLogger();

const handle = createMcpServer({
  name: "myserver",
  version: "0.1.0",
  tools: buildTools(config),
  formatError: (error) => asErrorPayload(toWireError(error), "verbose")
});

runServer(handle, {
  onStarted: () => eventLog.info("server_started", { config: describeConfig(config) }),
  onCrash: (error) => eventLog.error("server_crashed", { error: mapError(error) })
});
```

Do not hand-write a `main()` / `process.exit` tail — `runServer` owns it, and is the one reviewed
place that calls `process.exit`. Set `stopOnCrash` when the server acquires a resource (a database
handle, a file watcher) *before* `start()`, so a failed start-up still runs its shutdown hooks.

**`src/tools/index.ts`** — the tool table, separated from the entry point precisely so it can be
tested against a stub config with no server running.

### Declaring resources or prompts

**Supplying the option is what declares the capability.** A server with none must not advertise it,
so both are optional and absent from `initialize` until you pass one:

```ts
createServer({ name, version, tools, resources: [schemaResource] });
```

An empty array counts as none at all. A `ResourceProvider` is never second-guessed that way — it may
be serving state that is only empty right now.

---

## 5. Day-to-day on an existing server

```bash
cd <server>
npm run build              # tsc → dist/
npm run typecheck          # source + tests (tsconfig.json --noEmit && tsconfig.test.json)
npm run test               # node:test over src/**/*.test.ts
npm run smoke              # real stdio handshake — NEEDS A BUILD
npm run dev                # tsx, from source, no build
```

Then restart the MCP server in your agent (`/mcp` or the IDE MCP panel) and call the tools directly.
That is the fast loop; run the full gate before committing.

`codebase-index-mcp` has more:

```bash
npm run test               # unit first, then 31 integration harnesses, one result
npm run test:unit          # node:test over src/**/*.test.ts — no build, no DB
npm run test:integration   # the .mjs harnesses only (needs a build)
npm run test:refactor-engine    # any single harness, by name
npm run guard:no-llm-runtime    # the hard no-LLM policy
npm run benchmark:plan:check    # compact-mode token savings must stay ≥ 40%
```

The suite is **discovered** from `package.json` rather than listed, so it cannot fall behind when
someone adds a `test:*` script. `test:unit` runs first: a compile-level break should not wait behind
31 harnesses that each need a build.

> Nine harnesses in `codebase-index-mcp/scripts/test/` are wired to no npm script and therefore
> never run. They were already unverified before the standard-structure move and nothing since has
> fixed or worsened that.

---

## 6. Install, doctor, update, uninstall

```bash
npm run setup                                  # everything, interactive env prompts
node scripts/install-mcp.mjs --server <key>    # one server
npm run mcp:doctor                             # health report — never prints secrets
npm run mcp:update -- --server <key>           # rebuild + regenerate skill + verify start
npm run mcp:uninstall -- --server <key>        # remove config + skill (config backed up)
```

`install` and `doctor` act on **all** servers when given no target; `update` and `uninstall`
**require** `--server <key>` or `--all`.

`mcp:doctor` checks five things per server:

| Check | Passes when |
|---|---|
| `build` | `dist/index.js` exists — plus a `dist` sub-check that no `dist/**/*.js` lacks a matching source |
| `config` | registered in a detected agent, with `args` pointing at the built entry |
| `env` | required keys and group members are **present** (keys only — never values) |
| `skill` | the operational skill is installed under `~/.claude/skills/<key>/` |
| `start` | the process spawns and answers `initialize` |

Plus a warning when a generated file is stale.

### Running one server against several backends

Register it more than once with a suffix per environment, each carrying its own credentials:

```
observe-mcp-ssdev_au        →  the dev OpenObserve
observe-mcp-wecrm_au_prod   →  the prod OpenObserve
```

This is **supported, not a workaround**. Doctor recognises `<key>` and `<key>-<suffix>`, **names
every instance it found**, and runs `env` and `start` once per instance — starting one proves nothing
about a sibling with different credentials. Instances are named rather than counted so a registration
you did not expect is visible, including a stale one left by a rename.

### Two things the installer does that will surprise you

- **`configureAgent` replaces a server's entry wholesale.** Whatever env the installer collects *is*
  the new env; anything omitted is deleted. It reads the existing config first so re-running `setup`
  does not reset values you tuned by hand — but that recovery is the only thing standing between a
  re-install and a silently narrowed `CODEBASE_INDEX_ALLOWED_ROOTS`.
- **`~/.claude.json` is live machine state.** Server directory names and entry points are recorded
  there, so changing either breaks every agent session until re-registration. That is why moving the
  servers into a `servers/` directory was skipped (S-42) — it is the only change in the whole
  migration plan that rewrites it.

---

## 7. Renaming a server key

The key is user-visible configuration — clients namespace tools as `mcp__<key>__<tool>`. Renaming it
touched 54 occurrences across 23 files last time (S-44). Do it in this order, and note the trap:

1. Uninstall the **old** key **first**. `mcp:uninstall --server <old>` resolves keys through the
   manifest, so it fails with *"Unknown server"* the moment the manifest stops declaring it. Use
   `--key <name>`, which bypasses manifest resolution for exactly this case.
2. Rename in `servers.ts`, `envSpecs/`, the contract snapshot file **and its internal `server`
   field**, `.gitignore`'s skill-dir pattern, and the skill template.
3. Replace the tool namespace `mcp__<old>__*` **before** the bare key — the longer string contains
   the shorter one.
4. `npm run generate:all`, then reinstall.
5. Check **every** detected agent config, not just Claude Code. The installer may have written to VS
   Code and OpenCode too.

Leave historical records alone: migration docs and the CHANGELOG describe a past state, and rewriting
them makes the record claim something that never happened.

---

## 8. Before you commit

```bash
npm run verify:all
```

See [Development Guide](development.md) for what that covers, what CI covers, and where the two
differ.

---

## Related

- [Tool Development Guide](tool-development.md) · [Development Guide](development.md)
- [Folder Convention](folder-convention.md) · [Dependency Rules](dependency-rules.md)
- [Package Overview](packages.md) — what `@mcp/sdk` and `@mcp/shared` give you
- `templates/server/README.md` — the scaffold's own instructions
- `packages/manifest/README.md` — the manifest reference
- `.claude/skills/mcp-scaffold/` · `mcp-skill-authoring/` · `mcp-security-review/` ·
  `mcp-release-checklist/`
