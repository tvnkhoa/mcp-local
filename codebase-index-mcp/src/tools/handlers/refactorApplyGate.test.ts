import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { sha256 } from "../../services/refactor/refactorUtils.js";

import type { RefactorApplyRecord, RefactorPreviewHunkRecord, RefactorPreviewRecord } from "../../types/index.js";
import type { HandlerContext } from "./handlerContext.js";
import { OWNERSHIP_TOOLS, applyPreviewExclusively, assertApplyOwner, assertPreviewOwner, previewOwnerOf } from "./refactorApplyGate.js";

/**
 * MCP-ISSUE-108: a preview belongs to the client process (pid + start time), not to the protocol session —
 * Claude Code re-initializes a new session after a server restart instead of resending its old id.
 */

const ME = "pid:100@638000000000000000/aaaaaaaaaaaaaaaa";
const PEER = "pid:200@638000000000000000/aaaaaaaaaaaaaaaa";
const PID_REUSED = "pid:100@639000000000000000/aaaaaaaaaaaaaaaa";

function ctx(clientSessionId?: string, clientIdentity?: string): HandlerContext {
  return {
    ...(clientSessionId === undefined ? {} : { clientSessionId }),
    ...(clientIdentity === undefined ? {} : { clientIdentity })
  } as HandlerContext;
}

function preview(owner: string | null): RefactorPreviewRecord {
  return { previewId: "preview_1", clientSession: owner } as RefactorPreviewRecord;
}

function apply(owner: string | null): RefactorApplyRecord {
  return { rollbackId: "rollback_1", clientSession: owner } as RefactorApplyRecord;
}

const refusedPreview = (owner: string | null, caller: HandlerContext): void =>
  assert.throws(() => assertPreviewOwner(preview(owner), caller, "refactor_replace_apply"), { code: "PREVIEW_OWNED_BY_ANOTHER_SESSION" });
const refusedApply = (owner: string | null, caller: HandlerContext): void =>
  assert.throws(() => assertApplyOwner(apply(owner), caller, "refactor_replace_rollback"), { code: "APPLY_OWNED_BY_ANOTHER_SESSION" });

test("the owner is the client identity when it resolves, else the session id, else nobody", () => {
  assert.equal(previewOwnerOf(ctx("session-a", ME)), ME);
  assert.equal(previewOwnerOf(ctx("session-a")), "session-a");
  assert.equal(previewOwnerOf(ctx()), null);
});

test("a new session of the same client process applies and rolls back its pre-restart preview", () => {
  const owner = previewOwnerOf(ctx("session-a", ME));
  assert.doesNotThrow(() => assertPreviewOwner(preview(owner), ctx("session-b", ME), "refactor_replace_apply"));
  assert.doesNotThrow(() => assertApplyOwner(apply(owner), ctx("session-b", ME), "refactor_replace_rollback"));
});

test("another client process is refused, in the same server life and after a restart", () => {
  const owner = previewOwnerOf(ctx("session-a", ME));
  refusedPreview(owner, ctx("session-p", PEER));
  refusedApply(owner, ctx("session-p", PEER));
  refusedPreview(owner, ctx("session-q", PEER));
});

test("a reused pid with another start time is refused", () => {
  const owner = previewOwnerOf(ctx("session-a", ME));
  refusedPreview(owner, ctx("session-r", PID_REUSED));
  refusedApply(owner, ctx("session-r", PID_REUSED));
});

test("fail closed: an unresolvable identity owns by session id, which another session cannot match", () => {
  const owner = previewOwnerOf(ctx("session-a"));
  assert.doesNotThrow(() => assertPreviewOwner(preview(owner), ctx("session-a"), "refactor_replace_apply"));
  refusedPreview(owner, ctx("session-b"));
  refusedPreview(owner, ctx("session-b", ME));
  refusedApply(owner, ctx("session-b"));
  // ... and a caller whose identity is unresolvable never matches an identity-owned preview.
  refusedPreview(previewOwnerOf(ctx("session-a", ME)), ctx("session-b"));
});

