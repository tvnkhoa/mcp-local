/**
 * The write path against the REAL board.mjs — in a throwaway git repo, never in wec.aria.
 *
 * wec.aria's live board is shared by several sessions (its claims sit in the git common dir), so
 * no write subcommand ever runs there. This copies checks/board/*.mjs, board.json and units/ into
 * a fresh temp repo; the copy's claims then live in the temp repo's own .git. Skips when no
 * wec.aria checkout is present (this workspace's CI).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
