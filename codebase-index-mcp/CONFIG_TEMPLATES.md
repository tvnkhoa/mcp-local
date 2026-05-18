# Configuration Templates

Agent-specific MCP server configuration templates for codebase-index-mcp.

## Claude Desktop

**Location:**
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

**Configuration:**

```json
{
  "mcpServers": {
    "codebase-index-local": {
      "command": "node",
      "args": [
        "D:/Repository/mcp-local/codebase-index-mcp/dist/index.js"
      ],
      "env": {
        "CODEBASE_INDEX_ALLOWED_ROOTS": "D:/Repository/mcp-local,D:/Repository/other-repo",
        "CODEBASE_INDEX_DB_PATH": "D:/Repository/mcp-local/mcp-codebase-index.db",
        "CODEBASE_INDEX_DOCS_INDEXING_ENABLED": "false",
        "CODEBASE_INDEX_DOCS_TOOLS_ENABLED": "false",
        "CODEBASE_INDEX_TELEMETRY_ENABLED": "true",
        "CODEBASE_INDEX_WATCH_AUTO_START": "false",
        "CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET": "your-secret-key-here"
      }
    }
  }
}
```

## Cursor

**Location:**
- Windows: `%APPDATA%\Cursor\User\settings.json`
- macOS: `~/Library/Application Support/Cursor/User/settings.json`
- Linux: `~/.config/Cursor/User/settings.json`

**Configuration:**

```json
{
  "mcp.servers": {
    "codebase-index-local": {
      "command": "node",
      "args": [
        "D:/Repository/mcp-local/codebase-index-mcp/dist/index.js"
      ],
      "env": {
        "CODEBASE_INDEX_ALLOWED_ROOTS": "D:/Repository/mcp-local,D:/Repository/other-repo",
        "CODEBASE_INDEX_DB_PATH": "D:/Repository/mcp-local/mcp-codebase-index.db",
        "CODEBASE_INDEX_DOCS_INDEXING_ENABLED": "false",
        "CODEBASE_INDEX_DOCS_TOOLS_ENABLED": "false",
        "CODEBASE_INDEX_TELEMETRY_ENABLED": "true",
        "CODEBASE_INDEX_WATCH_AUTO_START": "false"
      }
    }
  }
}
```

## Windsurf (Codeium)

**Location:**
- Windows: `%APPDATA%\Windsurf\User\settings.json`
- macOS: `~/Library/Application Support/Windsurf/User/settings.json`
- Linux: `~/.config/Windsurf/User/settings.json`

**Configuration:**

```json
{
  "mcp.servers": {
    "codebase-index-local": {
      "command": "node",
      "args": [
        "D:/Repository/mcp-local/codebase-index-mcp/dist/index.js"
      ],
      "env": {
        "CODEBASE_INDEX_ALLOWED_ROOTS": "D:/Repository/mcp-local,D:/Repository/other-repo",
        "CODEBASE_INDEX_DB_PATH": "D:/Repository/mcp-local/mcp-codebase-index.db",
        "CODEBASE_INDEX_DOCS_INDEXING_ENABLED": "false",
        "CODEBASE_INDEX_DOCS_TOOLS_ENABLED": "false",
        "CODEBASE_INDEX_TELEMETRY_ENABLED": "true",
        "CODEBASE_INDEX_WATCH_AUTO_START": "false"
      }
    }
  }
}
```

## VS Code (with MCP Extension)

**Location:**
- Windows: `%APPDATA%\Code\User\settings.json`
- macOS: `~/Library/Application Support/Code/User/settings.json`
- Linux: `~/.config/Code/User/settings.json`

**Configuration:**

```json
{
  "mcp.servers": {
    "codebase-index-local": {
      "command": "node",
      "args": [
        "D:/Repository/mcp-local/codebase-index-mcp/dist/index.js"
      ],
      "env": {
        "CODEBASE_INDEX_ALLOWED_ROOTS": "D:/Repository/mcp-local,D:/Repository/other-repo",
        "CODEBASE_INDEX_DB_PATH": "D:/Repository/mcp-local/mcp-codebase-index.db",
        "CODEBASE_INDEX_DOCS_INDEXING_ENABLED": "false",
        "CODEBASE_INDEX_DOCS_TOOLS_ENABLED": "false",
        "CODEBASE_INDEX_TELEMETRY_ENABLED": "true",
        "CODEBASE_INDEX_WATCH_AUTO_START": "false"
      }
    }
  }
}
```

## Cline (VS Code Extension)

Cline uses VS Code's settings.json. Add the MCP server configuration to your VS Code settings (see above).

**Additional Cline-specific settings:**

```json
{
  "cline.mcpServers": {
    "codebase-index-local": {
      "command": "node",
      "args": [
        "D:/Repository/mcp-local/codebase-index-mcp/dist/index.js"
      ],
      "env": {
        "CODEBASE_INDEX_ALLOWED_ROOTS": "D:/Repository/mcp-local",
        "CODEBASE_INDEX_DB_PATH": "D:/Repository/mcp-local/mcp-codebase-index.db"
      }
    }
  }
}
```

