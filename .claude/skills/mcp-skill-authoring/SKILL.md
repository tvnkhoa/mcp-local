---
name: mcp-skill-authoring
description: "Register a new MCP server in this workspace so it auto-gets an installer + native skill, and write a strong operational SKILL.md the AI will actually invoke. Use when adding a server to scripts/lib/manifest.mjs, authoring <server>/skill/SKILL.md, or improving an existing operational skill's trigger/guardrails."
---

# MCP Skill Authoring

Use this when wiring a new MCP server into the workspace's install/skill system, or
when writing/improving an operational skill so the model reliably auto-invokes it.

The workspace has a closed loop: **one manifest entry + one template ⇒ installer, doctor,
uninstall/update, and a generated native skill all work for the new server.**

## 1. Register the server (`scripts/lib/manifest.mjs`)

Append an object to `SERVERS`:

```js
{
  key: "my-mcp",                 // key in ~/.claude.json AND the skill dir name
  displayName: "My MCP",
  dir: "my-mcp",                 // package folder under the workspace root
  entry: "dist/index.js",        // built entry point
  tagline: "One line describing what it does.",
  build: { install: true, guards: [] },   // guards: extra npm scripts to run after build
  smokeTest: "node scripts/smoke-test.mjs", // or null
  skillSource: "my-mcp/skill",   // folder holding the SKILL.md template
  tools: ["tool_a", "tool_b"],   // rendered as mcp__my-mcp__tool_a ...
  env: [ /* see env-field shape below */ ],
}
```

**Env-field shape** (drives interactive prompts, the doctor's checks, and the skill's env table):

| Field | Meaning |
|-------|---------|
| `name` | env var name |
| `required` | must be set for the server to work |
| `secret` | sensitive — never echoed by doctor/summary |
| `default` | written silently when the user gives no value |
| `prompt` | if present, the installer asks for it interactively |
| `group` | "at least one var in this group must be set" (e.g. auth alternatives) |
| `prefix` | any present key starting with this satisfies the group (e.g. `PG_ENV_`) |
| `note` | shown near the prompt and in the generated skill's env table |

Only fields with a `prompt` are asked interactively; the rest with a `default` are written silently.

## 2. Write the template (`<dir>/skill/SKILL.md`)

The renderer (`scripts/lib/skills.mjs`) substitutes these placeholders:

- `{{KEY}}` `{{DISPLAY_NAME}}` `{{TAGLINE}}`
- `{{ENTRY_PATH}}` — absolute path to `dist/index.js`
- `{{TOOL_NAMESPACE}}` — `mcp__<key>__*`
- `{{TOOL_LIST}}` — bullet list of tools
- `{{ENV_TABLE}}` — markdown env table from the manifest

Structure a good operational skill as:

1. **Frontmatter** — `name` = server key; `description` must be a strong trigger. Lead with the
   capability, then list concrete phrasings ("Triggers on: …") the user is likely to type. This is
   what makes the model auto-invoke the skill, so be specific and verb-first.
2. **Step 0 — orient** — the cheapest discovery call(s) (`list_*`, `health_check`).
3. **Core workflows** — 2-5 named recipes, each a short fenced tool sequence.
4. **Guardrails** — read-only defaults, write/destructive gates, mandatory scoping, secret hygiene.
   State what is OFF by default and which env flag turns it on.
5. **Configuration (env)** — `{{ENTRY_PATH}}` + `{{ENV_TABLE}}`.
6. **Tool reference** — `{{TOOL_LIST}}`.

## 3. Verify

```
node scripts/install-mcp.mjs --server my-mcp --yes --skip-smoke   # test against a scratch HOME first
node scripts/mcp-doctor.mjs --server my-mcp
```

`mcp-doctor` should report build/config/env/skill/start. Never print secret values in a skill or a
doctor line — keys only.

## Guardrails for this skill

- Keep the manifest the single source of truth for env — do not duplicate env docs in the installer.
- Descriptions are for auto-invocation: test that a realistic user phrasing would match.
- Prefer editing an existing operational skill over adding a parallel one.
- Related policy: `.claude/rules/mcp-base.md`, `.claude/rules/typescript-mcp.md`. For scaffolding the
  server code itself, see the `mcp-scaffold` skill.
