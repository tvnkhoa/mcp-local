#!/usr/bin/env node

/**
 * Thin wrapper kept for backward compatibility (`npm run setup`).
 *
 * The real installer now lives at the workspace root and is data-driven from
 * scripts/lib/manifest.mjs, so a single implementation serves every MCP server.
 * This wrapper just delegates to it, scoped to this server.
 *
 * Flags are forwarded (e.g. --yes / -y, --skip-smoke).
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "..", "..");
const INSTALLER = path.join(WORKSPACE_ROOT, "scripts", "install-mcp.mjs");

const forwarded = process.argv.slice(2);
const child = spawn(
  process.execPath,
  [INSTALLER, "--server", "codebase-index", ...forwarded],
  { stdio: "inherit", cwd: WORKSPACE_ROOT }
);
child.on("close", (code) => process.exit(code ?? 0));
child.on("error", (e) => { console.error(e); process.exit(1); });
