# Codebase Index MCP Skill

Comprehensive codebase analysis and refactoring tools for code agents. Provides graph-based code intelligence, impact analysis, and safe automated refactoring.

## When to Use This Skill

USE FOR:
- Codebase exploration and understanding
- Finding symbols, functions, classes across repositories
- Analyzing dependencies and call chains
- Impact analysis before making changes
- Safe automated refactoring with preview/apply workflow
- Dead code detection and circular dependency analysis
- Cross-repository impact analysis
- Test-to-source linking
- Execution flow tracing
- Symbol renaming assistance

DO NOT USE FOR:
- Direct file editing (use standard file tools)
- Git operations (use git commands)
- Running tests (use test runners)
- Building projects (use build tools)

## Prerequisites

1. MCP server must be configured in your agent
2. Repository must be indexed first using `index_repository`
3. `CODEBASE_INDEX_ALLOWED_ROOTS` must include target repository

## Core Workflow

### 1. Initial Setup

```
# Check if repository is indexed and up-to-date
health_check(repoId: "my-project")

# Index repository (first time or when stale)
index_repository(
  repoPath: "/absolute/path/to/repo",
  mode: "incremental",
  docsMode: "off",
  profile: "compact"
)
```

### 2. Code Exploration

```
# Find symbols by name
search_symbols(
  repoId: "my-project",
  query: "UserService",
  strategy: "name",
  profile: "compact"
)

# Get file structure and symbols
get_file_context(
  repoId: "my-project",
  filePath: "src/services/UserService.ts",
  profile: "compact"
)

# Find symbol at specific line
find_symbol_at_line(
  repoId: "my-project",
  filePath: "src/services/UserService.ts",
  line: 42
)
```

### 3. Dependency Analysis

```
# Get dependency graph
get_dependency_graph(
  repoId: "my-project",
  symbolId: "symbol_123",
  depth: 2
)

# Trace call chain
get_call_chain(
  repoId: "my-project",
  symbolId: "symbol_123",
  direction: "callers",
  depth: 3
)

# Find implementations
find_implementations(
  repoId: "my-project",
  symbolName: "IUserRepository",
  kind: "interface"
)
```

### 4. Impact Analysis

```
# Find files impacted by changes
find_impact_files(
  repoId: "my-project",
  changedFiles: ["src/models/User.ts"],
  depth: 2,
  profile: "compact"
)

# Detect changes and risk
detect_changes(
  repoId: "my-project",
  changedFiles: ["src/services/UserService.ts"],
  policyPreset: "strict-review"
)

# Cross-repository impact
get_cross_repo_impact(
  symbolId: "symbol_123",
  maxDepth: 2
)
```

### 5. Refactoring Workflow

**IMPORTANT**: Always use preview → apply → rollback workflow

```
# Step 1: Preview refactoring
refactor_replace_preview(
  repoId: "my-project",
  searchPattern: "oldFunctionName",
  replacePattern: "newFunctionName",
  scope: {
    filePaths: ["src/**/*.ts"]
  }
)
# Returns: previewId, approvalToken, hunks, riskFlags

# Step 2: Review preview output carefully
# Check: hunks, riskFlags, scopeCheck, impactSummary

# Step 3: Apply changes (requires approval token)
refactor_replace_apply(
  previewId: "preview_abc123",
  approvalToken: "token_from_preview",
  includeLowConfidence: false
)
# Returns: applyId, filesChanged, editsApplied

# Step 4: If needed, rollback
refactor_replace_rollback(
  applyId: "apply_xyz789"
)
```

### 6. Symbol Migration (Advanced)

For renaming symbols with full impact tracking:

```
refactor_symbol_migration(
  repoId: "my-project",
  symbolId: "symbol_123",
  newName: "newSymbolName",
  scope: {
    includeTests: true,
    includeDocs: false
  }
)
```

## Tool Reference

### Indexing & Health

- `health_check` - Check if repository is indexed and up-to-date
- `index_repository` - Index or re-index repository
- `list_repositories` - List all indexed repositories

### Search & Discovery