## Roo-Cline (VS Code Extension)

Roo-Cline also uses VS Code's settings.json. Configuration is identical to Cline.

## OpenCode

**Location:**
- Global: `~/.config/opencode/opencode.json` (or `opencode.jsonc`)
- Project: `opencode.json` in project root

**Configuration:**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "codebase-index-local": {
      "type": "local",
      "command": ["node", "D:/Repository/mcp-local/codebase-index-mcp/dist/index.js"],
      "enabled": true,
      "environment": {
        "CODEBASE_INDEX_ALLOWED_ROOTS": "D:/Repository/mcp-local,D:/Repository/other-repo",
        "CODEBASE_INDEX_DB_PATH": "D:/Repository/mcp-local/mcp-codebase-index.db",
        "CODEBASE_INDEX_DOCS_INDEXING_ENABLED": "false",
        "CODEBASE_INDEX_DOCS_TOOLS_ENABLED": "false",
        "CODEBASE_INDEX_TELEMETRY_ENABLED": "true",
        "CODEBASE_INDEX_WATCH_AUTO_START": "false"
      }
    }
  }
}
```

**Notes:**
- OpenCode uses the `mcp` key (not `mcpServers`)
- **Required fields:** 
  - `type` - Must be `"local"` or `"remote"`
  - `command` - **Array** of command and arguments (e.g., `["node", "path/to/server.js"]`)
  - `enabled` - Boolean to enable/disable
  - `environment` - Object with environment variables (not `env`)
- Supports both JSON and JSONC (JSON with comments) formats
- Global config: `~/.config/opencode/opencode.json`
- Project config: `opencode.json` in project root
- Config files are merged (project overrides global)

**Using JSONC format:**

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  // MCP server configuration
  "mcp": {
    "codebase-index-local": {
      // Required: type must be "local" or "remote"
      "type": "local",
      // Required: command as array [command, ...args]
      "command": ["node", "D:/Repository/mcp-local/codebase-index-mcp/dist/index.js"],
      // Required: enable/disable the server
      "enabled": true,
      // Environment variables (note: "environment" not "env")
      "environment": {
        // Security: Only allow specific repository paths
        "CODEBASE_INDEX_ALLOWED_ROOTS": "D:/Repository/mcp-local",
        // Database location
        "CODEBASE_INDEX_DB_PATH": "D:/Repository/mcp-local/mcp-index.db",
        // Disable docs indexing for better performance
        "CODEBASE_INDEX_DOCS_INDEXING_ENABLED": "false",
        "CODEBASE_INDEX_DOCS_TOOLS_ENABLED": "false",
        // Enable telemetry for monitoring
        "CODEBASE_INDEX_TELEMETRY_ENABLED": "true",
        // Disable auto-watch (use manual watch_repo)
        "CODEBASE_INDEX_WATCH_AUTO_START": "false"
      }
    }
  }
}
```

## Environment Variables Reference

### Required

- `CODEBASE_INDEX_ALLOWED_ROOTS` - Comma-separated absolute paths for allowed repositories
  - Example: `"D:/Repository/mcp-local,D:/Repository/other-repo"`
  - Security: Only paths in this list can be indexed

### Recommended

- `CODEBASE_INDEX_DB_PATH` - SQLite database location
  - Default: `./codebase-index.db`
  - Recommendation: Use absolute path outside project directory

- `CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET` - HMAC secret for refactor tokens
  - Required for production use
  - Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

- `CODEBASE_INDEX_TELEMETRY_ENABLED` - Enable performance telemetry
  - Default: `false`
  - Recommendation: `true` for monitoring

### Optional (Common)

- `CODEBASE_INDEX_DOCS_INDEXING_ENABLED` - Index markdown/docs
  - Default: `false`
  - Set to `true` if you need docs search

- `CODEBASE_INDEX_DOCS_TOOLS_ENABLED` - Enable docs tools
  - Default: `false`
  - Set to `true` to use `query_docs`, `find_stale_docs`, etc.

- `CODEBASE_INDEX_WATCH_AUTO_START` - Auto-start file watchers
  - Default: `false`
  - Recommendation: Keep `false`, use `watch_repo` manually

- `CODEBASE_INDEX_MAX_FILES_PER_RUN` - Max files per index run
  - Default: `20000`
  - Increase for very large repositories

- `CODEBASE_INDEX_LARGE_REPO_PROFILE` - Performance profile
  - Options: `auto`, `standard`, `large`, `very-large`
  - Default: `auto`

### Optional (Advanced)

- `CODEBASE_INDEX_REFACTOR_STRICT_APPROVAL` - Require approval secret
  - Default: `false`
  - Set to `true` to enforce secret requirement

