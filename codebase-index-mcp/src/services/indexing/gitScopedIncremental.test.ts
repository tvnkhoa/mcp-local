import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { WorkRunTrace } from "../../repositories/runStore.js";
import { diffNameStatusSince, type NameStatusEntry } from "../git/gitHelpers.js";
import { INDEX_VERSION } from "./indexPipeline.js";
import { planGitScopedIncremental, type GitScopeInputs } from "./runPolicy.js";

/**
 * MCP-ISSUE-106: which files an incremental run re-reads after a HEAD move. A plan that names too few leaves the
 * index stale with nothing to say so; every case here that cannot be vouched for must walk the tree.
 */

const run = (over: Partial<WorkRunTrace> = {}): WorkRunTrace => ({
  mode: "incremental",
  status: "ok",
  commitSha: "a".repeat(40),
  indexVersion: INDEX_VERSION,
  treeKey: JSON.stringify({ head: "a".repeat(40), files: {} }),
  treeDirty: false,
  ...over
});

const key = (...paths: string[]): string => JSON.stringify({ head: "a".repeat(40), files: Object.fromEntries(paths.map((p) => [p, "h"])) });

function inputs(over: Partial<GitScopeInputs> = {}, diff: NameStatusEntry[] | null = []): GitScopeInputs {
  return {
    runs: [run()],
    diffSince: () => diff,
    dirtyNow: [],
    pending: [],
    gitScan: true,
    subdirectory: false,
    annotationKeyCurrent: true,
    ...over
  };
}

test("scoped: the diff (both sides of a rename), the dirty set and the pending set", () => {
  const plan = planGitScopedIncremental(
    inputs({ dirtyNow: ["src/new.ts"], pending: ["src/refactored.ts"] }, [
      { status: "M", path: "src/a.ts" },
      { status: "D", path: "src/gone.ts" },
      { status: "R", path: "src/to.ts", origPath: "src/from.ts" }
    ])
  );
  assert.equal(plan.kind, "scoped");
  if (plan.kind !== "scoped") return;
  assert.deepEqual([...plan.paths].sort(), ["src/a.ts", "src/from.ts", "src/gone.ts", "src/new.ts", "src/refactored.ts", "src/to.ts"]);
  assert.equal(plan.diffPaths, 4);
});

test("scoped: an empty diff on a clean tree re-reads nothing", () => {
  const plan = planGitScopedIncremental(inputs());
  assert.equal(plan.kind, "scoped");
  if (plan.kind === "scoped") assert.equal(plan.paths.size, 0);
});

test("scoped: every path a dirty run indexed since the base is re-read, and the base's own dirty paths", () => {
  // A file dirty then and reverted since is in neither the diff nor the dirty set: only the tree keys name it.
  const plan = planGitScopedIncremental(
    inputs({
      runs: [
        run({ mode: "dirty", treeKey: key("src/late.ts") }),
        run({ mode: "dirty", treeKey: key("src/early.ts") }),
        run({ mode: "incremental", treeKey: key("src/at-base.ts"), treeDirty: true }),
        run({ mode: "dirty", treeKey: key("src/before-base.ts") })
      ]
    })
  );
  assert.equal(plan.kind, "scoped");
  if (plan.kind === "scoped") assert.deepEqual([...plan.paths].sort(), ["src/at-base.ts", "src/early.ts", "src/late.ts"]);
});

test("the base is the newest complete run, and git diffs from its commit", () => {
  let asked: string | null = null;
  planGitScopedIncremental({
    ...inputs({ runs: [run({ mode: "dirty", commitSha: "c".repeat(40) }), run({ mode: "full", commitSha: "b".repeat(40) })] }),
    diffSince: (sha) => {
      asked = sha;
      return [];
    }
  });
  assert.equal(asked, "b".repeat(40));
});

for (const [name, over, diff] of [
  ["respectGitignore:false", { gitScan: false }, []],
  ["a subdirectory repoPath", { subdirectory: true }, []],
  ["a stale annotation key", { annotationKeyCurrent: false }, []],
  ["no run on record", { runs: [] }, []],
  ["only dirty runs on record", { runs: [run({ mode: "dirty" })] }, []],
  ["a cancelled run since the base", { runs: [run({ mode: "dirty", status: "cancelled" }), run()] }, []],
  ["a degraded base", { runs: [run({ status: "degraded" })] }, []],
  ["a dirty run without a tree key", { runs: [run({ mode: "dirty", treeKey: null }), run()] }, []],
  ["a base over a dirty tree without a tree key", { runs: [run({ treeKey: null, treeDirty: true })] }, []],
  ["a base without a commit", { runs: [run({ commitSha: null })] }, []],
  ["a base at another INDEX_VERSION", { runs: [run({ indexVersion: "v1-old" })] }, []],
  ["a commit git cannot diff", {}, null],
  ["a .gitignore change", {}, [{ status: "M", path: "src/.gitignore" }]],
  ["a .codebase-index config change", {}, [{ status: "M", path: ".codebase-index/citations.json" }]],
  ["a dirty tsconfig", { dirtyNow: ["tsconfig.json"] }, []],
  ["a diff over the cap", { maxPaths: 2 }, [{ status: "M", path: "a.ts" }, { status: "M", path: "b.ts" }, { status: "M", path: "c.ts" }]]
] as Array<[string, Partial<GitScopeInputs>, NameStatusEntry[] | null]>) {
  test(`walks the tree: ${name}`, () => {
    assert.equal(planGitScopedIncremental(inputs(over, diff)).kind, "walk");
  });
}

test("diffNameStatusSince: adds, edits, deletes, renames; backwards; null for an unknown commit", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "g1-diff-"));
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("config", "core.autocrlf", "false");
    writeFileSync(path.join(dir, "keep.ts"), "export const a = 1;\n");
    writeFileSync(path.join(dir, "gone.ts"), "export const g = 1;\n");
    writeFileSync(path.join(dir, "from.ts"), "export function moved(): number {\n  return 42 + 42 + 42;\n}\n");
    git("add", "keep.ts", "gone.ts", "from.ts");
    git("commit", "-q", "-m", "one");
    const first = git("rev-parse", "HEAD");
    writeFileSync(path.join(dir, "keep.ts"), "export const a = 2;\n");
    writeFileSync(path.join(dir, "new.ts"), "export const n = 1;\n");
    git("rm", "-q", "gone.ts");
    git("mv", "from.ts", "to.ts");
    git("add", "keep.ts", "new.ts");
    git("commit", "-q", "-m", "two");
    const second = git("rev-parse", "HEAD");

    const forward = diffNameStatusSince(dir, first);
    assert.deepEqual(
      forward?.map((e) => `${e.status} ${e.origPath ? `${e.origPath}->` : ""}${e.path}`).sort(),
      ["A new.ts", "D gone.ts", "M keep.ts", "R from.ts->to.ts"]
    );
    assert.deepEqual(diffNameStatusSince(dir, second), []);

    git("checkout", "-q", first);
    const backward = diffNameStatusSince(dir, second);
    assert.deepEqual(
      backward?.map((e) => `${e.status} ${e.origPath ? `${e.origPath}->` : ""}${e.path}`).sort(),
      ["A gone.ts", "D new.ts", "M keep.ts", "R to.ts->from.ts"]
    );
    assert.equal(diffNameStatusSince(dir, "0".repeat(40)), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