- `search_symbols` - Find symbols by name or intent
- `get_file_context` - Get file structure and symbols
- `find_symbol_at_line` - Find symbol at specific line
- `get_symbol_detail` - Get detailed symbol information
- `find_entry_points` - Find application entry points
- `route_map` - Map HTTP routes (for web apps)

### Dependency Analysis

- `get_dependency_graph` - Get symbol dependencies
- `get_call_chain` - Trace function calls (callers/callees)
- `find_implementations` - Find interface implementations
- `trace_execution_flow` - Trace execution paths

### Impact Analysis

- `find_impact_files` - Find files affected by changes
- `detect_changes` - Detect changes with risk scoring
- `get_change_context` - Get context for changed files
- `get_cross_repo_impact` - Cross-repository impact analysis
- `link_tests_to_source` - Link test files to source code

### Refactoring

- `refactor_replace_preview` - Preview text replacements
- `refactor_replace_apply` - Apply previewed changes
- `refactor_replace_rollback` - Rollback applied changes
- `refactor_symbol_migration` - Migrate symbol with full tracking
- `rename_assist` - Get rename suggestions and impact

### Code Quality

- `dead_code_scan` - Find unused code
- `detect_circular_dependencies` - Find circular dependencies
- `get_symbol_blame` - Get git blame for symbol

### Utilities

- `get_file_summary` - Get file-level summary
- `get_folder_summary` - Get folder-level summary
- `get_symbol_context_pack` - Get comprehensive symbol context
- `query_graph` - Direct graph queries (advanced)

## Response Profiles

Control response size with `profile` parameter:

- `nano` - Minimal fields, fastest (best for Plan mode)
- `compact` - Lightweight, minified JSON (recommended default)
- `standard` - Balanced detail
- `verbose` - Full details with debug metadata

**Recommendation**: Use `compact` for most operations, `nano` for high-volume queries.

## Best Practices

### 1. Always Check Health First

```
health_check(repoId: "my-project")
# If shouldReindex: true, run index_repository
```

### 2. Use Incremental Indexing

```
index_repository(mode: "incremental", docsMode: "off")
# Faster than full re-index, skips unchanged files
```

### 3. Refactoring Safety

- **Always preview before apply**
- Review `riskFlags` carefully
- Check `scopeCheck` for unexpected changes
- Use `includeLowConfidence: false` by default
- Keep `approvalToken` for rollback reference

### 4. Performance Optimization

- Use `profile: "compact"` for token efficiency
- Limit `depth` in graph queries (2-3 is usually sufficient)
- Use `maxResults` to cap large result sets
- Prefer `strategy: "name"` over `"intent"` for exact matches

### 5. Multi-Repository Workflows

```
# List all indexed repos
list_repositories()

# Check cross-repo impact
get_cross_repo_impact(symbolId: "symbol_123", maxDepth: 2)
```

## Common Patterns

### Pattern 1: Safe Refactoring

```
1. search_symbols → find target symbol
2. get_call_chain → understand usage
3. find_impact_files → assess blast radius
4. refactor_replace_preview → preview changes
5. Review output carefully
6. refactor_replace_apply → apply if safe
7. Run tests
8. refactor_replace_rollback if tests fail
```

### Pattern 2: Understanding Unknown Code

```
1. get_file_context → understand file structure
2. find_symbol_at_line → identify symbol at cursor
3. get_symbol_detail → get full symbol info
4. get_call_chain → see how it's used
5. trace_execution_flow → understand execution paths
```

### Pattern 3: Impact Analysis Before Changes

```
1. detect_changes → identify changed files
2. find_impact_files → find affected files
3. get_change_context → understand change scope
4. link_tests_to_source → find relevant tests
5. Make informed decision
```

## Error Handling

### Common Errors

**Repository not indexed:**
```
Error: Repository not found
Solution: Run index_repository first
```

**Path not allowed:**
```
Error: Path not in CODEBASE_INDEX_ALLOWED_ROOTS
Solution: Add path to allowed roots in MCP config
```

**Stale index:**
```
Warning: shouldReindex: true
Solution: Run index_repository with mode: "incremental"
```

