import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AgentConfig {
  name: string;
  type: "claude-code" | "claude" | "opencode" | "vscode";
  configPath: string;
  detected: boolean;
}

export interface AgentDetectionResult {
  detected: AgentConfig[];
  recommendations: string[];
}

export function detectCodeAgents(): AgentDetectionResult {
  const homeDir = os.homedir();
  const appData = process.env.APPDATA || path.join(homeDir, "AppData", "Roaming");
  const detected: AgentConfig[] = [];
  const recommendations: string[] = [];

  // Claude Code (CLI) — ~/.claude.json is created on first run (reliable install indicator).
  // MCP servers live in ~/.claude/settings.json (created by setup if absent).
  const claudeCodeStatePath = path.join(homeDir, ".claude.json");
  const claudeCodeConfigPath = path.join(homeDir, ".claude", "settings.json");
  if (fs.existsSync(claudeCodeStatePath) || fs.existsSync(claudeCodeConfigPath)) {
    detected.push({ name: "Claude Code", type: "claude-code", configPath: claudeCodeConfigPath, detected: true });
  }

  // Claude Desktop
  const claudeDesktopPaths = [
    path.join(appData, "Claude", "claude_desktop_config.json"),                                   // Windows
    path.join(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json"), // macOS
    path.join(homeDir, ".config", "Claude", "claude_desktop_config.json"),                        // Linux
  ];
  for (const configPath of claudeDesktopPaths) {
    if (fs.existsSync(configPath)) {
      detected.push({ name: "Claude Desktop", type: "claude", configPath, detected: true });
      break;
    }
  }

  // VS Code — MCP is built-in since 1.99; detect by settings.json presence
  const vscodePaths = [
    path.join(appData, "Code", "User", "settings.json"),                                          // Windows
    path.join(homeDir, "Library", "Application Support", "Code", "User", "settings.json"),        // macOS
    path.join(homeDir, ".config", "Code", "User", "settings.json"),                               // Linux
  ];
  for (const configPath of vscodePaths) {
    if (fs.existsSync(configPath)) {
      detected.push({ name: "VS Code", type: "vscode", configPath, detected: true });
      break;
    }
  }

  // OpenCode
  const opencodePaths = [
    path.join(homeDir, ".config", "opencode", "opencode.json"),  // Linux/macOS/Windows (.config)
    path.join(homeDir, ".config", "opencode", "opencode.jsonc"), // JSONC variant
    path.join(appData, "opencode", "opencode.json"),             // Windows %APPDATA% fallback
  ];
  for (const configPath of opencodePaths) {
    if (fs.existsSync(configPath)) {
      detected.push({ name: "OpenCode", type: "opencode", configPath, detected: true });
      break;
    }
  }

  if (detected.length === 0) {
    recommendations.push("No code agents detected. Install Claude Code, Claude Desktop, VS Code, or OpenCode.");
  } else {
    recommendations.push(`Detected ${String(detected.length)} code agent(s): ${detected.map((a) => a.name).join(", ")}`);
    recommendations.push("Run npm run setup to auto-configure the MCP server for detected agents.");
  }

  return { detected, recommendations };
}

export function generateMcpConfig(
  agent: AgentConfig,
  serverPath: string,
  allowedRoots: string,
  dbPath: string
): Record<string, unknown> {
  const serverName = "codebase-index-local";

  const baseConfig = {
    command: "node",
    args: [serverPath],
    env: {
      CODEBASE_INDEX_ALLOWED_ROOTS: allowedRoots,
      CODEBASE_INDEX_DB_PATH: dbPath,
      CODEBASE_INDEX_DOCS_INDEXING_ENABLED: "false",
      CODEBASE_INDEX_DOCS_TOOLS_ENABLED: "false",
      CODEBASE_INDEX_TELEMETRY_ENABLED: "false",
      CODEBASE_INDEX_WATCH_AUTO_START: "false",
    },
  };

  switch (agent.type) {
    case "claude":
    case "claude-code":
      return { mcpServers: { [serverName]: baseConfig } };

    case "opencode":
      return {
        $schema: "https://opencode.ai/config.json",
        mcp: {
          [serverName]: {
            type: "local",
            command: [baseConfig.command, ...baseConfig.args],
            enabled: true,
            environment: baseConfig.env,
          },
        },
      };

    case "vscode":
      return { "mcp.servers": { [serverName]: baseConfig } };

    default: {
      const _exhaustive: never = agent.type;
      return { servers: { [serverName]: baseConfig } };
    }
  }
}

export function mergeAgentConfig(
  existingConfigPath: string,
  newMcpConfig: Record<string, unknown>
): void {
  let existingConfig: Record<string, unknown> = {};

  if (fs.existsSync(existingConfigPath)) {
    try {
      const content = fs.readFileSync(existingConfigPath, "utf-8");
      existingConfig = JSON.parse(content) as Record<string, unknown>;
    } catch (error) {
      console.warn(`Warning: Could not parse existing config at ${existingConfigPath}:`, error);
    }
  }

  const merged: Record<string, unknown> = { ...existingConfig };

  for (const [key, value] of Object.entries(newMcpConfig)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      merged[key] = { ...(merged[key] as Record<string, unknown> ?? {}), ...(value as Record<string, unknown>) };
    } else {
      merged[key] = value;
    }
  }

  const dir = path.dirname(existingConfigPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(existingConfigPath, JSON.stringify(merged, null, 2), "utf-8");
}
