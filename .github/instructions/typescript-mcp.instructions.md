---
description: "Use when implementing or refactoring TypeScript Node.js MCP servers in this workspace. Covers ESM imports, schema validation, MCP tool contract clarity, and script compatibility."
applyTo: "{codebase-index-mcp,postgres-mcp}/**/*.{ts,tsx,mts,cts}"
---
# TypeScript MCP Implementation Rules

- Keep ESM style imports/exports and include `.js` in local import paths when required by build output.
- Keep strict typing: avoid `any`; prefer explicit unions/types for tool input/output.
- Validate external/tool input with `zod` before business logic.
- Return actionable errors: include clear cause + suggested fix where possible.
- Keep functions focused and small; extract guardrails/safety logic into separate files.

## MCP Tool Contract
- Tool name should be explicit and stable.
- Input schema must match actual runtime behavior.
- If a parameter has hard limits (timeout/limit), enforce and document consistently.
- Avoid silent coercion that hides invalid inputs.

## Compatibility Checklist
- Keep scripts compatible with `build`, `dev`, `start`, `typecheck`.
- If behavior changes, update `README.md` examples and expected input/output.
