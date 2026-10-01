/**
 * The write half of `agents.mjs`: what the installer, `mcp:update` and `mcp:uninstall` do to an
 * agent config. Every test works on a file in a temp directory — none of them touches the real
 * `~/.claude.json` or VS Code settings.
 *
 *   P4a  the read-modify-write window: re-read immediately before writing, verify after
 *   P4b  backup rotation
 *   P4c  VS Code settings.json comments survive a write
 *   P4e  `refreshServerPath` re-points a moved checkout without touching env
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import {
  BACKUP_KEEP,
  configureAgent,
  detectAgents,
  readServerEntry,
  refreshServerPath,
  rotateBackups,
  unconfigureAgent,
} from "./agents.mjs";
import { editJsoncText, readJsonc } from "./jsonc.mjs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agents-write-test-"));
let n = 0;

function fileWith(content, name = "cfg.json") {
  const dir = path.join(tmpRoot, String(n++));
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content, null, 2), "utf8");
  return p;
}

const ENTRY = { command: "node", args: ["D:/new/postgres-mcp/dist/index.js"], env: { POSTGRES_CONNECTION: "x" } };

// ---- P4a ----

test("P4a: a write lost to a concurrent writer is re-merged, and both changes survive", () => {
  const configPath = fileWith({ projects: { a: 1 } });
  const agent = { name: "Claude Code", type: "claude-code", configPath };

  // Simulate Claude Code rewriting the file from its in-memory copy right after our first rename:
  // our entry disappears, and its own new state (`numStartups`) appears.
  const realRename = fs.renameSync;
  let clobbered = false;
  const spy = mock.method(fs, "renameSync", (from, to) => {
    realRename(from, to);
    if (!clobbered && to === configPath) {
      clobbered = true;
      fs.writeFileSync(configPath, JSON.stringify({ projects: { a: 1 }, numStartups: 7 }), "utf8");
    }
  });
  try {
    assert.equal(configureAgent(agent, "postgres-mcp", ENTRY), true);
  } finally {
    spy.mock.restore();
  }

  assert.ok(clobbered, "the simulated concurrent write must have happened");
  const cfg = readJsonc(configPath);
  assert.deepEqual(cfg.mcpServers["postgres-mcp"], ENTRY, "our entry is back after the re-merge");
  assert.equal(cfg.numStartups, 7, "the other writer's change is kept, not overwritten");
});

test("P4a: the merge is onto the file as it is at write time, not as first read", () => {
  const configPath = fileWith({ mcpServers: { other: { command: "x", args: [] } } });
  const agent = { name: "Claude Code", type: "claude-code", configPath };
  assert.equal(configureAgent(agent, "postgres-mcp", ENTRY), true);
  // A second server in a later call sees the first one's write and the unrelated entry.
  assert.equal(configureAgent(agent, "observe-mcp", { ...ENTRY, args: ["D:/new/observe-mcp/dist/index.js"] }), true);
  const cfg = readJsonc(configPath);
  assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ["observe-mcp", "other", "postgres-mcp"]);
});

// ---- P4b ----

test("P4b: rotateBackups keeps the newest BACKUP_KEEP and never touches other names", () => {
  assert.equal(BACKUP_KEEP, 5);
  const configPath = fileWith({});
  const dir = path.dirname(configPath);
  const stamps = [100, 900, 300, 700, 200, 800, 400, 600]; // deliberately unsorted
  for (const s of stamps) fs.writeFileSync(`${configPath}.backup.${String(s)}`, "{}");
  fs.writeFileSync(`${configPath}.backup.manual`, "{}");
  fs.writeFileSync(path.join(dir, "other.json.backup.1"), "{}");

  const removed = rotateBackups(configPath).map((p) => path.basename(p)).sort();
  assert.deepEqual(removed, ["cfg.json.backup.100", "cfg.json.backup.200", "cfg.json.backup.300"]);

  const left = fs.readdirSync(dir).filter((f) => f !== "cfg.json").sort();
  assert.deepEqual(left, [
    "cfg.json.backup.400", "cfg.json.backup.600", "cfg.json.backup.700", "cfg.json.backup.800",
    "cfg.json.backup.900", "cfg.json.backup.manual", "other.json.backup.1",
  ]);
});

test("P4b: a write rotates the backups beside the config it backed up", () => {
  const configPath = fileWith({});
  for (let i = 1; i <= 9; i++) fs.writeFileSync(`${configPath}.backup.${String(i)}`, "{}");
  configureAgent({ name: "Claude Code", type: "claude-code", configPath }, "postgres-mcp", ENTRY);
  const backups = fs.readdirSync(path.dirname(configPath)).filter((f) => f.includes(".backup."));
  assert.equal(backups.length, BACKUP_KEEP);
});

// ---- P4c ----

const COMMENTED = `{
    // Editor
    "editor.fontSize": 14, /* keep */
    "mcp": {
        "servers": {
            // hand-added, do not touch
            "mine": { "command": "x", "args": [] },
        }
    },
}
`;

test("P4c: registering a server in a commented settings.json keeps every comment", () => {
  const configPath = fileWith(COMMENTED, "settings.json");
  const agent = { name: "VS Code", type: "vscode", configPath };
  assert.equal(configureAgent(agent, "postgres-mcp", ENTRY), true);

  const text = fs.readFileSync(configPath, "utf8");
  for (const c of ["// Editor", "/* keep */", "// hand-added, do not touch"]) assert.ok(text.includes(c), `lost: ${c}`);
  const cfg = readJsonc(configPath);
  assert.deepEqual(cfg.mcp.servers["postgres-mcp"], ENTRY);
  assert.deepEqual(cfg.mcp.servers.mine, { command: "x", args: [] });
  assert.equal(cfg["editor.fontSize"], 14);

  // Re-registering replaces the value in place, still keeping the comments.
  const moved = { ...ENTRY, args: ["E:/elsewhere/postgres-mcp/dist/index.js"] };
  assert.equal(configureAgent(agent, "postgres-mcp", moved), true);
  const again = fs.readFileSync(configPath, "utf8");
  assert.ok(again.includes("// hand-added, do not touch"));
  assert.deepEqual(readJsonc(configPath).mcp.servers["postgres-mcp"], moved);

  // And removal cuts out only our member.
  assert.equal(unconfigureAgent(agent, "postgres-mcp"), true);
  const removed = fs.readFileSync(configPath, "utf8");
  assert.ok(removed.includes("// hand-added, do not touch") && removed.includes("// Editor"));
  assert.equal(readServerEntry(agent, "postgres-mcp"), null);
  assert.deepEqual(readJsonc(configPath).mcp.servers.mine, { command: "x", args: [] });
});

test("P4c: a commented file with no mcp block gets one inserted, comments intact", () => {
  const configPath = fileWith(`{\n  // only a comment\n  "a": 1\n}\n`, "settings.json");
  const agent = { name: "VS Code", type: "vscode", configPath };
  assert.equal(configureAgent(agent, "postgres-mcp", ENTRY), true);
  assert.ok(fs.readFileSync(configPath, "utf8").includes("// only a comment"));
  assert.deepEqual(readJsonc(configPath), { mcp: { servers: { "postgres-mcp": ENTRY } }, a: 1 });
});

