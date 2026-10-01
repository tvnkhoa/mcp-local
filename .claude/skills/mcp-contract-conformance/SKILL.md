---
name: mcp-contract-conformance
description: "Check that a change keeps each server's public MCP contract (the tools/list snapshot in contracts/<key>.json: tool names, descriptions, input schemas, annotations) intentional, reviewed and in sync with the generated tool lists, READMEs and skill templates. Use when adding, removing or renaming a tool, editing a description or inputSchema, changing defaults/bounds, when contracts:check or generate:check is red, or before a release. Not for choosing annotation values (mcp-tool-annotations) or error-code design (mcp-error-taxonomy)."
---

# MCP Contract Conformance

`tools/list` **is** the API. A rename, a dropped property, a changed enum or a loosened `required`
type-checks fine and still breaks every client. The committed snapshot turns that into a `git diff`.

## What is in the contract, and what checks it

| Artifact | Checked by |
|---|---|
| `contracts/<key>.json` — sorted `tools/list` from a real stdio handshake, placeholder env | `npm run contracts:check` (needs every server built) |
| `packages/manifest/src/generated/toolLists.ts` (from `contracts/`) and the README `BEGIN/END GENERATED` blocks | `npm run generate:check` |
| Tool names and `tool({ arg: … })` examples in **any** `.md` — READMEs, `<server>/skill/SKILL.md`, these skills | `npm run docs:check` (`tool-names`, `tool-args`, `claims`) |
| zod `input` vs advertised `inputSchema` | `@mcp/testing` `assertSchemaParity`, run in every server's unit tests (`src/tools/tools.test.ts` or `src/tools/schemaParity.test.ts`) |
| Error envelope shape | codebase-index `npm run test:server-envelopes`; other servers' `src/**/*.test.ts` |

Tool advertisement is **not** env-dependent: gated tools are always listed and refuse at call time,
which is why one snapshot per server suffices. Keep it that way — hiding a tool behind a flag makes
the snapshot depend on the snapshotting machine.

## Checklist

1. **Inventory.** `git diff contracts/` — every added/removed/renamed tool is intended and named in
   the change description. A rename is breaking: follow `docs/servers/tool-development.md` §9.
2. **Schemas.** `required` not loosened or tightened by accident; new properties optional unless the
   change is declared breaking; `additionalProperties` / `.strict()` unchanged; bounds (`maximum`)
   match the handler's clamp.
3. **Annotations.** Any hint change is deliberate (see `mcp-tool-annotations`).
4. **Descriptions.** Edited text is still accurate about gates (env flag names must be the canonical
   ones from `envSpecs/`, not deprecated aliases — `docs:check` `env-names` catches this).
5. **Downstream.** `generate:all` regenerated tool lists/READMEs; `<server>/skill/SKILL.md`
   updated for the new sequence; `mcp:update -- --server <key>` to reinstall the rendered skill.

## Commands

```bash
cd <server> && npm run build && cd ..
npm run contracts:check                          # all five; red = drift
npm run contracts:update -- --server <key>       # only after deciding the drift is intended
git diff contracts/                              # this IS the review
npm run generate:all && npm run generate:check
npm run docs:check                               # needs npm run build:packages on a fresh clone
```

**Never re-snapshot to turn a red check green.** If the diff was not intended, it is the defect.

## Output

`pass` / `fail`; findings as `high` (breaking for existing callers) / `medium` (contract changed but
compatible, or docs/skill out of sync) / `low` (wording), each with the fix.

## Authoritative reference

`contracts/README.md` (snapshot semantics, determinism) and `docs/servers/tool-development.md`
§8–9 (update and rename procedure). Gate wiring: `docs/development/workflow.md` §4.
