# Usage Examples

Five canonical examples covering the most common agent workflows.

---

## 1. Health Check & Re-index

```
health_check({ repoId: "mcp-local" })
→ { codebaseState: { status: "stale", shouldReindex: true } }

index_repository({ repoId: "mcp-local", repoPath: "D:/1.SourceCode/mcp-local", mode: "incremental", docsMode: "off" })
→ { status: "ok", filesIndexed: 78, symbolsUpserted: 724, edgesUpserted: 1734 }

health_check({ repoId: "mcp-local" })
→ { codebaseState: { status: "ready", shouldReindex: false } }
```

---

## 2. Search & Navigate to a Symbol

```
search_symbols({ repoId: "mcp-local", query: "GraphStore", strategy: "name", profile: "compact" })
→ { symbols: [{ id: "abc123", name: "GraphStore", kind: "class", filePath: "src/repositories/graphStore.ts", line: 45 }] }

get_symbol_context_pack({ repoId: "mcp-local", name: "GraphStore", profile: "compact" })
→ { symbol: { ... }, callers: [...], callees: [...], typeRefs: [...] }
```

Use `strategy: "intent"` for natural-language-like queries, but prefer exact identifier tokens with `"name"`.

---

## 3. Impact Analysis Before a Change

```
find_impact_files({ repoId: "mcp-local", filePath: "src/repositories/graphStore.ts", view: "files", profile: "nano" })
→ { totalFiles: 12, topFiles: [{ filePath: "src/services/indexing/indexPipeline.ts", symbolCount: 8 }, ...], hasMore: true }

find_impact_files({ repoId: "mcp-local", filePath: "src/repositories/graphStore.ts", view: "surface", profile: "compact" })
→ { files: [{ filePath: "src/services/indexing/indexPipeline.ts", callerSymbols: [...] }] }

detect_changes({ repoId: "mcp-local", policy: "strict-review", profile: "compact" })
→ { changes: [{ filePath: "src/repositories/graphStore.ts", riskLevel: "high", riskScore: 0.85 }] }
```

---

## 4. Safe Refactoring Workflow

```
# Step 1: check blast radius first (nano = no hunk content, just summary)
refactor_replace_preview({
  repoId: "mcp-local",
  find: "getUserName",
  replaceExpression: "getUsername",
  findMode: "literal",
  profile: "nano"
})
→ { previewId: "prev_abc", approvalToken: "tok_xyz", totalMatches: 8, affectedFileCount: 3, affectedFiles: [...] }

# Step 2: if blast radius is acceptable, get hunk detail (compact = hunks without full before/after text)
refactor_replace_preview({
  repoId: "mcp-local",
  find: "getUserName",
  replaceExpression: "getUsername",
  findMode: "literal",
  profile: "compact"
})
→ { previewId: "prev_abc", approvalToken: "tok_xyz", groupedPreviewHunks: [{ filePath, lineStart, replacementText }] }

# Step 3: apply
refactor_replace_apply({ previewId: "prev_abc", approvalToken: "tok_xyz" })
→ { applyId: "apply_def", rollbackId: "rb_ghi", filesChanged: 3, totalHunksApplied: 8, success: true }

# Step 4: rollback if needed — takes rollbackId from the apply response, NOT applyId
refactor_replace_rollback({ rollbackId: "rb_ghi" })
→ { rolled back }
```

---

## 5. Cross-Repository Impact

```
# Both repos must be indexed
list_repositories({ profile: "nano" })
→ { count: 2, repos: [{ repoId: "mcp-local", lastRunStatus: "ok" }, { repoId: "wec.be", lastRunStatus: "ok" }] }

get_cross_repo_impact({ symbolId: "abc123", direction: "outbound" })
→ { repos: [{ repoId: "wec.be", usages: 5, files: ["src/api/client.ts"] }] }
```

Cross-repo results are only non-empty when both repos share interface or symbol names in the same index DB.