test("P4c: when the edit cannot match the structural change, the file is refused, not rewritten", () => {
  // A legacy flat "mcp.servers" key: the structural path folds it into mcp.servers, which a
  // member-level text edit does not do — so the verification fails and nothing is written.
  const original = `{\n  // keep me\n  "mcp.servers": { "old": { "command": "x", "args": [] } }\n}\n`;
  const configPath = fileWith(original, "settings.json");
  const agent = { name: "VS Code", type: "vscode", configPath };
  const logged = mock.method(console, "log", () => {});
  try {
    assert.equal(configureAgent(agent, "postgres-mcp", { ...ENTRY, env: { POSTGRES_CONNECTION: "secret-value" } }), false);
    const printed = logged.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
    assert.ok(printed.includes('"postgres-mcp"'), "the snippet to paste is printed");
    assert.ok(!printed.includes("secret-value"), "a secret-looking env value is masked in the snippet");
  } finally {
    logged.mock.restore();
  }
  assert.equal(fs.readFileSync(configPath, "utf8"), original);
});

test("P4c: a VS Code settings.json WITHOUT comments is still written as plain JSON", () => {
  const configPath = fileWith({ "editor.fontSize": 14 }, "settings.json");
  assert.equal(configureAgent({ name: "VS Code", type: "vscode", configPath }, "postgres-mcp", ENTRY), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).mcp.servers["postgres-mcp"], ENTRY);
});

