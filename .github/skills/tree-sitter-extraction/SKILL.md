---
name: tree-sitter-extraction
description: "Extract symbols, imports, and call edges from source code using tree-sitter for codebase indexing MCP workflows. Use when implementing parser-based code intelligence."
---

# Tree-sitter Extraction

## When to Use
- Build AST-based extraction for dependencies/call chains.
- Replace fragile regex-based code analysis.

## Procedure
1. Select supported languages and parser versions.
2. Define extraction contract per language:
   - file-level module id
   - symbol definitions
   - import/export relations
   - invocation/call edges
3. Normalize extracted entities into common graph schema.
4. Track unresolved symbols separately (do not silently drop).
5. Add parser failure counters and fallback strategy.

## Quality Checks
- Stable symbol IDs across incremental runs.
- Deterministic extraction for unchanged files.
- Bounded parse time and memory usage.
