/**
 * Regression tests for refactor engine fixes:
 *   1. validateAllowedTables: refactor_apply_hunks is in allowlist
 *   2. deriveApplyStatus: all-skipped changes → status "failed"
 *   3. Conflict branch: replacementCount === 0
 *   4. Full integration: preview → apply (no-match) → APPLY_PARTIAL_OR_CONFLICT
 *   5. Full integration: preview → mutate file → apply → conflict change
 *   6. C# object initializer owned-state rewrite is previewed and applied by symbol migration
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { validateAllowedTables } from "../dist/sqliteGuardrails.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

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

    // File C: C# object initializer that should be rewritten into owned-state assignment
    const fileCPath = join(tmpDir, "src", "ConversationFixture.cs");
    writeFileSync(
    fileCPath,
    `public class Conversation {}
  public class ConversationIdentityState {}
  public sealed class Fixture
  {
    public void Seed()
    {
      var conversation = new Conversation
      {
        CrmCustomerId = 1,
        TenantId = 101
      };
    }
  }
  `,
    "utf8"
    );

  // File D: dotted target migration without initializerRewrite should be blocked in object initializer context
  const fileDPath = join(tmpDir, "src", "ConversationFixtureNoRewrite.cs");
  writeFileSync(
    fileDPath,
    `public class Conversation {}
public sealed class FixtureNoRewrite
{
    public void Seed()
    {
        var conversation = new Conversation
        {
            CrmCampaignId = 9,
            TenantId = 101
        };
    }
}
`,
    "utf8"
  );

  // File E: capture-group / named-group / guard cases for MCP-ISSUE-029
  const fileEPath = join(tmpDir, "src", "HandledByAssertions.cs");
  const fileEOriginal = `public class HandledByAssertions
{
    public void Check()
    {
        Assert.Equal("ai", conv.AssignmentState.HandledBy);
        Assert.Equal("human", result.Conversation.AssignmentState.HandledBy);
        Assert.Equal("guard", probe.HandledBy);
    }
}
`;
  writeFileSync(fileEPath, fileEOriginal, "utf8");

  // File F: optional capture group that does not participate — must substitute empty, NOT be blocked.
  const fileFPath = join(tmpDir, "src", "OptionalGroup.cs");
  const fileFOriginal = `public class OptionalGroup
{
    public void Check()
    {
        Assert.Equal("opt", probe.HandledBy);
    }
}
`;
  writeFileSync(fileFPath, fileFOriginal, "utf8");

  // File G: two overlapping previews → serialized applies → concurrent-apply diagnostic (PR2)
  const fileGPath = join(tmpDir, "src", "ConcurrentTarget.ts");
  writeFileSync(fileGPath, `export const LABEL = "MARKER_ONE";\n`, "utf8");

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
  // Drain the server's stderr. With stderr:"pipe" and no reader, a chatty server (index logs,
  // progress bars) fills the ~64KB OS pipe buffer; its next synchronous console.error then blocks
  // the server event loop and every request times out. Consuming the pipe keeps the server alive.
  transport.stderr?.resume();

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

  // ── 3.5  symbol migration rewrites C# object initializer members into owned-state assignment ──
  console.log("\n  [3.5] symbol migration rewrites object initializer members...");
  const migrationDryRun = await client.callTool({
    name: "refactor_symbol_migration",
    arguments: {
      repoId: testRepoId,
      migrations: [
        {
          fromSymbol: "CrmCustomerId",
          toSymbol: "IdentityState.CrmCustomerId",
          requiredOwnerType: "Conversation",
          forbiddenOwnerTypes: [],
          initializerRewrite: {
            objectProperty: "IdentityState",
            objectType: "ConversationIdentityState"
          }
        }
      ],
      scopePaths: ["src"],
      dryRun: true
    }
  });
  const migrationDryRunText = readTextContent(migrationDryRun);
  const migrationDryRunJson = readJson(migrationDryRun);
  assert(
    migrationDryRunJson?.migrationMap?.[0]?.totalMatches > 0,
    "object initializer dry-run finds owned-state rewrite match",
    migrationDryRunText.slice(0, 300)
  );
  assert(
    migrationDryRunJson?.migrationMap?.[0]?.previewSummary?.some((fileGroup) =>
      Array.isArray(fileGroup?.hunks)
      && fileGroup.hunks.some((hunk) => hunk?.afterText?.includes("IdentityState = new ConversationIdentityState"))
    ),
    "dry-run preview exposes owned-state replacement text",
    JSON.stringify(migrationDryRunJson?.migrationMap?.[0] ?? null).slice(0, 300)
  );

  const migrationApply = await client.callTool({
    name: "refactor_symbol_migration",
    arguments: {
      repoId: testRepoId,
      migrations: [
        {
          fromSymbol: "CrmCustomerId",
          toSymbol: "IdentityState.CrmCustomerId",
          requiredOwnerType: "Conversation",
          forbiddenOwnerTypes: [],
          initializerRewrite: {
            objectProperty: "IdentityState",
            objectType: "ConversationIdentityState"
          }
        }
      ],
      scopePaths: ["src"],
      dryRun: false
    }
  });
  const migrationApplyText = readTextContent(migrationApply);
  const migrationApplyJson = readJson(migrationApply);
  assert(
    migrationApplyJson?.migrationMap?.[0]?.applyId != null,
    "object initializer migration apply creates apply record",
    migrationApplyText.slice(0, 300)
  );

  const fileCAfter = await import("fs").then(({ readFileSync }) => readFileSync(fileCPath, "utf8"));
  assert(
    fileCAfter.includes("IdentityState = new ConversationIdentityState { CrmCustomerId = 1 },"),
    "apply rewrites flat initializer member to owned-state initializer",
    fileCAfter
  );
  assert(
    !/^\s*CrmCustomerId\s*=\s*1\s*,\s*$/m.test(fileCAfter),
    "apply removes legacy top-level initializer assignment",
    fileCAfter
  );

  // ── 3.6  dotted toSymbol without initializerRewrite is blocked for C# object initializer ──
  console.log("\n  [3.6] dotted toSymbol without initializerRewrite is blocked...");
  const blockedDryRun = await client.callTool({
    name: "refactor_symbol_migration",
    arguments: {
      repoId: testRepoId,
      migrations: [
        {
          fromSymbol: "CrmCampaignId",
          toSymbol: "DispatchContext.CrmCampaignId",
          requiredOwnerType: "Conversation",
          forbiddenOwnerTypes: []
        }
      ],
      scopePaths: ["src"],
      dryRun: true
    }
  });
  const blockedDryRunJson = readJson(blockedDryRun);
  const blockedHunks = blockedDryRunJson?.migrationMap?.[0]?.previewSummary?.flatMap((f) => f?.hunks ?? []) ?? [];
  assert(
    blockedHunks.some((h) => Array.isArray(h?.riskFlags) && h.riskFlags.includes("ambiguous_target")),
    "dotted migration without initializerRewrite is blocked as ambiguous",
    JSON.stringify(blockedDryRunJson?.migrationMap?.[0] ?? null).slice(0, 300)
  );

  const blockedApply = await client.callTool({
    name: "refactor_symbol_migration",
    arguments: {
      repoId: testRepoId,
      migrations: [
        {
          fromSymbol: "CrmCampaignId",
          toSymbol: "DispatchContext.CrmCampaignId",
          requiredOwnerType: "Conversation",
          forbiddenOwnerTypes: []
        }
      ],
      scopePaths: ["src"],
      dryRun: false
    }
  });
  const blockedApplyJson = readJson(blockedApply);
  assert(
    blockedApplyJson?.migrationMap?.[0]?.applyId != null,
    "blocked migration still records apply attempt",
    JSON.stringify(blockedApplyJson?.migrationMap?.[0] ?? null).slice(0, 300)
  );
  const fileDAfter = await import("fs").then(({ readFileSync }) => readFileSync(fileDPath, "utf8"));
  assert(
    !fileDAfter.includes("DispatchContext.CrmCampaignId ="),
    "blocked migration does not emit dotted initializer member assignment",
    fileDAfter
  );
  assert(
    /^\s*CrmCampaignId\s*=\s*9\s*,\s*$/m.test(fileDAfter),
    "blocked migration keeps original initializer member",
    fileDAfter
  );

  // ── 3.7  initializerRewrite metadata with dotted targetMember is rejected ──
  console.log("\n  [3.7] invalid initializerRewrite targetMember is rejected...");
  const invalidRewrite = await client.callTool({
    name: "refactor_symbol_migration",
    arguments: {
      repoId: testRepoId,
      migrations: [
        {
          fromSymbol: "CrmCampaignId",
          toSymbol: "DispatchContext.CrmCampaignId",
          requiredOwnerType: "Conversation",
          forbiddenOwnerTypes: [],
          initializerRewrite: {
            objectProperty: "DispatchContext",
            objectType: "DispatchContextState",
            targetMember: "DispatchContext.CrmCampaignId"
          }
        }
      ],
      scopePaths: ["src"],
      dryRun: true
    }
  });
  const invalidRewriteJson = readJson(invalidRewrite);
  assert(
    invalidRewriteJson?.code === "INVALID_INITIALIZER_REWRITE",
    "invalid dotted targetMember is rejected by policy",
    JSON.stringify(invalidRewriteJson ?? null).slice(0, 300)
  );

  // ── 3.8  compilerAssist narrows preview hunks to compile-failing lines ──
  console.log("\n  [3.8] compilerAssist narrows preview to diagnostic lines...");
  const compilerAssistPreview = await client.callTool({
    name: "refactor_replace_preview",
    arguments: {
      repoId: testRepoId,
      find: "Crm",
      replaceExpression: "Crm",
      scope: { includePaths: ["src"] },
      guards: { language: "csharp" },
      compilerAssist: {
        diagnostics: [
          {
            code: "CS0029",
            filePath: "src/ConversationFixture.cs",
            line: 9,
            message: "Cannot implicitly convert type"
          }
        ],
        codes: ["CS0029", "CS1503"],
        lineWindow: 0
      }
    }
  });
  const compilerAssistJson = readJson(compilerAssistPreview);
  const compilerAssistGroups = compilerAssistJson?.groupedPreviewHunks ?? [];
  const compilerAssistHunks = compilerAssistGroups.flatMap((g) => g?.hunks ?? []);
  assert(
    compilerAssistJson?.compilerAssist?.enabled === true,
    "compilerAssist mode is enabled in preview response",
    JSON.stringify(compilerAssistJson?.compilerAssist ?? null).slice(0, 300)
  );
  assert(
    compilerAssistHunks.length > 0,
    "compilerAssist returns at least one narrowed hunk",
    JSON.stringify(compilerAssistJson ?? null).slice(0, 300)
  );
  assert(
    compilerAssistGroups.length === 1
      && compilerAssistGroups[0]?.filePath === "src/ConversationFixture.cs"
      && compilerAssistHunks.every((h) => h?.line === 9),
    "compilerAssist keeps only diagnostic-matching file/line hunks",
    JSON.stringify(compilerAssistGroups).slice(0, 300)
  );

  // ── 3.9  compilerAssist accepts absolute diagnostic file paths ──
  console.log("\n  [3.9] compilerAssist supports absolute diagnostic file paths...");
  const compilerAssistAbsolutePath = await client.callTool({
    name: "refactor_replace_preview",
    arguments: {
      repoId: testRepoId,
      find: "Crm",
      replaceExpression: "Crm",
      scope: { includePaths: ["src"] },
      guards: { language: "csharp" },
      compilerAssist: {
        diagnostics: [
          {
            code: "CS0029",
            filePath: resolve(tmpDir, "src", "ConversationFixture.cs"),
            line: 9
          }
        ],
        codes: ["CS0029"],
        lineWindow: 0,
        filePathPrefix: "src"
      }
    }
  });
  const compilerAssistAbsolutePathJson = readJson(compilerAssistAbsolutePath);
  const absoluteGroups = compilerAssistAbsolutePathJson?.groupedPreviewHunks ?? [];
  const absoluteHunks = absoluteGroups.flatMap((g) => g?.hunks ?? []);
  assert(
    absoluteGroups.length === 1
      && absoluteGroups[0]?.filePath === "src/ConversationFixture.cs"
      && absoluteHunks.every((h) => h?.line === 9),
    "absolute diagnostic path narrows preview correctly",
    JSON.stringify(absoluteGroups).slice(0, 300)
  );

  // ── 3.10 compilerAssist no-match does not fall back to full preview ──
  console.log("\n  [3.10] compilerAssist no-match stays narrowed (no broad fallback)...");
  const compilerAssistNoMatch = await client.callTool({
    name: "refactor_replace_preview",
    arguments: {
      repoId: testRepoId,
      find: "Crm",
      replaceExpression: "Crm",
      scope: { includePaths: ["src"] },
      guards: { language: "csharp" },
      compilerAssist: {
        diagnostics: [
          {
            code: "CS0029",
            filePath: "src/ConversationFixture.cs",
            line: 999
          }
        ],
        codes: ["CS0029"],
        lineWindow: 0
      }
    }
  });
  const compilerAssistNoMatchJson = readJson(compilerAssistNoMatch);
  assert(
    compilerAssistNoMatchJson?.totalMatches === 0,
    "no diagnostic match returns zero hunks (no full-preview fallback)",
    JSON.stringify(compilerAssistNoMatchJson ?? null).slice(0, 300)
  );
  assert(
    compilerAssistNoMatchJson?.diagnostics?.code === "PREVIEW_NO_DIAGNOSTIC_MATCH",
    "no diagnostic match emits PREVIEW_NO_DIAGNOSTIC_MATCH",
    JSON.stringify(compilerAssistNoMatchJson?.diagnostics ?? null).slice(0, 300)
  );

  // ── 3.11 regex findMode with capture-group substitution ──
  console.log("\n  [3.11] regex findMode substitutes capture groups...");
  const regexPreview = await client.callTool({
    name: "refactor_replace_preview",
    arguments: {
      repoId: testRepoId,
      find: "old(\\w+)Name",
      replaceExpression: "renamed$1",
      findMode: "regex",
      scope: { includePaths: ["src"] },
      guards: {},
      mode: "text",
      ambiguityThresholdPercent: 100
    }
  });
  const regexPreviewJson = readJson(regexPreview);
  assert(regexPreviewJson?.totalMatches > 0, "regex preview finds matches", JSON.stringify(regexPreviewJson ?? null).slice(0, 200));
  const regexHunks = (regexPreviewJson?.groupedPreviewHunks ?? []).flatMap((g) => g.hunks ?? []);
  assert(
    regexHunks.some((h) => (h.afterText ?? "").includes("renamedFunction")),
    "regex capture-group substitution → renamedFunction",
    JSON.stringify(regexHunks).slice(0, 300)
  );

  const badRegex = await client.callTool({
    name: "refactor_replace_preview",
    arguments: { repoId: testRepoId, find: "ab(c", replaceExpression: "x", findMode: "regex", scope: {}, guards: {} }
  });
  assert(readTextContent(badRegex).includes("invalid regex"), "invalid regex pattern → clean error", readTextContent(badRegex).slice(0, 200));

  // ── 3.12 rename_assist emitPreview → apply → rollback (executable rename) ──
  console.log("\n  [3.12] rename_assist emitPreview executable round-trip...");
  const symSearch = await client.callTool({
    name: "search_symbols",
    arguments: { repoId: testRepoId, query: "oldFunctionName", ranked: true, limit: 1 }
  });
  const symId = readJson(symSearch)?.candidates?.[0]?.symbolId;
  assert(symId, "resolved symbolId for rename target", readTextContent(symSearch).slice(0, 200));

  if (symId) {
    const renamePreview = await client.callTool({
      name: "rename_assist",
      arguments: { repoId: testRepoId, symbolId: symId, newName: "freshFunctionName", emitPreview: true, profile: "standard" }
    });
    const renamePreviewJson = readJson(renamePreview);
    assert(
      renamePreviewJson?.previewId && renamePreviewJson?.approvalToken,
      "rename emitPreview returns an applyable preview",
      JSON.stringify(renamePreviewJson ?? null).slice(0, 200)
    );
    assert(renamePreviewJson?.totalMatches > 0, "rename preview matches the identifier");

    if (renamePreviewJson?.previewId && renamePreviewJson?.approvalToken) {
      const renameApply = await client.callTool({
        name: "refactor_replace_apply",
        // top-level identifiers have no enclosing owner type → confidence < 0.8, so opt in to low-confidence
        arguments: { previewId: renamePreviewJson.previewId, approvalToken: renamePreviewJson.approvalToken, includeLowConfidence: true }
      });
      const renameApplyJson = readJson(renameApply);
      const afterApply = readFileSync(fileAPath, "utf8");
      assert(afterApply.includes("freshFunctionName"), "rename apply rewrote the identifier on disk", afterApply.slice(0, 120));

      if (renameApplyJson?.rollbackId) {
        await client.callTool({ name: "refactor_replace_rollback", arguments: { rollbackId: renameApplyJson.rollbackId } });
        const afterRollback = readFileSync(fileAPath, "utf8");
        assert(afterRollback.includes("oldFunctionName"), "rollback restored the original identifier");
      }
    }
  }

  // ── 3.13 regex capture-group apply substitutes $1 on disk (MCP-ISSUE-029) ──
  console.log("\n  [3.13] regex capture-group apply substitutes $1 on disk (MCP-ISSUE-029)...");
  const cgPreview = await client.callTool({
    name: "refactor_replace_preview",
    arguments: {
      repoId: testRepoId,
      find: 'Equal\\("ai", ([^)]+\\.AssignmentState\\.HandledBy)\\)',
      replaceExpression: "Equal(ConversationHandledByValues.Ai, $1)",
      findMode: "regex",
      profile: "compact",
      scope: { includePaths: ["src"] },
      guards: {},
      mode: "text",
      ambiguityThresholdPercent: 100
    }
  });
  const cgPreviewJson = readJson(cgPreview);
  const cgHunks = (cgPreviewJson?.groupedPreviewHunks ?? []).flatMap((g) => g.hunks ?? []);
  assert(cgPreviewJson?.totalMatches > 0, "capture-group preview finds matches", JSON.stringify(cgPreviewJson ?? null).slice(0, 200));
  assert(
    cgHunks.some((h) => (h.replacementText ?? "").includes("conv.AssignmentState.HandledBy")) && cgHunks.every((h) => !(h.replacementText ?? "").includes("$1")),
    "preview replacementText has $1 expanded, not literal",
    JSON.stringify(cgHunks).slice(0, 300)
  );
  if (cgPreviewJson?.previewId && cgPreviewJson?.approvalToken) {
    const cgApply = await client.callTool({
      name: "refactor_replace_apply",
      arguments: { previewId: cgPreviewJson.previewId, approvalToken: cgPreviewJson.approvalToken, includeLowConfidence: true }
    });
    const cgApplyJson = readJson(cgApply);
    const fileEAfter = readFileSync(fileEPath, "utf8");
    assert(
      fileEAfter.includes("Assert.Equal(ConversationHandledByValues.Ai, conv.AssignmentState.HandledBy);"),
      "apply wrote substituted capture group to disk",
      fileEAfter
    );
    assert(!fileEAfter.includes("$1"), "apply did NOT write literal $1 to disk", fileEAfter);
    if (cgApplyJson?.rollbackId) {
      await client.callTool({ name: "refactor_replace_rollback", arguments: { rollbackId: cgApplyJson.rollbackId } });
      assert(readFileSync(fileEPath, "utf8") === fileEOriginal, "rollback restored File E after capture-group apply");
    }
  }

  // ── 3.14 regex named-group apply substitutes $<name> on disk ──
  console.log("\n  [3.14] regex named-group apply substitutes $<name> on disk...");
  const ngPreview = await client.callTool({
    name: "refactor_replace_preview",
    arguments: {
      repoId: testRepoId,
      find: 'Equal\\("human", (?<recv>[^)]+\\.HandledBy)\\)',
      replaceExpression: "Equal(ConversationHandledByValues.Human, $<recv>)",
      findMode: "regex",
      scope: { includePaths: ["src"] },
      guards: {},
      mode: "text",
      ambiguityThresholdPercent: 100
    }
  });
  const ngPreviewJson = readJson(ngPreview);
  assert(ngPreviewJson?.totalMatches > 0, "named-group preview finds matches", JSON.stringify(ngPreviewJson ?? null).slice(0, 200));
  if (ngPreviewJson?.previewId && ngPreviewJson?.approvalToken) {
    const ngApply = await client.callTool({
      name: "refactor_replace_apply",
      arguments: { previewId: ngPreviewJson.previewId, approvalToken: ngPreviewJson.approvalToken, includeLowConfidence: true }
    });
    const ngApplyJson = readJson(ngApply);
    const fileEAfter = readFileSync(fileEPath, "utf8");
    assert(
      fileEAfter.includes("Assert.Equal(ConversationHandledByValues.Human, result.Conversation.AssignmentState.HandledBy);"),
      "apply wrote substituted named group to disk",
      fileEAfter
    );
    assert(!fileEAfter.includes("$<recv>"), "apply did NOT write literal $<recv> to disk", fileEAfter);
    if (ngApplyJson?.rollbackId) {
      await client.callTool({ name: "refactor_replace_rollback", arguments: { rollbackId: ngApplyJson.rollbackId } });
    }
  }

  // ── 3.15 backreference to a non-existent group is flagged and blocked at apply ──
  console.log("\n  [3.15] unsubstituted backreference is flagged + blocked (no silent write)...");
  const guardPreview = await client.callTool({
    name: "refactor_replace_preview",
    arguments: {
      repoId: testRepoId,
      find: 'Equal\\("guard", probe\\.HandledBy\\)',   // no capture group
      replaceExpression: "Equal(X, $1)",               // $1 references a group that does not exist
      findMode: "regex",
      profile: "compact",
      scope: { includePaths: ["src"] },
      guards: {},
      mode: "text",
      ambiguityThresholdPercent: 100
    }
  });
  const guardPreviewJson = readJson(guardPreview);
  const guardHunks = (guardPreviewJson?.groupedPreviewHunks ?? []).flatMap((g) => g.hunks ?? []);
  assert(guardPreviewJson?.totalMatches > 0, "guard preview finds the match", JSON.stringify(guardPreviewJson ?? null).slice(0, 200));
  assert(
    guardPreviewJson?.diagnostics?.code === "PREVIEW_HAS_UNSUBSTITUTED_BACKREFERENCE",
    "preview diagnostics flags unsubstituted backreference",
    JSON.stringify(guardPreviewJson?.diagnostics ?? null).slice(0, 200)
  );
  assert(
    guardHunks.some((h) => Array.isArray(h.riskFlags) && h.riskFlags.includes("unsubstituted_backreference")),
    "hunk carries unsubstituted_backreference risk flag",
    JSON.stringify(guardHunks).slice(0, 300)
  );
  if (guardPreviewJson?.previewId && guardPreviewJson?.approvalToken) {
    const guardApply = await client.callTool({
      name: "refactor_replace_apply",
      arguments: { previewId: guardPreviewJson.previewId, approvalToken: guardPreviewJson.approvalToken, includeLowConfidence: true }
    });
    const guardApplyJson = readJson(guardApply);
    assert(guardApplyJson?.appliedFiles?.length === 0, "blocked backreference apply writes nothing");
    const guardSkipped = guardApplyJson?.skippedReplacements ?? [];
    assert(
      guardSkipped.some((x) => x.reason === "RISK_FLAG_BLOCKED"),
      "blocked backreference apply reports RISK_FLAG_BLOCKED",
      JSON.stringify(guardSkipped).slice(0, 200)
    );
    assert(readFileSync(fileEPath, "utf8") === fileEOriginal, "File E unchanged after blocked backreference apply");
  }

  // ── 3.16 overlapping previews → second apply reports FILE_CHANGED_BY_CONCURRENT_APPLY (PR2) ──
  console.log("\n  [3.16] overlapping previews → concurrent-apply diagnostic...");
  const mkConcurrentPreview = () => client.callTool({
    name: "refactor_replace_preview",
    arguments: {
      repoId: testRepoId,
      find: "MARKER_ONE",
      replaceExpression: "MARKER_TWO",
      scope: { includePaths: ["src"] },
      guards: {},
      mode: "text",
      ambiguityThresholdPercent: 100
    }
  });
  // Both previews captured against the original file content.
  const concPreview1Json = readJson(await mkConcurrentPreview());
  const concPreview2Json = readJson(await mkConcurrentPreview());
  assert(concPreview1Json?.previewId && concPreview2Json?.previewId, "two overlapping previews created");

  if (concPreview1Json?.approvalToken && concPreview2Json?.approvalToken) {
    const concApply1 = readJson(await client.callTool({
      name: "refactor_replace_apply",
      arguments: { previewId: concPreview1Json.previewId, approvalToken: concPreview1Json.approvalToken, includeLowConfidence: true }
    }));
    assert(concApply1?.appliedFiles?.length === 1, "first concurrent apply succeeds", JSON.stringify(concApply1?.skippedReplacements ?? []).slice(0, 200));

    const concApply2 = readJson(await client.callTool({
      name: "refactor_replace_apply",
      arguments: { previewId: concPreview2Json.previewId, approvalToken: concPreview2Json.approvalToken, includeLowConfidence: true }
    }));
    const conc2Skipped = concApply2?.skippedReplacements ?? [];
    assert(
      conc2Skipped.some((x) => x.reason === "FILE_CHANGED_BY_CONCURRENT_APPLY"),
      "second apply reports FILE_CHANGED_BY_CONCURRENT_APPLY (not bare FILE_CHANGED_AFTER_PREVIEW)",
      JSON.stringify(conc2Skipped).slice(0, 200)
    );
    assert(concApply2?.appliedFiles?.length === 0, "second concurrent apply writes nothing");
  }

  // ── 3.17 optional capture group that did not participate is NOT flagged (substitutes empty) ──
  console.log("\n  [3.17] non-participating optional group substitutes empty, not blocked...");
  const optPreview = await client.callTool({
    name: "refactor_replace_preview",
    arguments: {
      repoId: testRepoId,
      // (?<pre>obsolete\.)? is an OPTIONAL group that won't match here; (probe\.HandledBy) is group 2.
      find: 'Equal\\("opt", (?<pre>obsolete\\.)?(probe\\.HandledBy)\\)',
      replaceExpression: "Equal(ConversationHandledByValues.Opt, $<pre>$2)",
      findMode: "regex",
      profile: "compact",
      scope: { includePaths: ["src"] },
      guards: {},
      mode: "text",
      ambiguityThresholdPercent: 100
    }
  });
  const optPreviewJson = readJson(optPreview);
  const optHunks = (optPreviewJson?.groupedPreviewHunks ?? []).flatMap((g) => g.hunks ?? []);
  assert(optPreviewJson?.totalMatches > 0, "optional-group preview finds the match", JSON.stringify(optPreviewJson ?? null).slice(0, 200));
  assert(
    optPreviewJson?.diagnostics?.code !== "PREVIEW_HAS_UNSUBSTITUTED_BACKREFERENCE",
    "non-participating optional group is NOT flagged as unsubstituted backreference",
    JSON.stringify(optPreviewJson?.diagnostics ?? null).slice(0, 200)
  );
  assert(
    optHunks.every((h) => !(Array.isArray(h.riskFlags) && h.riskFlags.includes("unsubstituted_backreference"))),
    "optional-group hunk carries no unsubstituted_backreference flag",
    JSON.stringify(optHunks).slice(0, 300)
  );
  if (optPreviewJson?.previewId && optPreviewJson?.approvalToken) {
    const optApply = await client.callTool({
      name: "refactor_replace_apply",
      arguments: { previewId: optPreviewJson.previewId, approvalToken: optPreviewJson.approvalToken, includeLowConfidence: true }
    });
    const optApplyJson = readJson(optApply);
    const fileFAfter = readFileSync(fileFPath, "utf8");
    assert(
      fileFAfter.includes("Assert.Equal(ConversationHandledByValues.Opt, probe.HandledBy);"),
      "apply substituted empty optional group + group 2 to disk",
      fileFAfter
    );
    if (optApplyJson?.rollbackId) {
      await client.callTool({ name: "refactor_replace_rollback", arguments: { rollbackId: optApplyJson.rollbackId } });
    }
  }

  // Best-effort close; don't let a lingering child stdio handle block the summary/exit.
  await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);

} finally {
  // Cleanup temp dir
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

process.exit(failed > 0 ? 1 : 0);
