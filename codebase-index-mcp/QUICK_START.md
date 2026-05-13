# Quick Start Guide - One-Command Setup

Get codebase-index-mcp running in minutes with automatic agent detection and configuration.

## Prerequisites

- Node.js 18+ installed
- One of the supported code agents:
  - Claude Desktop
  - VS Code (with Copilot)
  - OpenCode

## One-Command Setup

```bash
cd codebase-index-mcp
node scripts/setup.mjs
```

That's it! The setup script will:

1. ✅ Install npm dependencies
2. ✅ Build TypeScript project
3. ✅ Detect installed code agents
4. ✅ Auto-configure MCP server
5. ✅ Run smoke tests
6. ✅ Display next steps

## What Happens During Setup

### Step 1: Installing Dependencies

```
Installing npm dependencies...
✓ Dependencies installed
```

The script installs all required packages including:
- `@modelcontextprotocol/sdk` - MCP protocol
- `better-sqlite3` - Database
- `tree-sitter` - Code parsing
- Language parsers (JavaScript, TypeScript, C#)

### Step 2: Building Project

```
Running TypeScript build...
✓ Build completed

Running no-LLM runtime guard...
✓ No-LLM policy verified
```

Compiles TypeScript to JavaScript and verifies the no-LLM policy constraint.

### Step 3: Detecting Code Agents

```
✓ Found: Claude Desktop (C:\Users\...\Claude\claude_desktop_config.json)
✓ Found: VS Code (C:\Users\...\Code\User\settings.json)
✓ Found: OpenCode (C:\Users\...\.config\opencode\opencode.json)
```

Automatically detects installed agents by checking common configuration paths.

### Step 4: Configuring MCP Server

```
Enter allowed roots (comma-separated, or press Enter for default):
> D:\Repository\mcp-local

Enter database path (or press Enter for default):
> [Enter]

ℹ Configuring Claude Desktop...
ℹ Backup created: claude_desktop_config.json.backup.1715587200000
✓ Configured Claude Desktop

ℹ Configuring VS Code...
✓ Configured VS Code

ℹ Configuring OpenCode...
✓ Configured OpenCode
```

Prompts for configuration and updates agent config files with MCP server settings.

### Step 5: Running Smoke Test

```
Running integration smoke test...
✓ Smoke test passed
```

Validates the installation with basic integration tests.

### Step 6: Next Steps

```
═══════════════════════════════════════════════════════════
  Setup Complete!
═══════════════════════════════════════════════════════════

✓ Codebase Index MCP server is ready to use!

Next steps:

1. Restart your code agent(s):
   - Claude Desktop
   - VS Code
   - OpenCode

2. Verify MCP server is connected:
   - Check agent logs for 'codebase-index-local' server

3. Index your first repository:
   - Use tool: list_repositories
   - Use tool: index_repository

4. Start querying your codebase:
   - search_symbols: Find functions, classes, methods
   - get_call_chain: Trace function calls
   - find_impact_files: Analyze change impact
   - get_file_context: Get file structure and symbols
```

## Post-Setup Verification

### 1. Restart Your Code Agent

Close and reopen your code agent (Claude Desktop, Cursor, etc.)

### 2. Check MCP Connection

In your agent, ask:
```
What MCP tools are available?
```

You should see tools like:
- `list_repositories`
- `index_repository`
- `search_symbols`
- `get_call_chain`
- `find_impact_files`
- And 40+ more...

### 3. Index Your First Repository

```
Use tool: list_repositories
```

Output:
```json
{
  "repositories": [
    {
      "repoId": "mcp-local",
      "repoPath": "D:\\Repository\\mcp-local",
      "indexed": false
    }
  ]
}
```

Then index it:
```
Use tool: index_repository
Parameters:
  repoPath: "D:\\Repository\\mcp-local"
  mode: "incremental"
  docsMode: "off"
```

### 4. Test Basic Queries

```
Use tool: search_symbols
Parameters:
  repoId: "mcp-local"
  query: "GraphStore"
  strategy: "name"
  profile: "compact"
```

## Configuration Details

The setup script creates this configuration:

### Claude Desktop

File: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "codebase-index-local": {
      "command": "node",
      "args": ["D:/Repository/mcp-local/codebase-index-mcp/dist/index.js"],
      "env": {
        "CODEBASE_INDEX_ALLOWED_ROOTS": "D:/Repository/mcp-local",
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

### VS Code

File: `%APPDATA%\Code\User\settings.json`

```json
{
  "mcp.servers": {
    "codebase-index-local": {
      "command": "node",
      "args": ["D:/Repository/mcp-local/codebase-index-mcp/dist/index.js"],
      "env": {
        "CODEBASE_INDEX_ALLOWED_ROOTS": "D:/Repository/mcp-local",
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

### OpenCode

File: `~/.config/opencode/opencode.json` (or `opencode.jsonc`)

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

**Note:** OpenCode requires:
- `type: "local"` for local MCP servers
- `command` as an **array** (e.g., `["node", "path/to/server.js"]`)
- `enabled: true` to enable the server
- `environment` for env vars (not `env`)

## Customizing Configuration

### Adding More Repositories

Edit your agent's config file and update `CODEBASE_INDEX_ALLOWED_ROOTS`:

```json
{
  "CODEBASE_INDEX_ALLOWED_ROOTS": "D:/Repository/mcp-local,D:/Repository/other-repo,D:/Repository/third-repo"
}
```

### Changing Database Location

```json
{
  "CODEBASE_INDEX_DB_PATH": "D:/custom/path/my-index.db"
}
```

### Enabling Documentation Indexing

```json
{
  "CODEBASE_INDEX_DOCS_INDEXING_ENABLED": "true",
  "CODEBASE_INDEX_DOCS_TOOLS_ENABLED": "true"
}
```

### Adding Refactor Approval Secret

Generate a secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Add to config:
```json
{
  "CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET": "your-generated-secret-here"
}
```

## Troubleshooting

### Setup Script Fails

**Error: Node.js not found**
```
Solution: Install Node.js 18+ from nodejs.org
```

**Error: npm install failed**
```
Solution: 
- Check internet connection
- Clear npm cache: npm cache clean --force
- Delete node_modules and retry
```

**Error: Build failed**
```
Solution:
- Check TypeScript version: npm list typescript
- Run: npm run typecheck for detailed errors
```

### No Agents Detected

```
⚠ No code agents detected
```

**Solution:**
- Install a supported agent (Claude Desktop, Cursor, etc.)
- Run setup script again
- Or manually configure (see CONFIG_TEMPLATES.md)

### Agent Not Connecting to MCP Server

**Check 1: Agent logs**
- Look for "codebase-index-local" in logs
- Check for error messages

**Check 2: Verify paths**
- Ensure `dist/index.js` exists
- Check `CODEBASE_INDEX_ALLOWED_ROOTS` is correct

**Check 3: Restart agent**
- Completely close and reopen
- Some agents require full restart

### Path Not Allowed Error

```
Error: Path not in CODEBASE_INDEX_ALLOWED_ROOTS
```

**Solution:**
1. Edit agent config file
2. Add repository path to `CODEBASE_INDEX_ALLOWED_ROOTS`
3. Restart agent

### Database Lock Error

```
Error: database is locked
```

**Solution:**
- Close other agents using same database
- Use unique database path per agent
- Check file permissions

## Manual Setup (Alternative)

If automatic setup doesn't work, follow manual steps:

### 1. Install and Build

```bash
cd codebase-index-mcp
npm install
npm run build
npm run guard:no-llm-runtime
```

### 2. Find Agent Config

**Claude Desktop:**
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

**Cursor:**
- Windows: `%APPDATA%\Cursor\User\settings.json`
- macOS: `~/Library/Application Support/Cursor/User/settings.json`
- Linux: `~/.config/Cursor/User/settings.json`

### 3. Add MCP Server Config

See `CONFIG_TEMPLATES.md` for agent-specific templates.

### 4. Restart Agent

Close and reopen your code agent.

## Common Use Cases

### Single Repository Setup

```json
{
  "CODEBASE_INDEX_ALLOWED_ROOTS": "D:/Repository/my-project",
  "CODEBASE_INDEX_DB_PATH": "D:/Repository/my-project/.mcp-index.db"
}
```

### Multi-Repository Workspace

```json
{
  "CODEBASE_INDEX_ALLOWED_ROOTS": "D:/Repository/frontend,D:/Repository/backend,D:/Repository/shared",
  "CODEBASE_INDEX_DB_PATH": "D:/Repository/mcp-workspace-index.db"
}
```

### Cross-Platform (macOS/Linux)

```json
{
  "CODEBASE_INDEX_ALLOWED_ROOTS": "/Users/username/projects",
  "CODEBASE_INDEX_DB_PATH": "/Users/username/projects/mcp-index.db"
}
```

## Performance Tips

### For Large Repositories

Add to config:
```json
{
  "CODEBASE_INDEX_MAX_FILES_PER_RUN": "50000",
  "CODEBASE_INDEX_LARGE_REPO_PROFILE": "large"
}
```

### For Faster Queries

Use compact profile in queries:
```
Use tool: search_symbols
Parameters:
  profile: "compact"
```

### For Multiple Agents

Use separate database per agent to avoid locks:
```json
{
  "CODEBASE_INDEX_DB_PATH": "D:/Repository/mcp-index-claude.db"
}
```

## Next Steps

After setup is complete:

1. **Learn the tools** - Read `SKILL.md` for comprehensive guide
2. **Try examples** - See `MCP-FIRST-CHEATSHEET.md` for quick reference
3. **Explore workflows** - Check `README.md` for detailed documentation
4. **Review best practices** - See `AGENTS.md` for operational guidance

## Getting Help

- **Documentation**: `README.md`, `SKILL.md`, `CONFIG_TEMPLATES.md`
- **Quick Reference**: `MCP-FIRST-CHEATSHEET.md`
- **Known Issues**: `mcp-codebase-index-issue-registry.md`
- **Agent Guide**: `../AGENTS.md`

## Uninstall

To remove MCP server configuration:

1. **Backup config** (optional):
   ```bash
   cp config.json config.json.backup
   ```

2. **Edit agent config** and remove `codebase-index-local` section

3. **Delete database** (optional):
   ```bash
   rm mcp-codebase-index.db
   ```

4. **Restart agent**

## Re-running Setup

Safe to run multiple times:
```bash
node scripts/setup.mjs
```

The script will:
- Skip if dependencies already installed
- Rebuild project
- Detect agents again
- Update configurations (creates backups)

## Advanced Configuration

For advanced options, see:
- `CONFIG_TEMPLATES.md` - All environment variables
- `AGENTS.md` - Operational guidance
- `README.md` - Full documentation

## Success Checklist

- [ ] Setup script completed without errors
- [ ] Agent restarted
- [ ] MCP tools visible in agent
- [ ] `list_repositories` returns results
- [ ] `index_repository` completes successfully
- [ ] `search_symbols` finds symbols
- [ ] `health_check` shows indexed: true

If all checked, you're ready to use codebase-index-mcp! 🎉
