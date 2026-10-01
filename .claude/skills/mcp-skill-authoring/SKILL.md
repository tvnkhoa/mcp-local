---
name: mcp-skill-authoring
description: "Add a new MCP server to this workspace's install/skill system (scaffold with npm run new:server, snapshot its contract, register it in packages/manifest/src/servers.ts + envSpecs, generate, install) and write or improve the operational <server>/skill/SKILL.md template that the installer renders into a native skill. Use when adding a server, editing any <server>/skill/SKILL.md, a skill fails to trigger on realistic phrasing, or after renaming tools/env vars that a skill names. Not for the authoring skills in .claude/skills/ themselves, and not for writing the server's tool code (docs/servers/tool-development.md)."
---

# MCP Skill Authoring

**One manifest entry + one env spec + one template ⇒ installer, doctor, update/uninstall, contract
snapshot, generated docs and a native skill all work for the server.**

## 1. Scaffold

```bash
npm run new:server -- --key foo            # [--dir foo-mcp] [--display "Foo MCP"] [--desc "…"] [--no-verify] [--force]
```

`--key` must match `^[a-z][a-z0-9-]*$`, and **`-mcp` is appended if missing** — `--key foo`
yields key `foo-mcp`, dir `foo-mcp`, env prefix `FOO_*`, `FooConfig`. It copies `templates/server/`,
runs `build:packages`, then `npm install` / build / typecheck / test / smoke in the new dir (skip with
`--no-verify`). It does **not** register the server — the printed "Next" block lists the steps.

## 2. Register (order matters)

`servers.ts` calls `toolsFor(key)`, which **throws at import** when `generated/toolLists.ts` has no
entry; that list is generated from `contracts/<key>.json`; and `contract-snapshot.mjs` only snapshots
servers already in `SERVERS`. So bootstrap the first snapshot like this:

1. `packages/manifest/src/envSpecs/<camel>.ts` — the env contract (fields below).
2. Append the entry to `SERVERS` in `packages/manifest/src/servers.ts` with a **temporary**
   `tools: ["health_check"]` instead of `toolsFor("<key>")`, then `npm run build:packages`.
3. `npm run contracts:update -- --server <key>` → `contracts/<key>.json`.
4. `npm run generate:tools`, switch the entry to `tools: toolsFor("<key>")`, then `npm run generate:all`
   (tool lists → `.env.example` → README generated blocks; it rebuilds packages).
5. `npm run generate:check && npm run contracts:check`.

> "Snapshot, then register" fails with `No server matched` because the snapshotter reads the
> manifest. The new-server "Next" block, `templates/server/README.md` and
> `docs/servers/server-development.md` §2 all carry the bootstrap above.

Entry shape (`ServerDescriptor`, `packages/manifest/src/types.ts`): `key`, `displayName`, `dir`,
`entry: "dist/index.js"`, `tagline`, `build: { install, guards: [] }` (guards = extra npm scripts
after build, e.g. `guard:no-llm-runtime`), `smokeTest` (or `null`), `skillSource: "<dir>/skill"`,
`tools`, `env`.

**`EnvField`** — `name`, `required` (mandatory in the type), `secret`, `default` (**written into
`~/.claude.json` and pins the value**), `codeDefault` (documentation only — use for tuning knobs;
never both), `prompt` (asked interactively; also pins), `group` (+ `prefix`/`familyExamples` for an
`*_ENV_*` family), `kind`/`enumValues` (what `mcp:doctor` validates without printing the value),
`deprecatedAliases`, `section`, `note`. No secret gets a `default`; don't take a name another tool
owns (`POSTGRES_USER` etc.).

Edit `packages/manifest/`, not `scripts/lib/manifest.mjs` (a re-export shim), and run
`npm run build:packages` after any manifest edit so `scripts/` sees it.

## 3. Write the template (`<dir>/skill/SKILL.md`)

`scripts/lib/skills.mjs` substitutes `{{KEY}}` `{{DISPLAY_NAME}}` `{{TAGLINE}}` `{{ENTRY_PATH}}`
`{{TOOL_NAMESPACE}}` (`mcp__<key>__*`) `{{TOOL_LIST}}` `{{ENV_TABLE}}`, and writes the project copy
(`.claude/skills/<key>/`), the global copy (`~/.claude/skills/<key>/`, if Claude Code is detected) and
a Copilot prompt (if VS Code is). The rendered copies are gitignored and **overwritten without
warning** — edit only the template. A leftover unknown `{{PLACEHOLDER}}` makes the render throw, and
`mcp:doctor` warns when an installed copy is stale against the template + manifest.

1. **Frontmatter.** `name: {{KEY}}`. `description` is the only thing the model sees when deciding to
   load: capability first, then `Triggers on: …` with the phrases a user actually types (verbs +
   objects: "why did the build fail", "run T-SQL", "trace a request"), then the main gate ("Read-only
   by default"). Keep it **one line with no embedded double quote** — the Copilot renderer reads it
   with a regex that stops at `"`.
2. **Step 0 — orient**: the cheapest discovery calls (`health_check`, `list_*`, `list_environments`).
3. **Workflows** — 2–5 named sequences ("call A, then B with A's id"); a tool list cannot say this.
4. **Guardrails** — what is off by default and the exact canonical env flag that opens it, hard
   bounds, preview-before-apply, scoping rules (exact `repoPath`, `database`, `environment`).
5. **Configuration** — `{{ENTRY_PATH}}` + `{{ENV_TABLE}}`. **Tool reference** — `{{TOOL_LIST}}`.

Every `tool({ arg: … })` and backticked tool name is validated against `contracts/` by `docs:check`;
deprecated env names fail its `env-names` check.

## 4. Install and verify

```bash
node scripts/install-mcp.mjs --server <key> --yes --skip-smoke   # add --skip-skill against a scratch HOME
npm run mcp:doctor -- --server <key>                             # build / config / env / skill / start
npm run mcp:update -- --server <key>                             # after any template edit: rebuild + re-render + verify start
npm run docs:check
```

Restart the host agent (or `/mcp`) afterwards. Test the description: would "<realistic user
request>" obviously match it? If two skills could match, tighten both.

## Authoritative reference

`docs/servers/server-development.md` §1–3 and §6 (scaffold, manifest, env-field semantics, install
and doctor). Types: `packages/manifest/src/types.ts`. Renderer: `scripts/lib/skills.mjs`.
Scaffolder: `scripts/new-server.mjs`.
