---
description: "Use when implementing or refactoring TypeScript Node.js MCP servers in this workspace. Covers ESM imports, schema validation, MCP tool contract clarity, and script compatibility."
---
> Scope: TypeScript sources across all MCP packages.

# TypeScript MCP Implementation Rules

- Keep ESM style imports/exports and include `.js` in local import paths when required by build output.
- Keep strict typing: avoid `any`; prefer explicit unions/types for tool input/output.
- Validate external/tool input with `zod` before business logic.
- Return actionable errors: include clear cause + suggested fix where possible.
- Keep functions focused and small; guardrails and other cross-cutting call-pipeline logic belong in
  `src/middleware/` (`docs/reference/folder-convention.md` §2).

## MCP Tool Contract
- Tool name should be explicit and stable.
- Input schema must match actual runtime behavior.
- If a parameter has hard limits (timeout/limit), enforce and document consistently.
- Avoid silent coercion that hides invalid inputs.

## Compatibility Checklist
- Keep scripts compatible with **`build`, `typecheck`, `test`, `smoke`** (plus `start`, `dev`) —
  `docs/reference/conventions.md` §4. Omitting `test` or `smoke` breaks the root aggregates.
- If behavior changes, update `README.md` examples and expected input/output.