- `CODEBASE_INDEX_REFACTOR_PREVIEW_TTL_MS` - Preview token TTL
  - Default: `1800000` (30 minutes)

- `CODEBASE_INDEX_PARSE_WORKERS` - Worker thread count
  - Default: `cpus/2`

- `CODEBASE_INDEX_PARSE_JOB_TIMEOUT_MS` - Parse timeout per file
  - Default: `20000` (20 seconds)

## Path Configuration Examples

### Single Repository

```json
{
  "CODEBASE_INDEX_ALLOWED_ROOTS": "D:/Repository/my-project",
  "CODEBASE_INDEX_DB_PATH": "D:/Repository/my-project/.mcp-index.db"
}
```

### Multiple Repositories

```json
{
  "CODEBASE_INDEX_ALLOWED_ROOTS": "D:/Repository/frontend,D:/Repository/backend,D:/Repository/shared",
  "CODEBASE_INDEX_DB_PATH": "D:/Repository/mcp-shared-index.db"
}
```

### Workspace-Wide

```json
{
  "CODEBASE_INDEX_ALLOWED_ROOTS": "D:/Repository",
  "CODEBASE_INDEX_DB_PATH": "D:/Repository/mcp-workspace-index.db"
}
```

### Cross-Platform (macOS/Linux)

```json
{
  "CODEBASE_INDEX_ALLOWED_ROOTS": "/Users/username/projects/my-project,/Users/username/projects/other-project",
  "CODEBASE_INDEX_DB_PATH": "/Users/username/projects/mcp-index.db"
}
```

## Verification

After configuration, verify the setup:

1. **Restart your code agent**

2. **Check agent logs** for:
   ```
   [codebase-index-local] Server started
   [codebase-index-local] Allowed roots: ...
   ```

3. **Test MCP connection:**
   - Ask agent: "List available MCP tools"
   - Should see: `list_repositories`, `index_repository`, etc.

4. **Index a repository:**
   ```
   Use tool: list_repositories
   Use tool: index_repository with repoPath from list
   ```

5. **Verify indexing:**
   ```
   Use tool: health_check
   Should show: indexed: true, shouldReindex: false
   ```

## Troubleshooting

### Server Not Starting

- Check Node.js is installed: `node --version` (requires v18+)
- Verify dist/index.js exists: `npm run build`
- Check logs in agent console for error messages

### Path Not Allowed Error

```
Error: Path not in CODEBASE_INDEX_ALLOWED_ROOTS
```

**Solution:** Add the repository path to `CODEBASE_INDEX_ALLOWED_ROOTS`

### Database Lock Error

```
Error: database is locked
```

**Solution:** 
- Close other processes using the database
- Use unique `CODEBASE_INDEX_DB_PATH` per agent
- Check file permissions

### Missing Tools

If MCP tools don't appear:
- Verify MCP server is in correct config section (`mcpServers` vs `mcp.servers`)
- Check agent supports MCP protocol
- Restart agent after config changes

## Security Best Practices

1. **Limit Allowed Roots:**
   - Only include necessary repositories
   - Use specific paths, not entire drives

2. **Protect Approval Secret:**
   - Generate strong random secret
   - Don't commit to version control
   - Rotate periodically

3. **Database Location:**
   - Store outside web-accessible directories
   - Use appropriate file permissions
   - Regular backups recommended

4. **Review Refactor Previews:**
   - Always review before applying
   - Check risk flags
   - Test after applying

## Performance Tuning

### For Large Repositories (>10k files)

```json
{
  "CODEBASE_INDEX_MAX_FILES_PER_RUN": "50000",
  "CODEBASE_INDEX_LARGE_REPO_PROFILE": "large",
  "CODEBASE_INDEX_PARSE_WORKERS": "8",
  "CODEBASE_INDEX_PARSE_JOB_TIMEOUT_MS": "30000"
}
```

### For Fast Queries

```json
{
  "CODEBASE_INDEX_DOCS_INDEXING_ENABLED": "false",
  "CODEBASE_INDEX_DOCS_TOOLS_ENABLED": "false",
  "CODEBASE_INDEX_TELEMETRY_ENABLED": "true"
}
```

### For Multi-Repository Workspaces

```json
{
  "CODEBASE_INDEX_ALLOWED_ROOTS": "D:/Repository",
  "CODEBASE_INDEX_DB_PATH": "D:/Repository/mcp-central-index.db",
  "CODEBASE_INDEX_MAX_FILES_PER_RUN": "100000"
}
```

## Migration from Manual Setup

If you previously configured manually:

1. **Backup existing config:**
   ```bash
   cp config.json config.json.backup
   ```

2. **Run auto-setup:**
   ```bash
   node scripts/setup.mjs
   ```

3. **Merge custom settings:**
   - Compare backup with new config
   - Add any custom environment variables
   - Preserve custom paths

4. **Verify:**
   - Restart agent
   - Test MCP connection
   - Re-index if needed
