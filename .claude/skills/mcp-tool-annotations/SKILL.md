---
name: mcp-tool-annotations
description: "Apply consistent read-only, idempotent, and destructive hints to MCP tools to improve client safety and UX."
---

# MCP Tool Annotations

## When to Use
- Add a new tool.
- Change tool behavior from read to write, or vice versa.
- Review tool semantics before release.

## Procedure
1. Classify operation type
   - Read-only: no state mutation.
   - Write non-destructive: mutates but safe to retry only when idempotent.
   - Destructive: overwrite/delete/high-impact mutation.
2. Set semantic hints
   - `readOnlyHint` for pure reads.
   - `idempotentHint` for safe retries with same input.
   - `destructiveHint` for high-impact writes.
3. Verify consistency
   - Tool description, schema, and implementation semantics agree.
4. Document implications
   - README notes expected side effects and retry safety.

## Output Format
- Annotation map per tool
- Mismatch list and required fixes

## Authoritative reference

Annotation helpers: `@mcp/sdk` `annotations.{read,readRemote,preview,apply,create}` (`packages/sdk/README.md`). Which tools are non-read-only and which are destructive is recorded in `contracts/README.md`. Declaring a tool: `docs/servers/tool-development.md`.
