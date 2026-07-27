/**
 * Tests profile behavior for refactor_replace_preview and refactor_replace_apply.
 * Verifies: nano omits groupedPreviewHunks, compact strips before/after text, standard has full content.
 * Also verifies: bytesOf(nano) <= bytesOf(compact) <= bytesOf(standard).
 *
 * Usage: node scripts/test/test-refactor-preview-profiles.mjs
 * Requires: npm run build first
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function readTextContent(result) {
  return Array.isArray(result?.content)
    ? (result.content.find((x) => x.type === "text")?.text ?? "<no text content>")
    : "<no text content>";
}

function readJson(result) {
  const text = readTextContent(result);
  try { return { text, json: JSON.parse(text) }; } catch { return { text, json: null }; }
}

function bytesOf(text) { return Buffer.byteLength(text, "utf8"); }

let passed = 0;
let failed = 0;

function assert(condition, label, details = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}${details ? ` — ${details}` : ""}`);
    failed++;
  }
}

async function runPreviewWithProfile(client, repoId, profile) {
  return client.callTool({
    name: "refactor_replace_preview",
    arguments: {
      repoId,
      find: "resolveResponseProfile",
      replaceExpression: "resolveResponseProfile",
      scope: { includePaths: ["src/handlers"] },
      guards: {},
      mode: "symbol-aware",
      profile
    }
  });
}

async function main() {
  const repoPath = process.cwd();
  const repoId = "refactor-profile-test-repo";

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env, CODEBASE_INDEX_ALLOWED_ROOTS: process.env.CODEBASE_INDEX_ALLOWED_ROOTS ?? repoPath },
    stderr: "pipe"
  });
  transport.onerror = (e) => console.error("[transport-error]", e);

  const client = new Client({ name: "refactor-profile-test", version: "0.1.0" });
  await client.connect(transport);

  // Index current directory
  console.log("\n[setup] Indexing current repo...");
  const indexResult = await client.callTool({
    name: "index_repository",
    arguments: { repoId, repoPath, mode: "full", maxFiles: 100 }
  }, undefined, { timeout: 60_000 });
  const indexJson = readJson(indexResult).json;
  if (!indexJson?.runId) throw new Error("Indexing failed — no runId returned");
  console.log(`  indexed: ${indexJson.filesIndexed} files`);

  // ── refactor_replace_preview profile tests ───────────────────────────────
  console.log("\n[refactor_replace_preview] profile tests");

  const nanoResult = await runPreviewWithProfile(client, repoId, "nano");
  const compactResult = await runPreviewWithProfile(client, repoId, "compact");
  const standardResult = await runPreviewWithProfile(client, repoId, "standard");

  const nanoJson = readJson(nanoResult).json;
  const compactJson = readJson(compactResult).json;
  const standardJson = readJson(standardResult).json;

  const nanoBytes = bytesOf(readTextContent(nanoResult));
  const compactBytes = bytesOf(readTextContent(compactResult));
  const standardBytes = bytesOf(readTextContent(standardResult));

  console.log(`  sizes: nano=${nanoBytes}, compact=${compactBytes}, standard=${standardBytes}`);

  assert(nanoBytes <= compactBytes, "nano <= compact bytes");
  assert(compactBytes <= standardBytes, "compact <= standard bytes");

  // nano: must have previewId + approvalToken + totalMatches + affectedFileCount
  assert(typeof nanoJson?.previewId === "string", "nano has previewId");
  assert(typeof nanoJson?.approvalToken === "string", "nano has approvalToken");
  assert(typeof nanoJson?.totalMatches === "number", "nano has totalMatches");
  assert(typeof nanoJson?.affectedFileCount === "number", "nano has affectedFileCount");
  assert(Array.isArray(nanoJson?.affectedFiles), "nano has affectedFiles");
  assert(!("groupedPreviewHunks" in (nanoJson ?? {})), "nano omits groupedPreviewHunks");
  assert(typeof nanoJson?.ambiguity?.blockedByPolicy === "boolean", "nano has ambiguity.blockedByPolicy");

  // compact: must have groupedPreviewHunks, hunks must lack beforeText/afterText
  assert(typeof compactJson?.previewId === "string", "compact has previewId");
  assert(Array.isArray(compactJson?.groupedPreviewHunks), "compact has groupedPreviewHunks");
  if (Array.isArray(compactJson?.groupedPreviewHunks) && compactJson.groupedPreviewHunks.length > 0) {
    const firstGroup = compactJson.groupedPreviewHunks[0];
    const firstHunk = firstGroup?.hunks?.[0];
    if (firstHunk) {
      assert(!("beforeText" in firstHunk), "compact hunk omits beforeText");
      assert(!("afterText" in firstHunk), "compact hunk omits afterText");
      assert("line" in firstHunk && "replacementText" in firstHunk, "compact hunk has line + replacementText");
    }
  }

  // standard: must have groupedPreviewHunks with beforeText/afterText
  assert(Array.isArray(standardJson?.groupedPreviewHunks), "standard has groupedPreviewHunks");
  if (Array.isArray(standardJson?.groupedPreviewHunks) && standardJson.groupedPreviewHunks.length > 0) {
    const firstGroup = standardJson.groupedPreviewHunks[0];
    const firstHunk = firstGroup?.hunks?.[0];
    if (firstHunk) {
      assert("beforeText" in firstHunk && "afterText" in firstHunk, "standard hunk has beforeText + afterText");
    }
  }

  // ── refactor_replace_apply profile tests ─────────────────────────────────
  // Only test nano/compact (safe — we're replacing a symbol with itself)
  // Skip if blocked by ambiguity (e.g., symbol appears in many symbol kinds across files)
  if (nanoJson?.previewId && nanoJson?.approvalToken && (nanoJson?.totalMatches ?? 0) > 0 && !nanoJson?.ambiguity?.blockedByPolicy) {
    console.log("\n[refactor_replace_apply] profile tests");

    // Get a fresh preview for apply (nano preview from above is the same previewId)
    const applyNano = await client.callTool({
      name: "refactor_replace_apply",
      arguments: { previewId: nanoJson.previewId, approvalToken: nanoJson.approvalToken, profile: "nano" }
    });
    const applyNanoJson = readJson(applyNano).json;

    assert(typeof applyNanoJson?.applyId === "string", "apply nano has applyId");
    assert(typeof applyNanoJson?.filesChanged === "number", "apply nano has filesChanged");
    assert(typeof applyNanoJson?.totalHunksApplied === "number", "apply nano has totalHunksApplied");
    assert(typeof applyNanoJson?.success === "boolean", "apply nano has success");
    assert(!("appliedFiles" in (applyNanoJson ?? {})), "apply nano omits appliedFiles array");
    assert(!("scopeCheck" in (applyNanoJson ?? {})) || !("expectedFiles" in (applyNanoJson?.scopeCheck ?? {})), "apply nano omits scopeCheck.expectedFiles");

    // Rollback immediately (we replaced with same value so it's a no-op, but test the rollback path)
    if (applyNanoJson?.rollbackId) {
      const rollback = await client.callTool({
        name: "refactor_replace_rollback",
        arguments: { rollbackId: applyNanoJson.rollbackId }
      });
      const rollbackJson = readJson(rollback).json;
      assert(typeof rollbackJson?.diagnostics?.code === "string" && rollbackJson.diagnostics.code.includes("ROLLBACK"), "rollback has diagnostics.code containing ROLLBACK");
      assert(typeof rollbackJson?.restoredFilesCount === "number", "rollback has restoredFilesCount");
    }
  } else {
    console.log("  [skip] refactor_replace_apply — no matches found (pattern not in this repo sample)");
  }

  // ── summary ───────────────────────────────────────────────────────────────
  console.log(`\n[results] ${passed} passed, ${failed} failed`);
  await client.close();
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error("[fatal]", err); process.exit(1); });
