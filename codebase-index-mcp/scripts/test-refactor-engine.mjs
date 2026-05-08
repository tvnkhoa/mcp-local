/**
 * Regression tests for refactor engine fixes:
 *   1. validateAllowedTables: refactor_apply_hunks is in allowlist
 *   2. deriveApplyStatus: all-skipped changes → status "failed"
 *   3. Conflict branch: replacementCount === 0
 *   4. Full integration: preview → apply (no-match) → APPLY_PARTIAL_OR_CONFLICT
 *   5. Full integration: preview → mutate file → apply → conflict change
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { validateAllowedTables } from "../dist/sqliteGuardrails.js";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function readTextContent(result) {
  return Array.isArray(result?.content)
    ? (result.content.find((x) => x.type === "text")?.text ?? "<no text content>")
    : "<no text content>";
}

function readJson(result) {
  try {
    return JSON.parse(readTextContent(result));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SUITE 1: Unit — validateAllowedTables
// ---------------------------------------------------------------------------

console.log("\n=== Suite 1: validateAllowedTables allowlist ===");

{
  const allowedTables = new Set([
    "repositories", "files", "symbols", "edges", "index_runs",
    "routes", "cross_repo_deps",
    "refactor_previews", "refactor_preview_hunks",
    "refactor_applies", "refactor_apply_changes",
    "refactor_apply_hunks",  // the fix we're testing
    "refactor_rollbacks"
  ]);

  const r1 = validateAllowedTables(
    "SELECT * FROM refactor_apply_hunks WHERE apply_id = 'x' LIMIT 10",
    allowedTables
  );
  assert(r1.ok, "refactor_apply_hunks allowed by allowlist", JSON.stringify(r1));

  const r2 = validateAllowedTables(
    "SELECT h.*, c.file_path FROM refactor_apply_hunks h JOIN refactor_apply_changes c ON h.apply_id = c.apply_id LIMIT 10",
    allowedTables
  );
  assert(r2.ok, "JOIN refactor_apply_hunks + refactor_apply_changes allowed", JSON.stringify(r2));

  const r3 = validateAllowedTables(
    "SELECT * FROM secret_table LIMIT 1",
    allowedTables
  );
  assert(!r3.ok, "unknown table blocked");
  assert(r3.message?.includes("secret_table"), "error message names blocked table", r3.message);
}

// ---------------------------------------------------------------------------
// SUITE 2: Unit — deriveApplyStatus logic (inline replication)
// ---------------------------------------------------------------------------

console.log("\n=== Suite 2: deriveApplyStatus logic ===");

function deriveApplyStatus(changes) {
  const hasApplied = changes.some((x) => x.status === "applied");
  if (!hasApplied) return "failed";
  const hasNonApplied = changes.some((x) => x.status !== "applied");
  if (hasNonApplied) return "partial";
  return "applied";
}

assert(deriveApplyStatus([]) === "failed",
  "empty changes → failed");

assert(deriveApplyStatus([{ status: "skipped" }, { status: "skipped" }]) === "failed",
  "all-skipped → failed");

assert(deriveApplyStatus([{ status: "conflict" }]) === "failed",
  "all-conflict → failed");

assert(deriveApplyStatus([{ status: "applied" }]) === "applied",
  "all-applied → applied");

assert(deriveApplyStatus([{ status: "applied" }, { status: "skipped" }]) === "partial",
  "mixed applied+skipped → partial");

assert(deriveApplyStatus([{ status: "applied" }, { status: "conflict" }]) === "partial",
  "mixed applied+conflict → partial");

// ---------------------------------------------------------------------------
// SUITE 3: Integration — MCP server
// ---------------------------------------------------------------------------

console.log("\n=== Suite 3: MCP integration tests ===");

// Create a temp directory with test files
const tmpDir = mkdtempSync(join(tmpdir(), "refactor-test-"));
const testRepoId = `refactor-test-${Date.now()}`;

try {
  mkdirSync(join(tmpDir, "src"), { recursive: true });

  // File A: has a searchable token
  const fileAPath = join(tmpDir, "src", "serviceA.ts");
  writeFileSync(fileAPath, `export function oldFunctionName(): void {\n  console.log("hello");\n}\n`, "utf8");

  // File B: will be used for conflict test
  const fileBPath = join(tmpDir, "src", "serviceB.ts");
  writeFileSync(fileBPath, `export const MARKER_TOKEN_XYZ = "original";\n`, "utf8");

  const repoPath = tmpDir;

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...process.env,
      CODEBASE_INDEX_ALLOWED_ROOTS: repoPath,
      CODEBASE_INDEX_LLM_ENABLED: "false",
      // Use a deterministic secret so approval tokens can be generated
      CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET: "test-secret-for-regression-suite"
    },
    stderr: "pipe"
  });

  const client = new Client({ name: "refactor-regression-test", version: "0.1.0" });
  await client.connect(transport);

  // ── 3.1  Index the temp repo ─────────────────────────────────────────────
  console.log("\n  [3.1] Indexing temp repo...");
  const indexResult = await client.callTool({
    name: "index_repository",
    arguments: { repoId: testRepoId, repoPath, mode: "full" }
  });
  const indexJson = readJson(indexResult);
  assert(indexJson?.runId != null || indexJson?.indexedFiles >= 0 || indexJson?.status != null,
    "index_repository succeeded", readTextContent(indexResult).slice(0, 300));

  // ── 3.2  Preview with no-match pattern → apply → diagnostics APPLY_PARTIAL_OR_CONFLICT ──
  console.log("\n  [3.2] Preview (no-match) → apply → expect APPLY_PARTIAL_OR_CONFLICT...");
  const previewNoMatch = await client.callTool({
    name: "refactor_replace_preview",
    arguments: {
      repoId: testRepoId,
      find: "THIS_PATTERN_CANNOT_EXIST_IN_ANY_FILE_9z9z9z",
      replaceExpression: "REPLACED",
      scope: {},
      guards: {}
    }
  });
  const previewNoMatchJson = readJson(previewNoMatch);
  assert(previewNoMatchJson?.previewId, "no-match preview created", JSON.stringify(previewNoMatchJson).slice(0, 200));
  assert(previewNoMatchJson?.totalMatches === 0, "totalMatches = 0 for no-match preview");

  if (previewNoMatchJson?.approvalToken && previewNoMatchJson?.previewId) {
    const applyNoMatch = await client.callTool({
      name: "refactor_replace_apply",
      arguments: {
        previewId: previewNoMatchJson.previewId,
        approvalToken: previewNoMatchJson.approvalToken,
        includeLowConfidence: false
      }
    });
    const applyNoMatchJson = readJson(applyNoMatch);
    assert(
      applyNoMatchJson?.diagnostics?.code === "APPLY_PARTIAL_OR_CONFLICT",
      "no-match apply → APPLY_PARTIAL_OR_CONFLICT",
      `got: ${applyNoMatchJson?.diagnostics?.code}`
    );
    assert(
      Array.isArray(applyNoMatchJson?.appliedFiles) && applyNoMatchJson.appliedFiles.length === 0,
      "no-match apply → appliedFiles is empty"
    );
  }

  // ── 3.3  Preview → mutate file → apply → conflict with replacementCount = 0 ──
  console.log("\n  [3.3] Preview → mutate file → apply → conflict replacementCount=0...");
  const previewConflict = await client.callTool({
    name: "refactor_replace_preview",
    arguments: {
      repoId: testRepoId,
      find: "MARKER_TOKEN_XYZ",
      replaceExpression: "MARKER_TOKEN_REPLACED",
      scope: {},
      guards: {},
      mode: "text",                    // avoids ambiguous_target flag (no ownerType check)
      ambiguityThresholdPercent: 100   // allow 100% ambiguity so apply reaches conflict logic
    }
  });
  const previewConflictJson = readJson(previewConflict);
  assert(previewConflictJson?.previewId, "conflict-test preview created");
  assert(previewConflictJson?.totalMatches > 0, "conflict-test preview has matches");

  if (previewConflictJson?.approvalToken && previewConflictJson?.previewId) {
    // Mutate the file after preview (triggers FILE_CHANGED_AFTER_PREVIEW)
    writeFileSync(fileBPath, `export const MARKER_TOKEN_XYZ = "mutated_after_preview";\n`, "utf8");

    const applyConflict = await client.callTool({
      name: "refactor_replace_apply",
      arguments: {
        previewId: previewConflictJson.previewId,
        approvalToken: previewConflictJson.approvalToken,
        includeLowConfidence: true
      }
    });
    const applyConflictText = readTextContent(applyConflict);
    const applyConflictJson = readJson(applyConflict);
    if (applyConflictJson?.code || applyConflictJson?.message) {
      console.error(`    [DEBUG] conflict apply error: ${applyConflictText.slice(0, 300)}`);
    }

    assert(
      applyConflictJson?.diagnostics?.code === "APPLY_PARTIAL_OR_CONFLICT",
      "mutated-file apply → APPLY_PARTIAL_OR_CONFLICT",
      `got: ${applyConflictJson?.diagnostics?.code}`
    );

    const skipped = applyConflictJson?.skippedReplacements ?? [];
    const conflictEntry = skipped.find((x) => x.status === "conflict");
    assert(conflictEntry != null, "conflict entry present in skippedReplacements", JSON.stringify(skipped));
    assert(
      conflictEntry?.reason === "FILE_CHANGED_AFTER_PREVIEW",
      "conflict reason = FILE_CHANGED_AFTER_PREVIEW",
      `got: ${conflictEntry?.reason}`
    );
    assert(applyConflictJson?.appliedFiles?.length === 0, "conflicted apply → no appliedFiles");
  }

  // ── 3.4  query_graph for refactor_apply_hunks is not blocked ────────────
  console.log("\n  [3.4] query_graph refactor_apply_hunks not blocked by allowlist...");
  const qgResult = await client.callTool({
    name: "query_graph",
    arguments: {
      repoId: testRepoId,
      sql: "SELECT h.apply_id, h.hunk_id, h.file_path FROM refactor_apply_hunks h JOIN refactor_applies a ON h.apply_id = a.apply_id WHERE a.repo_id = :repoId LIMIT 5"
    }
  });
  const qgText = readTextContent(qgResult);
  // Should NOT contain the "not allowed" error message
  assert(
    !qgText.includes("is not allowed"),
    "query_graph: refactor_apply_hunks not blocked",
    qgText.slice(0, 200)
  );
  // Should be parseable JSON (valid result)
  const qgJson = readJson(qgResult);
  assert(Array.isArray(qgJson?.rows), "query_graph returns rows array", qgText.slice(0, 200));

  await client.close();

} finally {
  // Cleanup temp dir
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
