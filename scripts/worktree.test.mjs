/**
 * V-B: `worktree.mjs` against a temp git repo shaped like the workspace (root + a server + packages,
 * node_modules ignored, @mcp/* linked to packages/* as npm links them).
 *
 * Pinned: every node_modules in the worktree is a real dir of per-entry junctions to main's, with
 * @mcp/* pointing at the WORKTREE's packages; `remove` refuses a dirty worktree without --force; and no
 * remove — clean or forced — deletes anything through a junction: main's files are all still there.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isLink, removeTree } from "./lib/junctions.mjs";
import { addWorktree, findLinks, listWorktrees, mainRoot, nodeModulesDirs, removeWorktree, validName, worktreePath } from "./worktree.mjs";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-")));
test.after(() => removeTree(TMP)); // it holds junctions: unlink them, never walk them

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();

/** Files that live behind a junction from the worktree; each must survive every remove. */
const MAIN_FILES = ["node_modules/rootdep/index.js", "srv/node_modules/localdep/index.js", "packages/core/package.json", "packages/core/dist/index.js"];

function fakeRepo(name) {
  const root = path.join(TMP, name);
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write("package.json", JSON.stringify({ name: "ws" }));
  write(".gitignore", "node_modules/\ndist/\n");
  write("packages/core/package.json", JSON.stringify({ name: "@mcp/core" }));
  write("srv/package.json", JSON.stringify({ name: "srv", dependencies: { "@mcp/core": "file:../packages/core" } }));
  git(TMP, "init", "-q", root);
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "add", "package.json", ".gitignore", "packages/core/package.json", "srv/package.json");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  write("packages/core/dist/index.js", "main-core\n");
  write("node_modules/rootdep/index.js", "rootdep\n");
  write("node_modules/.package-lock.json", "{}");
  write("srv/node_modules/localdep/index.js", "localdep\n");
  for (const nm of ["node_modules/@mcp", "srv/node_modules/@mcp"]) {
    fs.mkdirSync(path.join(root, nm), { recursive: true });
    fs.symlinkSync(path.join(root, "packages/core"), path.join(root, nm, "core"), "junction");
  }
  return root;
}

const assertMainIntact = (root) => {
  for (const rel of MAIN_FILES) assert.ok(fs.existsSync(path.join(root, rel)), `${rel} survived`);
  assert.ok(isLink(path.join(root, "node_modules/@mcp/core")), "main's own @mcp link is untouched");
};

test("names are checked, and the worktree sits beside the main tree", () => {
  assert.ok(validName("v-b.1"));
  for (const bad of ["", "../x", "a/b", "-x", "a b"]) assert.ok(!validName(bad), bad);
  assert.equal(worktreePath(path.join("D:", "src", "mcp-local"), "x"), path.join("D:", "src", "mcp-local-wt-x"));
});

test("add links every node_modules per entry, with @mcp/* -> the worktree's packages", () => {
  const root = fakeRepo("repo-add");
  assert.deepEqual(nodeModulesDirs(root).sort(), [".", "srv"]);
  const r = addWorktree("a", { cwd: root });
  const wt = worktreePath(root, "a");
  assert.equal(r.path, wt);
  assert.equal(git(wt, "rev-parse", "--abbrev-ref", "HEAD"), "wt/a");
  assert.equal(mainRoot(wt), root, "mainRoot resolves from inside the worktree");
  for (const dir of [".", "srv"]) {
    const nm = path.join(wt, dir, "node_modules");
    assert.ok(fs.statSync(nm).isDirectory() && !isLink(nm), `${dir}/node_modules is a real dir`);
    assert.ok(!isLink(path.join(nm, "@mcp")), "@mcp is a real dir");
    assert.equal(fs.realpathSync(path.join(nm, "@mcp", "core")), fs.realpathSync(path.join(wt, "packages", "core")));
  }
  assert.ok(isLink(path.join(wt, "node_modules", "rootdep")));
  assert.equal(fs.realpathSync(path.join(wt, "srv/node_modules/localdep")), fs.realpathSync(path.join(root, "srv/node_modules/localdep")));
  assert.ok(!isLink(path.join(wt, "node_modules", ".package-lock.json")), "a file is copied, not linked");
  assert.equal(git(wt, "status", "--porcelain"), "", "linked node_modules stay out of git status");
  assert.ok(listWorktrees({ cwd: root }).some((w) => w.path === wt && w.branch === "wt/a" && w.linked));
  assert.throws(() => addWorktree("a", { cwd: root }), /already exists/);
});

