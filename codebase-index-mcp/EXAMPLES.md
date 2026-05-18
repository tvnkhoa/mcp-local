# Usage Examples

Real-world examples of using codebase-index-mcp for common development tasks.

## Table of Contents

1. [Initial Setup](#initial-setup)
2. [Code Exploration](#code-exploration)
3. [Refactoring](#refactoring)
4. [Impact Analysis](#impact-analysis)
5. [Code Quality](#code-quality)
6. [Cross-Repository Analysis](#cross-repository-analysis)

---

## Initial Setup

### Example 1: First-Time Index

```
User: Index the mcp-local repository

Agent: I'll index the repository for you.

Tool: list_repositories
Result: {
  "repositories": [
    {
      "repoId": "mcp-local",
      "repoPath": "D:\\Repository\\mcp-local",
      "indexed": false
    }
  ]
}

Tool: index_repository
Parameters:
  repoPath: "D:\\Repository\\mcp-local"
  mode: "incremental"
  docsMode: "off"
  profile: "compact"

Result: {
  "success": true,
  "filesProcessed": 156,
  "symbolsExtracted": 1243,
  "edgesCreated": 3421,
  "duration": "12.3s"
}

Agent: Successfully indexed mcp-local repository:
- 156 files processed
- 1,243 symbols extracted
- 3,421 relationships mapped
```

### Example 2: Check Repository Health

```
User: Is the index up to date?

Agent: Let me check the repository health.

Tool: health_check
Parameters:
  repoId: "mcp-local"

Result: {
  "indexed": true,
  "shouldReindex": false,
  "codebaseState": {
    "status": "ready",
    "lastIndexedCommit": "abc123",
    "currentCommit": "abc123",
    "workingTreeClean": true
  }
}

Agent: The index is up to date. Repository is at commit abc123 with a clean working tree.
```

---

## Code Exploration

### Example 3: Find a Function

```
User: Find the GraphStore class

Agent: I'll search for the GraphStore class.

Tool: search_symbols
Parameters:
  repoId: "mcp-local"
  query: "GraphStore"
  strategy: "name"
  profile: "compact"

Result: {
  "symbols": [
    {
      "id": "sym_123",
      "name": "GraphStore",
      "kind": "class",
      "filePath": "codebase-index-mcp/src/graphStore.ts",
      "line": 45,
      "signature": "export class GraphStore"
    }
  ]
}

Agent: Found GraphStore class at:
- File: codebase-index-mcp/src/graphStore.ts:45
- Type: class
- Signature: export class GraphStore
```

### Example 4: Understand File Structure

```
User: What's in the graphStore.ts file?

Agent: Let me get the file structure.

Tool: get_file_context
Parameters:
  repoId: "mcp-local"
  filePath: "codebase-index-mcp/src/graphStore.ts"
  profile: "compact"

Result: {
  "symbols": [
    {
      "name": "GraphStore",
      "kind": "class",
      "line": 45,
      "methods": [
        "constructor",
        "addSymbol",
        "addEdge",
        "getSymbol",
        "findSymbols",
        "getCallChain"
      ]
    }
  ],
  "imports": [
    "better-sqlite3",
    "./types"
  ]
}

Agent: graphStore.ts contains:

Class: GraphStore (line 45)
Methods:
- constructor
- addSymbol
- addEdge
- getSymbol
- findSymbols
- getCallChain

Dependencies:
- better-sqlite3
- ./types
```

### Example 5: Trace Function Calls

```
User: Who calls the addSymbol method?

Agent: Let me trace the callers of addSymbol.

Tool: get_call_chain
Parameters:
  repoId: "mcp-local"
  symbolId: "sym_456"
  direction: "callers"
  depth: 2
  profile: "compact"

Result: {
  "chain": [
    {
      "symbol": "runIndexPipeline",
      "filePath": "codebase-index-mcp/src/indexPipeline.ts",
      "line": 234,
      "confidence": 0.95
    },
    {
      "symbol": "indexRepository",
      "filePath": "codebase-index-mcp/src/index.ts",
      "line": 1523,
      "confidence": 0.92
    }
  ]
}

Agent: addSymbol is called by:

1. runIndexPipeline (indexPipeline.ts:234) - 95% confidence
2. indexRepository (index.ts:1523) - 92% confidence
```

---

## Refactoring

### Example 6: Safe Function Rename

```
User: Rename getUserName to getUsername across the project

Agent: I'll preview the rename first to ensure it's safe.

Tool: refactor_replace_preview
Parameters:
  repoId: "mcp-local"
  searchPattern: "getUserName"
  replacePattern: "getUsername"
  scope: {
    filePaths: ["**/*.ts"]
  }

Result: {
  "previewId": "preview_abc123",
  "approvalToken": "token_xyz789",
  "hunks": [
    {
      "filePath": "src/userService.ts",
      "line": 45,
      "before": "function getUserName(id: string)",
      "after": "function getUsername(id: string)",
      "confidence": 0.98
    },
    {
      "filePath": "src/userService.ts",
      "line": 67,
      "before": "const name = getUserName(userId);",
      "after": "const name = getUsername(userId);",
      "confidence": 0.95
    }
  ],
  "riskFlags": [],
  "impactSummary": {
    "filesAffected": 1,
    "totalChanges": 2
  }
}

Agent: Preview shows 2 changes in 1 file with no risk flags. Applying changes...

Tool: refactor_replace_apply
Parameters:
  previewId: "preview_abc123"
  approvalToken: "token_xyz789"
  includeLowConfidence: false

Result: {
  "applyId": "apply_def456",
  "filesChanged": 1,
  "editsApplied": 2,
  "success": true
}

Agent: Successfully renamed getUserName to getUsername:
- 1 file modified
- 2 edits applied
- No errors
```

### Example 7: Symbol Migration with Impact Tracking

```
User: Migrate CrmCustomerId to IdentityState.CrmCustomerId

Agent: I'll perform a symbol migration with full impact tracking.

Tool: refactor_symbol_migration
Parameters:
  repoId: "mcp-local"
  symbolId: "sym_789"
  newName: "IdentityState.CrmCustomerId"
  scope: {
    includeTests: true,
    includeDocs: false
  }

Result: {
  "previewId": "preview_ghi789",
  "approvalToken": "token_jkl012",
  "impactedFiles": [
    "src/models/Conversation.cs",
    "src/services/ConversationService.cs",
    "tests/ConversationTests.cs"
  ],
  "totalChanges": 15,
  "riskFlags": [
    {
      "type": "high_impact",
      "message": "15 references across 3 files"
    }
  ]
}

Agent: Migration preview shows:
- 15 references across 3 files
- Includes test files
- High impact change

Would you like me to proceed with the migration?

User: Yes, apply it

Tool: refactor_replace_apply
Parameters:
  previewId: "preview_ghi789"
  approvalToken: "token_jkl012"

Result: {
  "success": true,
  "filesChanged": 3,
  "editsApplied": 15
}

Agent: Migration completed successfully. 3 files updated with 15 edits.
```

---

## Impact Analysis

### Example 8: Analyze Change Impact

```
User: I'm modifying User.ts - what will be affected?

Agent: Let me analyze the impact of changes to User.ts.

Tool: find_impact_files
Parameters:
  repoId: "mcp-local"
  changedFiles: ["src/models/User.ts"]
  depth: 2
  profile: "compact"

Result: {
  "impactedFiles": [
    {
      "filePath": "src/services/UserService.ts",
      "reason": "imports User",
      "confidence": 0.98
    },
    {
      "filePath": "src/controllers/UserController.ts",
      "reason": "uses UserService",
      "confidence": 0.92
    },
    {
      "filePath": "tests/UserService.test.ts",
      "reason": "tests UserService",
      "confidence": 0.95
    }
  ]
}

Agent: Changes to User.ts will impact:

Direct dependencies:
- UserService.ts (imports User) - 98% confidence

Indirect dependencies:
- UserController.ts (uses UserService) - 92% confidence

Tests:
- UserService.test.ts - 95% confidence

Recommendation: Run tests for UserService after changes.
```

### Example 9: Risk Assessment

```
User: Assess the risk of my current changes

Agent: Let me analyze the risk of your uncommitted changes.

Tool: detect_changes
Parameters:
  repoId: "mcp-local"
  policyPreset: "strict-review"

Result: {
  "changes": [
    {
      "filePath": "src/graphStore.ts",
      "riskScore": 0.85,
      "riskLevel": "high",
      "reasons": [
        "Core infrastructure file",
        "15 direct dependents",
        "Used in critical path"
      ]
    },
    {
      "filePath": "src/types.ts",
      "riskScore": 0.45,
      "riskLevel": "medium",
      "reasons": [
        "Type definitions",
        "8 direct dependents"
      ]
    }
  ]
}

Agent: Risk assessment of current changes:

HIGH RISK:
- graphStore.ts (score: 0.85)
  - Core infrastructure file
  - 15 direct dependents
  - Used in critical path
  
MEDIUM RISK:
- types.ts (score: 0.45)
  - Type definitions
  - 8 direct dependents

Recommendation: Thorough testing required before commit.
```

---

## Code Quality

### Example 10: Find Dead Code

```
User: Find unused code in the project

Agent: I'll scan for dead code.

Tool: dead_code_scan
Parameters:
  repoId: "mcp-local"
  scope: {
    filePaths: ["src/**/*.ts"]
  }

Result: {
  "deadSymbols": [
    {
      "name": "oldHelperFunction",
      "filePath": "src/utils/helpers.ts",
      "line": 123,
      "reason": "No callers found"
    },
    {
      "name": "deprecatedMethod",
      "filePath": "src/services/LegacyService.ts",
      "line": 45,
      "reason": "No callers found"
    }
  ]
}

Agent: Found 2 potentially unused symbols:

1. oldHelperFunction (utils/helpers.ts:123)
   - No callers found
   
2. deprecatedMethod (services/LegacyService.ts:45)
   - No callers found

Consider removing these if they're truly unused.
```

### Example 11: Detect Circular Dependencies

```
User: Check for circular dependencies

Agent: I'll scan for circular dependencies.

Tool: detect_circular_dependencies
Parameters:
  repoId: "mcp-local"

Result: {
  "cycles": [
    {
      "files": [
        "src/moduleA.ts",
        "src/moduleB.ts",
        "src/moduleA.ts"
      ],
      "severity": "high"
    }
  ]
}

Agent: Found 1 circular dependency:

HIGH SEVERITY:
moduleA.ts → moduleB.ts → moduleA.ts

This creates a circular import that should be refactored.
```

---

## Cross-Repository Analysis

### Example 12: Multi-Repository Impact

```
User: What other repos use this symbol?

Agent: Let me check cross-repository impact.

Tool: get_cross_repo_impact
Parameters:
  symbolId: "sym_999"
  maxDepth: 2

Result: {
  "impactedRepos": [
    {
      "repoId": "frontend-app",
      "usages": 5,
      "files": [
        "src/api/client.ts",
        "src/services/dataService.ts"
      ]
    },
    {
      "repoId": "backend-api",
      "usages": 3,
      "files": [
        "src/controllers/apiController.ts"
      ]
    }
  ]
}

Agent: This symbol is used in 2 other repositories:

frontend-app:
- 5 usages across 2 files
- api/client.ts
- services/dataService.ts

backend-api:
- 3 usages in 1 file
- controllers/apiController.ts

Changes will require coordination across repositories.
```

---

## Advanced Workflows

### Example 13: Complete Refactoring Workflow

```
User: I need to refactor the authentication system

Agent: I'll help you safely refactor the authentication system. Let me start by understanding the current structure.

Step 1: Find entry points
Tool: find_entry_points
Parameters:
  repoId: "mcp-local"
  
Result: Shows authentication entry points

Step 2: Analyze dependencies
Tool: get_dependency_graph
Parameters:
  symbolId: "sym_auth"
  depth: 3

Result: Shows full dependency tree

Step 3: Assess impact
Tool: find_impact_files
Parameters:
  changedFiles: ["src/auth/**/*.ts"]

Result: Shows 23 impacted files

Step 4: Preview changes
Tool: refactor_replace_preview
Parameters:
  searchPattern: "oldAuthMethod"
  replacePattern: "newAuthMethod"

Result: Shows 45 changes across 12 files

Step 5: Apply changes
Tool: refactor_replace_apply
Parameters:
  previewId: "preview_xxx"
  approvalToken: "token_yyy"

Result: Successfully applied changes

Step 6: Verify
Tool: link_tests_to_source
Parameters:
  sourceFiles: ["src/auth/**/*.ts"]

Result: Shows related test files

Agent: Refactoring complete! Summary:
- 45 changes applied across 12 files
- 23 files potentially impacted
- 8 test files identified for verification
- No high-risk flags detected

Next steps:
1. Run test suite: npm test
2. Review changes: git diff
3. Commit if tests pass
```

---

## Tips and Best Practices

### Always Preview Before Apply

```
✓ Good: Preview → Review → Apply
✗ Bad: Direct apply without preview
```

### Use Compact Profile for Performance

```
✓ Good: profile: "compact"
✗ Bad: profile: "verbose" (unless debugging)
```

### Check Health Before Operations

```
✓ Good: health_check → index if needed → query
✗ Bad: Query without checking index status
```

### Limit Depth in Graph Queries

```
✓ Good: depth: 2-3
✗ Bad: depth: 10 (slow and often unnecessary)
```

### Use Incremental Indexing

```
✓ Good: mode: "incremental"
✗ Bad: mode: "full" (unless necessary)
```

---

## Common Patterns

### Pattern: Safe Refactoring
1. `search_symbols` → Find target
2. `get_call_chain` → Understand usage
3. `find_impact_files` → Assess blast radius
4. `refactor_replace_preview` → Preview changes
5. Review output carefully
6. `refactor_replace_apply` → Apply if safe
7. Run tests
8. `refactor_replace_rollback` if tests fail

### Pattern: Understanding Unknown Code
1. `get_file_context` → Understand structure
2. `find_symbol_at_line` → Identify symbol
3. `get_symbol_detail` → Get full info
4. `get_call_chain` → See usage
5. `trace_execution_flow` → Understand flow

### Pattern: Pre-Commit Validation
1. `detect_changes` → Identify changes
2. `find_impact_files` → Find affected files
3. `link_tests_to_source` → Find tests
4. Run tests
5. Commit if passing

---

## Troubleshooting Examples

### Example: Index Out of Date

```
Tool: search_symbols
Result: Error - Index is stale

Solution:
Tool: health_check
Result: shouldReindex: true

Tool: index_repository
Parameters:
  mode: "incremental"
  
Result: Index updated successfully
```

### Example: Path Not Allowed

```
Tool: index_repository
Result: Error - Path not in CODEBASE_INDEX_ALLOWED_ROOTS

Solution: Add path to agent config:
"CODEBASE_INDEX_ALLOWED_ROOTS": "D:/Repository/mcp-local,D:/Repository/new-repo"
```

---

For more examples and detailed documentation, see:
- [SKILL.md](./SKILL.md) - Comprehensive skill guide
- [QUICK_START.md](./QUICK_START.md) - Setup guide
- [MCP-FIRST-CHEATSHEET.md](./MCP-FIRST-CHEATSHEET.md) - Quick reference