test("a row stamped with a session id before MCP-ISSUE-108 still opens to that session, and an unowned one to anyone", () => {
  assert.doesNotThrow(() => assertPreviewOwner(preview("session-a"), ctx("session-a", ME), "refactor_replace_apply"));
  refusedPreview("session-a", ctx("session-b", ME));
  assert.doesNotThrow(() => assertPreviewOwner(preview(null), ctx("session-b", PEER), "refactor_replace_apply"));
});

test("only the preview / apply / rollback tools wait for the client identity; a read tool never does", () => {
  assert.deepEqual([...OWNERSHIP_TOOLS].sort(), [
    "change_value_representation", "refactor_replace_apply", "refactor_replace_preview", "refactor_replace_rollback",
    "refactor_symbol_migration", "rename_assist"
  ]);
  for (const read of ["search_symbols", "search_regex", "query_docs", "health_check", "index_repository"]) assert.equal(OWNERSHIP_TOOLS.has(read), false);
});

// MCP-ISSUE-109: an apply that changes 0 lines mints no ids and stores no rollback row.

function fakeStore() {
  const recorded: RefactorApplyRecord[] = [];
  const previewStatus: string[] = [];
  const store = {
    getRecentAppliedFileHashes: () => new Map<string, string>(),
    recordRefactorApply: (record: RefactorApplyRecord) => { recorded.push(record); },
    markRefactorPreviewStatus: (_id: string, status: string) => { previewStatus.push(status); },
    recordPendingReindexFiles: () => undefined
  } as unknown as HandlerContext["store"];
  return { store, recorded, previewStatus };
}

function hunk(content: string, riskFlags: string[]): RefactorPreviewHunkRecord {
  return {
    previewId: "p1", hunkId: "p1_000001", filePath: "a.txt", line: 1, startOffset: 0, endOffset: 3,
    beforeText: "foo", afterText: "bar", replacementText: "bar", ownerType: null, symbolKind: null,
    confidence: 1, riskFlags, fileHashBefore: sha256(content)
  } as unknown as RefactorPreviewHunkRecord;
}

async function runApply(hunks: (content: string) => RefactorPreviewHunkRecord[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noop-apply-"));
  try {
    const content = "foo baz";
    fs.writeFileSync(path.join(dir, "a.txt"), content, "utf8");
    const h = hunks(content);
    const { store, recorded, previewStatus } = fakeStore();
    const result = await applyPreviewExclusively(
      store, dir, "repo", "p1", h, new Set(["a.txt"]),
      { maxFilesPerBatch: 50, stopOnFirstConflict: true, includeLowConfidence: false, lowConfidenceThreshold: 0.7, clientSession: null }
    );
    return { result, recorded, previewStatus, after: fs.readFileSync(path.join(dir, "a.txt"), "utf8") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a 0-line apply issues no applyId or rollbackId, stores no rollback row, and still consumes the preview", async () => {
  const none = await runApply(() => []);
  assert.equal(none.result.noop, true);
  assert.equal(none.result.applyId, null);
  assert.equal(none.result.rollbackId, null);
  assert.equal(none.recorded.length, 0);
  assert.equal(none.previewStatus.length, 1);

  const skipped = await runApply((c) => [hunk(c, ["ambiguous_target"])]);
  assert.equal(skipped.result.noop, true);
  assert.equal(skipped.result.rollbackId, null);
  assert.equal(skipped.recorded.length, 0);
  assert.equal(skipped.after, "foo baz");
});

test("a normal apply still issues ids and stores the apply record", async () => {
  const applied = await runApply((c) => [hunk(c, [])]);
  assert.equal(applied.result.noop, false);
  assert.match(applied.result.applyId ?? "", /^apply_/);
  assert.match(applied.result.rollbackId ?? "", /^rollback_/);
  assert.equal(applied.recorded.length, 1);
  assert.equal(applied.recorded[0].rollbackId, applied.result.rollbackId);
  assert.equal(applied.after, "bar baz");
});