test("remove refuses a dirty worktree, then removes a clean one without touching main", () => {
  const root = fakeRepo("repo-remove");
  const wt = addWorktree("b", { cwd: root }).path;
  fs.writeFileSync(path.join(wt, "srv", "new.txt"), "untracked\n");
  assert.throws(() => removeWorktree("b", { cwd: root }), /uncommitted changes/);
  assert.ok(isLink(path.join(wt, "node_modules", "rootdep")), "a refused remove unlinks nothing");
  fs.rmSync(path.join(wt, "srv", "new.txt"));
  // Built output in the worktree is ignored and goes with it.
  fs.mkdirSync(path.join(wt, "packages/core/dist"), { recursive: true });
  fs.writeFileSync(path.join(wt, "packages/core/dist/index.js"), "wt-core\n");
  const r = removeWorktree("b", { cwd: root });
  assert.deepEqual(r.unlinked.sort(), [".", "srv"]);
  assert.ok(!fs.existsSync(wt));
  assert.ok(!listWorktrees({ cwd: root }).some((w) => w.path === wt));
  assertMainIntact(root);
  assert.equal(fs.readFileSync(path.join(root, "packages/core/dist/index.js"), "utf-8"), "main-core\n");
  assert.equal(git(root, "branch", "--list", "wt/b"), "wt/b", "the branch is kept");
});

test("--force removes a dirty worktree and still never deletes through a junction", () => {
  const root = fakeRepo("repo-force");
  const wt = addWorktree("c", { cwd: root }).path;
  fs.writeFileSync(path.join(wt, "package.json"), "{}\n");
  fs.writeFileSync(path.join(wt, "srv", "new.txt"), "untracked\n");
  removeWorktree("c", { cwd: root, force: true });
  assert.ok(!fs.existsSync(wt));
  assertMainIntact(root);
});

test("a node_modules only the worktree has is unlinked too, and its target survives", () => {
  const root = fakeRepo("repo-wtonly");
  const wt = addWorktree("d", { cwd: root }).path;
  fs.mkdirSync(path.join(wt, "extra", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(wt, "extra", "package.json"), "{}\n");
  fs.symlinkSync(path.join(root, "node_modules", "rootdep"), path.join(wt, "extra", "node_modules", "rootdep"), "junction");
  const r = removeWorktree("d", { cwd: root, force: true });
  assert.ok(r.unlinked.includes("extra"));
  assert.ok(!fs.existsSync(wt));
  assertMainIntact(root);
});

test("any other link left in the worktree makes remove refuse before git runs; main is untouched", () => {
  const root = fakeRepo("repo-stray-link");
  const wt = addWorktree("e", { cwd: root }).path;
  const link = path.join(wt, "srv", "handmade");
  fs.symlinkSync(path.join(root, "srv", "node_modules"), link, "junction");
  assert.deepEqual(findLinks(wt).filter((p) => !p.includes("node_modules")), [link]);
  assert.throws(() => removeWorktree("e", { cwd: root, force: true }), (e) => /still holds links/.test(e.message) && e.message.includes(link));
  assert.ok(fs.existsSync(wt), "git was never asked to remove it");
  assertMainIntact(root);
  fs.unlinkSync(link);
  removeWorktree("e", { cwd: root, force: true });
  assert.ok(!fs.existsSync(wt));
  assertMainIntact(root);
});

test("a sibling dir that is not a registered worktree is refused and its node_modules left alone", () => {
  const root = fakeRepo("repo-sibling");
  const stray = worktreePath(root, "f");
  fs.mkdirSync(path.join(stray, "node_modules", "real"), { recursive: true });
  fs.writeFileSync(path.join(stray, "package.json"), "{}\n");
  fs.writeFileSync(path.join(stray, "node_modules", "real", "index.js"), "keep\n");
  assert.throws(() => removeWorktree("f", { cwd: root, force: true }), /not a registered worktree/);
  assert.equal(fs.readFileSync(path.join(stray, "node_modules", "real", "index.js"), "utf-8"), "keep\n");
});
