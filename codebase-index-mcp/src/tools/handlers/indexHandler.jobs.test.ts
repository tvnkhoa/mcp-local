import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { IndexJobQueue } from "../../services/indexing/indexJobs.js";
import type { IndexRunResult } from "../../types/index.js";
import type { HandlerContext } from "./handlerContext.js";
import { handleIndexRepository, handleRegisterWorktree, handleWatchRepo, sameRepoPath } from "./indexHandler.js";

/**
 * MCP-ISSUE-112/114 review follow-ups:
 *   3 — index_repository and register_worktree make no write on the server thread (the run registers the repo on the
 *       worker's connection): the store here throws on any write, and both still answer;
 *   6 — register_worktree refuses the parent's own checkout and a path already registered under another repoId,
 *       comparing paths in any spelling.
 */

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
};

type Repo = { repoId: string; repoPath: string };

function context(root: string, repos: Repo[], hold?: Promise<void>): { ctx: HandlerContext; enqueued: string[]; dispose: () => void } {
  const enqueued: string[] = [];
  const jobs = new IndexJobQueue({
    minFreeRamMb: 0,
    execute: async (job, req) => {
      enqueued.push(req.repoId);
      if (hold) await hold;
      return { runId: job.runId, status: "ok" } as IndexRunResult;
    }
  });
  const write = (name: string) => () => {
    throw new Error(`a server-thread write: ${name}`);
  };
  const store = new Proxy(
    {
      getRepository: (id: string) => repos.find((r) => r.repoId === id) ?? null,
      listRepositories: () => repos
    } as Record<string, unknown>,
    { get: (target, prop: string) => (prop in target ? target[prop] : write(prop)) }
  );
  const timers = new Map<string, NodeJS.Timeout>();
  const ctx = {
    store,
    indexJobs: jobs,
    watchManager: { getStatus: () => [], start: () => ({ started: true, message: "started" }), stop: async () => ({}) },
    activeWatchRef: { current: null },
    watchInactivityTimers: timers,
    runIndexAndResolve: write("runIndexAndResolve"),
    asText: (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] }),
    constants: {
      allowedRoots: [root],
      MAX_FILES_PER_RUN: 1000,
      DOCS_INDEXING_ENABLED: true,
      WATCH_ACTIVE_ONLY: true,
      WATCH_ACTIVE_TTL_MS: 60_000
    }
  } as unknown as HandlerContext;
  return {
    ctx,
    enqueued,
    dispose: () => {
      for (const t of timers.values()) clearTimeout(t);
      jobs.dispose();
    }
  };
}

const body = (r: { content: unknown[] }): Record<string, unknown> => JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;

function fixture(): { root: string; parent: string; wt: string } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "cim-hjobs-")));
  const parent = path.join(root, "parent");
  mkdirSync(path.join(parent, "src"), { recursive: true });
  writeFileSync(path.join(parent, "src", "a.ts"), "export const a = 1;\n");
  git(parent, "init", "-q");
  git(parent, "add", ".");
  git(parent, "commit", "-q", "-m", "base");
  const wt = path.join(root, "parent-wt");
  git(parent, "worktree", "add", "-q", "-b", "wt", wt);
  return { root, parent, wt };
}

test("follow-up 3: index_repository queues the job without writing on the server thread", async () => {
  const { root, parent } = fixture();
  const h = context(root, []);
  try {
    const r = body(await handleIndexRepository({ repoId: "p", repoPath: parent, mode: "full", docsMode: "auto", maxFiles: 100, batchSize: 50 }, h.ctx));
    assert.equal(typeof r.runId, "string");
    assert.ok(["queued", "running"].includes(String(r.state)));
  } finally {
    h.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("follow-up 3 + 6: register_worktree writes nothing here, and refuses the parent's checkout and a path registered elsewhere", async () => {
  const { root, parent, wt } = fixture();
  const repos: Repo[] = [{ repoId: "p", repoPath: parent.replace(/\\/g, "/") }];
  const h = context(root, repos);
  try {
    const ok = body(await handleRegisterWorktree({ parentRepoId: "p", repoPath: wt, repoId: "w" }, h.ctx));
    assert.equal(ok.registered, "new");
    assert.equal(typeof ok.runId, "string");

    await assert.rejects(handleRegisterWorktree({ parentRepoId: "p", repoPath: parent, repoId: "w2" }, h.ctx), /parent's own checkout/);

    repos.push({ repoId: "w-old", repoPath: wt.replace(/\\/g, "/").toUpperCase() });
    const spelled = process.platform === "win32" ? `${wt.replace(/\//g, "\\")}\\` : `${wt}/`;
    await assert.rejects(handleRegisterWorktree({ parentRepoId: "p", repoPath: spelled, repoId: "w-new" }, h.ctx), process.platform === "win32" ? /already registered as 'w-old'/ : /not a git worktree|already registered/);
  } finally {
    h.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("follow-up 6: sameRepoPath ignores slash style and a trailing slash (and case on Windows)", () => {
  assert.equal(sameRepoPath("C:/a/b", "C:\\a\\b\\"), true);
  assert.equal(sameRepoPath("/x/y", "/x/z"), false);
  if (process.platform === "win32") assert.equal(sameRepoPath("D:/Repo", "d:\\repo"), true);
});

test("review follow-up B: a second register_worktree for the same path, before the first job ran, is refused", async () => {
  const { root, parent, wt } = fixture();
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const h = context(root, [{ repoId: "p", repoPath: parent.split("\\").join("/") }], hold);
  try {
    const first = body(await handleRegisterWorktree({ parentRepoId: "p", repoPath: wt, repoId: "w1" }, h.ctx));
    assert.equal(first.registered, "new");
    await assert.rejects(handleRegisterWorktree({ parentRepoId: "p", repoPath: wt, repoId: "w2" }, h.ctx), /already registered as 'w1'/);
    await assert.rejects(handleRegisterWorktree({ parentRepoId: "p", repoPath: path.join(root, "elsewhere"), repoId: "w1" }, h.ctx), /does not exist|index job queued/);
    const again = body(await handleRegisterWorktree({ parentRepoId: "p", repoPath: wt, repoId: "w1" }, h.ctx));
    assert.equal(again.runId, first.runId, "the same registration again joins the job");
  } finally {
    release();
    h.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-121: watch_repo start writes nothing on the server thread; an unregistered repo is registered by a job", async () => {
  const { root, parent } = fixture();
  const repos: Repo[] = [{ repoId: "p", repoPath: parent.replace(/\\/g, "/") }];
  const h = context(root, repos);
  try {
    // Registered at this path: no write, no job.
    const known = body(await handleWatchRepo({ action: "start", repoId: "p", repoPath: parent }, h.ctx));
    assert.equal(known.started, true);
    assert.equal(known.registeredBy, undefined);
    // Not registered: the store throws on any write, so reaching an answer proves none was made here.
    const fresh = body(await handleWatchRepo({ action: "start", repoId: "q", repoPath: parent }, h.ctx));
    const by = fresh.registeredBy as { runId?: unknown; state?: unknown } | undefined;
    assert.equal(typeof by?.runId, "string");
    assert.ok(["queued", "running"].includes(String(by?.state)));
  } finally {
    h.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
