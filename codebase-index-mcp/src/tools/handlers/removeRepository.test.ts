import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { McpError } from "@modelcontextprotocol/sdk/types.js";

import { GraphStore } from "../../repositories/graphStore.js";
import { handleRemoveRepository } from "./indexHandler.js";
import type { HandlerContext } from "./handlerContext.js";

/** MCP-ISSUE-105: the refusals and the state-file cleanup of remove_repository. */

function withCtx(fn: (ctx: HandlerContext, dir: string, stateDir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-rm-"));
  const store = new GraphStore(path.join(dir, "x.db"));
  const stateDir = path.join(dir, ".codebase-index-state");
  mkdirSync(stateDir, { recursive: true });
  const ctx = {
    store,
    activeWatchRef: { current: null },
    constants: { dbPath: path.join(dir, "x.db") },
    asText: (payload: unknown) => payload
  } as unknown as HandlerContext;
  try {
    fn(ctx, dir, stateDir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const call = (ctx: HandlerContext, args: { repoId: string; force?: boolean }): Record<string, unknown> =>
  handleRemoveRepository({ force: false, ...args }, ctx) as unknown as Record<string, unknown>;

test("an unknown repoId is refused", () => {
  withCtx((ctx) => {
    assert.throws(() => call(ctx, { repoId: "nope" }), (e: unknown) => e instanceof McpError && /unknown repoId/.test(e.message));
  });
});

test("a repo whose repoPath still exists is refused without force, removed with it", () => {
  withCtx((ctx, dir) => {
    ctx.store.ensureRepository("live", dir);
    assert.throws(() => call(ctx, { repoId: "live" }), (e: unknown) => e instanceof McpError && /still exists on disk/.test(e.message));
    assert.ok(ctx.store.getRepository("live"));
    assert.equal(call(ctx, { repoId: "live", force: true }).removed, true);
    assert.equal(ctx.store.getRepository("live"), null);
  });
});

test("a repo with a live run marker is refused, even with force", () => {
  withCtx((ctx, dir, stateDir) => {
    ctx.store.ensureRepository("busy", path.join(dir, "missing"));
    writeFileSync(path.join(stateDir, `running-busy-${String(process.pid)}-1.json`), JSON.stringify({ pid: process.pid, at: Date.now() }));
    assert.throws(() => call(ctx, { repoId: "busy", force: true }), (e: unknown) => e instanceof McpError && /in progress/.test(e.message));
    assert.ok(ctx.store.getRepository("busy"));
  });
});

test("a repo with a running watcher is refused", () => {
  withCtx((ctx, dir) => {
    ctx.store.ensureRepository("watched", path.join(dir, "missing"));
    ctx.activeWatchRef.current = "watched";
    assert.throws(() => call(ctx, { repoId: "watched" }), (e: unknown) => e instanceof McpError && /watcher/.test(e.message));
  });
});

test("a vanished repo is removed with its lock, ledger and dead markers; a namesake's lock and ledger stay", () => {
  withCtx((ctx, dir, stateDir) => {
    ctx.store.ensureRepository("wt", path.join(dir, "missing"));
    const mine = ["refresh-wt.lock", "dirty-wt.json", "running-wt-999999-1.json"];
    const others = ["refresh-wt-b.lock", "dirty-wt-b.json"];
    for (const f of [...mine, ...others]) writeFileSync(path.join(stateDir, f), JSON.stringify({ pid: 999999, at: 0 }));
    const out = call(ctx, { repoId: "wt" });
    // the dead marker is swept by the live-run check before the purge, so it is gone but not listed
    assert.deepEqual(out.stateFilesRemoved, ["dirty-wt.json", "refresh-wt.lock"]);
    for (const f of mine) assert.ok(!existsSync(path.join(stateDir, f)), f);
    for (const f of others) assert.ok(existsSync(path.join(stateDir, f)), f);
    assert.equal(ctx.store.getRepository("wt"), null);
  });
});
