/**
 * Shared test fixtures and temp-workspace helpers for the test scripts.
 *
 * `bufferOverflowPad()` returns >32 KB of many short comment lines. It pushes a C# fixture past
 * node-tree-sitter's 32768-byte default buffer (exercising the bufferSize fix — MCP-ISSUE-030;
 * without it the parse throws "Invalid argument") WITHOUT tripping the indexer's minified-file
 * filter, which skips any file whose average line length exceeds 500 over the first 10 KB (a single
 * 40 KB-line comment would be flagged likely_minified and never indexed). ~700 short comment lines
 * (avg ~70 chars) clear both thresholds. Append the result inside a C# source template literal.
 */
export function bufferOverflowPad() {
  return "\n" + Array.from({ length: 700 }, (_, i) => `// pad ${i} ${"x".repeat(60)}`).join("\n") + "\n";
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Temp workspace helpers ────────────────────────────────────────────────────────────────
// Every temp dir created via these helpers is tracked and removed on process exit — INCLUDING
// when a test throws/fails before reaching its own cleanup. This stops the suite from
// accumulating stray *.db dirs in os.tmpdir() run after run.
//
// Tests that spawn the MCP server (dist/index.js) must ALSO pass an isolated DB path via
// CODEBASE_INDEX_DB_PATH (see makeTempDbPath), otherwise the server falls back to
// "./codebase-index.db" and bloats the shared project index with throwaway fixture repos.
const trackedTempDirs = new Set();
let exitHookInstalled = false;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Fires on normal exit AND on explicit process.exit(); best-effort so a still-locked DB
  // handle (e.g. a child server that hasn't fully died) never crashes the run.
  process.on("exit", () => {
    for (const dir of trackedTempDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
}

/** Create a tracked temp dir under os.tmpdir(); auto-removed on process exit. */
export function makeTempDir(prefix = "cbi-test-") {
  installExitHook();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackedTempDirs.add(dir);
  return dir;
}

/** A tracked temp dir plus an isolated DB path inside it (for GraphStore / CODEBASE_INDEX_DB_PATH). */
export function makeTempDbPath(prefix = "cbi-test-", dbName = "test.db") {
  return path.join(makeTempDir(prefix), dbName);
}