**Invalid approval token:**
```
Error: Invalid or expired approval token
Solution: Re-run preview to get new token (30min TTL)
```

## Configuration

### Environment Variables

Required:
- `CODEBASE_INDEX_ALLOWED_ROOTS` - Comma-separated absolute paths

Recommended:
- `CODEBASE_INDEX_DB_PATH` - Database location
- `CODEBASE_INDEX_TELEMETRY_ENABLED=true` - Enable telemetry
- `CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET` - HMAC secret for refactor tokens

Optional:
- `CODEBASE_INDEX_MAX_FILES_PER_RUN=20000` - Max files per index run
- `CODEBASE_INDEX_DOCS_INDEXING_ENABLED=false` - Disable docs indexing
- `CODEBASE_INDEX_WATCH_AUTO_START=false` - Disable auto-watch

## Limitations

1. **No LLM Runtime**: Refactor engine uses rule-based logic only
2. **Path Allowlist**: All operations require allowed roots
3. **Language Support**: JavaScript, TypeScript, C# (tree-sitter based)
4. **Approval Tokens**: 30-minute TTL for refactor preview/apply
5. **Worker Pool**: Parsing runs in worker threads (may timeout on very large files)

## Troubleshooting

### Slow Indexing

- Use `mode: "incremental"` instead of `"full"`
- Set `docsMode: "off"` to skip markdown files
- Check `CODEBASE_INDEX_MAX_FILES_PER_RUN` limit
- Increase `CODEBASE_INDEX_PARSE_JOB_TIMEOUT_MS` for large files

### Missing Symbols

- Verify file is within indexed paths
- Check file extension is supported (.js, .ts, .cs)
- Re-run index with `mode: "full"` to rebuild
- Check indexing logs for parse errors

### Refactor Apply Failures

- Verify approval token is from same preview
- Check token hasn't expired (30min TTL)
- Ensure files haven't changed since preview
- Review `riskFlags` for blockers

## Integration Examples

### Claude Desktop

```json
{
  "mcpServers": {
    "codebase-index-local": {
      "command": "node",
      "args": ["D:/Repository/mcp-local/codebase-index-mcp/dist/index.js"],
      "env": {
        "CODEBASE_INDEX_ALLOWED_ROOTS": "D:/Repository/mcp-local",
        "CODEBASE_INDEX_DB_PATH": "D:/Repository/mcp-local/mcp-index.db"
      }
    }
  }
}
```

### VS Code / Cursor / Windsurf

```json
{
  "mcp.servers": {
    "codebase-index-local": {
      "command": "node",
      "args": ["D:/Repository/mcp-local/codebase-index-mcp/dist/index.js"],
      "env": {
        "CODEBASE_INDEX_ALLOWED_ROOTS": "D:/Repository/mcp-local",
        "CODEBASE_INDEX_DB_PATH": "D:/Repository/mcp-local/mcp-index.db"
      }
    }
  }
}
```

### OpenCode

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "codebase-index-local": {
      "type": "local",
      "command": ["node", "D:/Repository/mcp-local/codebase-index-mcp/dist/index.js"],
      "enabled": true,
      "environment": {
        "CODEBASE_INDEX_ALLOWED_ROOTS": "D:/Repository/mcp-local",
        "CODEBASE_INDEX_DB_PATH": "D:/Repository/mcp-local/mcp-index.db"
      }
    }
  }
}
```

## Quick Start

Run one-command setup:

```bash
cd codebase-index-mcp
node scripts/setup.mjs
```

This will:
1. Install dependencies
2. Build the project
3. Auto-detect code agents
4. Configure MCP server
5. Run smoke tests

## Resources

- Full documentation: `README.md`
- Quick reference: `MCP-FIRST-CHEATSHEET.md`
- Issue registry: `mcp-codebase-index-issue-registry.md`
- Agent guide: `../AGENTS.md`

## Support

For issues or questions:
- Check logs in agent console
- Review `mcp-codebase-index-issue-registry.md` for known issues
- Verify configuration in agent settings
- Run `npm run dev` for manual testing
