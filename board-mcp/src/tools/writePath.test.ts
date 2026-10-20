/**
 * The write path against the REAL board.mjs — in a throwaway git repo, never in wec.aria.
 *
 * wec.aria's live board is shared by several sessions (its claims sit in the git common dir), so
 * no write subcommand ever runs there. Each run copies wec.aria's CURRENT checks/board/*.mjs,
 * board.json and units/ (so upstream fixes such as 704eb34f's whole-line rule are what is tested)
 * into a fresh temp repo; the copy's claims then live in the temp repo's own .git. Skips when no
 * wec.aria checkout is present (this workspace's CI).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBoardRunner } from "../services/boardCli.js";
import { call, configFor, realBoardRoot, SESSION } from "./testSupport.test.js";

const OTHER = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";

function scratchCopy(source: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "board-mcp-live-"));
  const from = path.join(source, "checks", "board");
  const to = path.join(root, "checks", "board");
  mkdirSync(to, { recursive: true });
  for (const f of readdirSync(from)) if (f.endsWith(".mjs") || f === "board.json") cpSync(path.join(from, f), path.join(to, f));
  cpSync(path.join(from, "units"), path.join(to, "units"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  git("add", "-A");
  git("-c", "user.email=board-mcp@test.invalid", "-c", "user.name=board-mcp test", "commit", "-qm", "scratch board");
  return root;
}

test("write path on a scratch copy: claim, refusal to a second session, gate refused without the owner's words, release", async (t) => {
  const source = realBoardRoot();
  if (source === null) {
    t.skip("no wec.aria checkout to copy board.mjs from");
    return;
  }
  const root = scratchCopy(source);
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  assert.notEqual(path.resolve(root), path.resolve(source), "never the live board");
  const units = readdirSync(path.join(root, "checks", "board", "units")).filter((f) => f.endsWith(".json"));
  assert.ok(units.length > 0);
  const unit = (units.find((f) => f.startsWith("screen--")) ?? units[0] ?? "").replace(/\.json$/u, "");
  const config = configFor(root, { callTimeoutMs: 60_000 });

  const claim = await call(config, "claim", { unit, session: SESSION });
  assert.equal(claim.isError, false, JSON.stringify(claim.payload));
  assert.equal(claim.payload.ok, true, JSON.stringify(claim.payload));
  assert.match(claim.payload.text, new RegExp(`claimed by ${SESSION}`, "u"));

  const second = await call(config, "claim", { unit, session: OTHER });
  assert.equal(second.payload.refused, true);
  assert.match(second.payload.why, new RegExp(`held by ${SESSION}`, "u"));

  // No transcript of this scratch repo holds these words, and --as scopes the search to SESSION.
  const gate = await call(config, "advance", { unit, phase: "P1", gate: "Đồng ý `x` $y || giữ nguyên", session: SESSION });
  assert.equal(gate.payload.refused, true, JSON.stringify(gate.payload));
  assert.match(gate.payload.why, new RegExp(`--gate: no user message in session ${SESSION}`, "u"));
  assert.ok(gate.payload.why.includes("Đồng ý `x` $y"), "the words reached board.mjs intact");

  const release = await call(config, "release", { target: unit, session: SESSION });
  assert.equal(release.payload.ok, true, JSON.stringify(release.payload));

  const assess = await call(config, "assess", { kind: "screen", yes: [] });
  assert.equal(assess.payload.ok, true);
  assert.match(assess.payload.text, /recommended: light/u);

  // The live board's claim directory was never touched by any of this.
  assert.ok(existsSync(path.join(root, ".git", "aria-board", "claims")), "claims went to the scratch repo's own git dir");
});

/**
 * The owner-words proof itself, end to end: a scratch HOME holds a fake transcript for SESSION in
 * the folder board.mjs derives from the scratch repo's path, so nothing under the real
 * ~/.claude/projects is read or written.
 */
test("short words: board.mjs (704eb34f) proves a part under 8 characters only as a whole line", async (t) => {
  const source = realBoardRoot();
  if (source === null) {
    t.skip("no wec.aria checkout to copy board.mjs from");
    return;
  }
  const root = scratchCopy(source);
  const home = mkdtempSync(path.join(os.tmpdir(), "board-mcp-home-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  });
  const io = readFileSync(path.join(root, "checks", "board", "io.mjs"), "utf8");
  if (!io.includes("SHORT_WORDS")) {
    t.skip("this wec.aria checkout predates 704eb34f (no whole-line rule)");
    return;
  }

  // The project folder name board.mjs gives this repo: its worktree path, each non-alphanumeric a '-'.
  const worktree = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" })
    .split("\n").find((l) => l.startsWith("worktree "))?.slice(9) ?? root;
  const project = path.join(home, ".claude", "projects", path.resolve(worktree).replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  const row = (uuid: string, at: string, content: string) =>
    JSON.stringify({ type: "user", uuid, timestamp: at, origin: { kind: "human" }, message: { role: "user", content } });
  writeFileSync(
    path.join(project, `${SESSION}.jsonl`),
    [row("u-1", "2026-10-20T01:00:00Z", "I think it is ok to leave for now"), row("u-2", "2026-10-20T02:00:00Z", "Đồng ý\nthanks")].join("\n") + "\n"
  );

  const landed = readdirSync(path.join(root, "checks", "board", "units"))
    .map((f) => JSON.parse(readFileSync(path.join(root, "checks", "board", "units", f), "utf8")) as { id: string; status?: string })
    .find((u) => u.status === "landed");
  assert.ok(landed, "a landed unit to record an owner disposition on (no claim needed)");
  const config = configFor(root, { callTimeoutMs: 60_000 });
  const run = createBoardRunner(config, { env: { ...process.env, USERPROFILE: home, HOME: home } });

  // "ok" sits inside a sentence of u-1, not on a line of its own: board.mjs refuses. Since
  // 704eb34f its message search applies the whole-line rule too, so it finds no message at all.
  const short = await call(config, "discover", { unit: landed.id, text: "found by board-mcp's test", owner: true, gate: "ok", session: SESSION }, run);
  assert.equal(short.isError, false, JSON.stringify(short.payload));
  assert.equal(short.payload.refused, true, JSON.stringify(short.payload));
  assert.match(short.payload.why, /no user message in session .* contains "ok"|as a whole line/u);

  // "Đồng ý" is a whole line of u-2: proven, and board.mjs records the disposition.
  const whole = await call(config, "discover", { unit: landed.id, text: "found by board-mcp's test", owner: true, gate: "Đồng ý", session: SESSION }, run);
  assert.equal(whole.payload.ok, true, JSON.stringify(whole.payload));
  assert.match(whole.payload.text, /owner/u);
});