test("P4c: editJsoncText handles trailing commas, nesting and the last member", () => {
  const text = `{\n  "a": [1, 2,],\n  "b": { "c": "/* not a comment */", },\n  // tail\n  "d": true\n}`;
  const set = editJsoncText(text, [{ path: ["b", "e"], value: { f: 1 } }]);
  assert.deepEqual(readJsoncText(set).b, { e: { f: 1 }, c: "/* not a comment */" });
  const del = editJsoncText(text, [{ path: ["d"], remove: true }]);
  assert.ok(del.includes("// tail"));
  assert.deepEqual(Object.keys(readJsoncText(del)), ["a", "b"]);
  assert.equal(editJsoncText("{ not json", [{ path: ["a"], value: 1 }]), null);
});

function readJsoncText(text) {
  const p = fileWith(text, "x.jsonc");
  return readJsonc(p);
}

// ---- P4e ----

test("P4e: refreshServerPath re-points a moved checkout and leaves env byte-identical", () => {
  const env = { POSTGRES_CONNECTION: "keep", PGSSLMODE: "require" };
  const configPath = fileWith({
    mcpServers: {
      "postgres-mcp": { command: "node", args: ["--inspect", "C:\\old\\checkout\\postgres-mcp\\dist\\index.js"], env },
      "postgres-mcp-prod": { command: "node", args: ["C:/old/checkout/postgres-mcp/dist/index.js"], env: { A: "1" } },
      // Shares the prefix but launches something else: must not be touched.
      "postgres-mcp-wrapper": { command: "node", args: ["C:/tools/wrapper.js"], env: {} },
    },
  });
  const agent = { name: "Claude Code", type: "claude-code", configPath };
  const target = "D:/new/postgres-mcp/dist/index.js";

  const names = refreshServerPath(agent, "postgres-mcp", target, "postgres-mcp/dist/index.js");
  assert.deepEqual(names.sort(), ["postgres-mcp", "postgres-mcp-prod"]);

  const cfg = readJsonc(configPath).mcpServers;
  assert.deepEqual(cfg["postgres-mcp"], { command: "node", args: ["--inspect", target], env });
  assert.deepEqual(cfg["postgres-mcp-prod"].args, [target]);
  assert.deepEqual(cfg["postgres-mcp-prod"].env, { A: "1" });
  assert.deepEqual(cfg["postgres-mcp-wrapper"].args, ["C:/tools/wrapper.js"]);

  // Idempotent: a second run has nothing to do.
  assert.deepEqual(refreshServerPath(agent, "postgres-mcp", target, "postgres-mcp/dist/index.js"), []);
});

test("P4e: refreshServerPath handles opencode's command array and does not register anything", () => {
  const configPath = fileWith({ mcp: { "postgres-mcp": { type: "local", command: ["node", "C:/old/postgres-mcp/dist/index.js"], environment: { X: "1" } } } });
  const agent = { name: "OpenCode", type: "opencode", configPath };
  assert.deepEqual(refreshServerPath(agent, "postgres-mcp", "D:/n/postgres-mcp/dist/index.js", "postgres-mcp/dist/index.js"), ["postgres-mcp"]);
  const entry = readJsonc(configPath).mcp["postgres-mcp"];
  assert.deepEqual(entry.command, ["node", "D:/n/postgres-mcp/dist/index.js"]);
  assert.deepEqual(entry.environment, { X: "1" });

  const empty = fileWith({});
  assert.deepEqual(refreshServerPath({ ...agent, configPath: empty }, "postgres-mcp", "D:/n/x.js", "postgres-mcp/dist/index.js"), []);
  assert.deepEqual(readJsonc(empty), {}, "an unregistered server stays unregistered");
});

// ---- detection is redirectable, so nothing above needs the real home ----

test("detectAgents can be pointed at a temp home", () => {
  const home = path.join(tmpRoot, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, ".claude.json"), "{}");
  const found = detectAgents({ home, appData: path.join(home, "AppData") });
  assert.deepEqual(found.map((a) => a.type), ["claude-code"]);
  assert.equal(found[0].configPath, path.join(home, ".claude.json"));
});

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
