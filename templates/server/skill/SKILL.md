---
name: {{KEY}}
description: "__DESC__ Triggers on: REPLACE WITH THE PHRASES A USER ACTUALLY TYPES — this line is the only thing the model sees when deciding whether to load this skill."
---

# {{DISPLAY_NAME}}

{{TAGLINE}} Tools are exposed as `{{TOOL_NAMESPACE}}`.

> **Scaffolded — rewrite this file.** It is the *template* the installer renders into
> `~/.claude/skills/{{KEY}}/`. Placeholders in `{{DOUBLE_BRACES}}` are filled from the manifest;
> everything else is yours to write. The `description:` line above matters most: it is the trigger,
> and a vague one means the skill never loads.

## Step 0 — Orient

```
health_check                 // verify configuration + connectivity
echo(message)                // placeholder — delete once real tools exist
```

## Workflow

Describe the *sequences* that actually work, not one tool per heading. A skill earns its place by
saying "call A, then B with A's id" — something a tool list cannot express.

```
// example shape
health_check
first_tool(arg)              // returns an id
second_tool(id, profile: "compact")
```

## Guardrails

State what is refused and why, so the model does not retry a blocked call:

- What is read-only versus gated, and which env var opens the gate.
- Hard bounds on `limit` / `timeoutMs`, and what happens when they are exceeded.
- Anything irreversible, and the preview step that must precede it.

## Response profiles

`nano | compact | standard | verbose` — `compact` is the default. Only `verbose` is pretty-printed.
Prefer `compact` and raise it only when debugging a specific field.

<!-- The installer fills these two from the manifest. Leave them alone. -->

## Environment

{{ENV_TABLE}}

## Tools

{{TOOL_LIST}}
