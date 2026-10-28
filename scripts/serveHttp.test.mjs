/**
 * R4: `serve-http.mjs` helpers and `install-mcp --transport http`, end to end against a temp HOME.
 *
 * Pinned: only a server declaring *_HTTP_PORT / *_HTTP_TOKEN can be served; the client registration
 * carries the URL and the header and never the server's env; the env file keeps the stdio values
 * plus the port and a generated token, and a re-run keeps the token; going back to stdio leaves the
 * port and token out of the stdio entry; the task (XML: logon + daily 08:00, not stopped on battery) is
 * only printed unless asked to register.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getServer } from "./lib/manifest.mjs";
import { deployHash, importClosure, nativePackages } from "./lib/deploy.mjs";
import { isLink, removeTree } from "./lib/junctions.mjs";
import { approvalSecretEnvName, approvalSecretFile, deployCheck, deployServer, ensureApprovalSecret, handOffTarget, httpClientEntry, httpEnvNames, isServeHttpFor, listDeploys, ownDeploy, parseListenerPid, pruneDeploys, readEnvFile, resolveServeEntry, restartServer, taskCreateArgs, taskDeniedHint, taskXml, verifyDeploy, writeEnvFile } from "./serve-http.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "serve-http-test-"));
test.after(() => removeTree(TMP)); // it holds junctions: unlink them, never walk them

test("only a server declaring both http vars can be served", () => {
  assert.deepEqual(httpEnvNames(getServer("codebase-index")), {
    port: "CODEBASE_INDEX_HTTP_PORT",
    token: "CODEBASE_INDEX_HTTP_TOKEN"
  });
  assert.equal(httpEnvNames(getServer("postgres-mcp")), null);
});

test("the client entry is a loopback URL plus the header — no command, no env", () => {
  assert.deepEqual(httpClientEntry("7341", "abc"), {
    type: "http",
    url: "http://127.0.0.1:7341/mcp",
    headers: { Authorization: "Bearer abc" }
  });
});

test("the env file round-trips and refuses a shape it does not know", () => {
  const file = path.join(TMP, "unit", "x.env.json");
  writeEnvFile(file, { A: "1" });
  assert.deepEqual(readEnvFile(file), { A: "1" });
  assert.equal(readEnvFile(path.join(TMP, "absent.json")), null);
  fs.writeFileSync(file, "[]");
  assert.throws(() => readEnvFile(file));
});

test("the task is registered from XML: logon + daily 08:00, battery-proof, no time limit, full args", () => {
  const server = getServer("codebase-index");
  const longLog = `C:/${"deep/".repeat(60)}codebase-index.log`;
  const xml = taskXml(server, { envFile: "C:/e.json", logFile: longLog, node: "N", script: "S", user: "HOST\\me" });
  assert.match(xml, /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>HOST\\me<\/UserId>/);
  assert.match(xml, /<CalendarTrigger>\s*<StartBoundary>[^<]*T08:00:00<\/StartBoundary>[\s\S]*<DaysInterval>1<\/DaysInterval>/);
  assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.doesNotMatch(xml, /<Repetition>|<RestartOnFailure>/);
  assert.match(xml, /<Command>conhost\.exe<\/Command>/);
  assert.ok(longLog.length > 261);
  assert.ok(
    xml.includes(`<Arguments>--headless &quot;N&quot; &quot;S&quot; --server codebase-index --config &quot;C:/e.json&quot; --log &quot;${longLog}&quot;</Arguments>`),
    "the --log path is whole"
  );
  assert.deepEqual(taskCreateArgs(server, { xmlFile: "C:/t.xml" }), ["/Create", "/TN", "mcp-local\\codebase-index-http", "/XML", "C:/t.xml", "/F"]);
});

test("a denied register names the elevated-task cause and the one-time delete", () => {
  const hint = taskDeniedHint(getServer("codebase-index"));
  assert.match(hint, /Access is denied/);
  assert.match(hint, /ELEVATED prompt: schtasks \/Delete \/TN "mcp-local\\codebase-index-http" \/F/);
});

test("--task print prints and registers nothing; a server without http vars is refused", () => {
  const print = spawnSync(process.execPath, [path.join(ROOT, "scripts/serve-http.mjs"), "--server", "codebase-index", "--task", "print"], { encoding: "utf8" });
  assert.equal(print.status, 0, print.stderr);
  assert.match(print.stdout, /schtasks \/Create \/TN mcp-local\\codebase-index-http \/XML \S+ \/F/);
  assert.match(print.stdout, /<LogonTrigger>/);
  const refused = spawnSync(process.execPath, [path.join(ROOT, "scripts/serve-http.mjs"), "--server", "postgres-mcp"], { encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(`${refused.stdout}${refused.stderr}`, /cannot be served over HTTP/);
});

test("install --transport http, a re-run, and back to stdio", () => {
  const home = path.join(TMP, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: {}, projects: {} }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(TMP, "appdata"), INIT_CWD: ROOT };
  delete env.CLAUDE_CONFIG_DIR;
  const probe = spawnSync(process.execPath, ["-e", "process.stdout.write(require('os').homedir())"], { env, encoding: "utf8" });
  assert.equal(path.resolve(probe.stdout), path.resolve(home), "refusing to run against the real home");

  const install = (...args) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/install-mcp.mjs"), "--yes", "--skip-build", "--skip-smoke", "--skill", "none", "--server", "codebase-index", ...args], { env, encoding: "utf8", timeout: 120_000, input: "" });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    return `${r.stdout}${r.stderr}`;
  };
  const entry = () => JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).mcpServers["codebase-index"];
  const envFile = path.join(home, ".claude", "mcp", "http", "codebase-index.env.json");

  const out = install("--transport", "http", "--port", "7399");
  const first = entry();
  assert.equal(first.type, "http");
  assert.equal(first.url, "http://127.0.0.1:7399/mcp");
  assert.equal(first.command, undefined);
  assert.equal(first.env, undefined, "the client registration must not carry the server's env");
  const served = readEnvFile(envFile);
  assert.equal(served.CODEBASE_INDEX_HTTP_PORT, "7399");
  assert.match(served.CODEBASE_INDEX_HTTP_TOKEN, /^[0-9a-f]{64}$/);
  assert.equal(first.headers.Authorization, `Bearer ${served.CODEBASE_INDEX_HTTP_TOKEN}`);
  assert.ok(served.CODEBASE_INDEX_ALLOWED_ROOTS, "the stdio values travel to the env file");
  assert.doesNotMatch(out, new RegExp(served.CODEBASE_INDEX_HTTP_TOKEN), "the token is never printed");

  install("--transport", "http");
  assert.equal(readEnvFile(envFile).CODEBASE_INDEX_HTTP_TOKEN, served.CODEBASE_INDEX_HTTP_TOKEN, "a re-run keeps the token");
  assert.equal(entry().url, "http://127.0.0.1:7399/mcp", "a re-run keeps the port");

  install("--transport", "stdio");
  const back = entry();
  assert.equal(back.type, undefined);
  assert.equal(back.command, "node");
  assert.equal(back.env.CODEBASE_INDEX_HTTP_TOKEN, undefined);
  assert.equal(back.env.CODEBASE_INDEX_HTTP_PORT, undefined);
  assert.equal(back.env.CODEBASE_INDEX_ALLOWED_ROOTS, served.CODEBASE_INDEX_ALLOWED_ROOTS);
});

test("R4-4': the replaced stdio entry is kept, and a second http run never overwrites it", () => {
  const home = path.join(TMP, "home-snapshot");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: {}, projects: {} }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(TMP, "appdata-snapshot"), INIT_CWD: ROOT };
  delete env.CLAUDE_CONFIG_DIR;
  const probe = spawnSync(process.execPath, ["-e", "process.stdout.write(require('os').homedir())"], { env, encoding: "utf8" });
  assert.equal(path.resolve(probe.stdout), path.resolve(home), "refusing to run against the real home");
  const install = (...args) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/install-mcp.mjs"), "--yes", "--skip-build", "--skip-smoke", "--skill", "none", "--server", "codebase-index", ...args], { env, encoding: "utf8", timeout: 120_000, input: "" });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  };
  const snapshot = path.join(home, ".claude", "mcp", "stdio", "codebase-index.json");

  install("--transport", "stdio");
  const stdioEntry = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).mcpServers["codebase-index"];
  assert.equal(fs.existsSync(snapshot), false, "a stdio install writes no snapshot");

  install("--transport", "http");
  const first = JSON.parse(fs.readFileSync(snapshot, "utf8"));
  assert.deepEqual(first, stdioEntry, "the snapshot is the stdio entry that was replaced");
  assert.equal(first.command, "node");
  assert.equal(first.type, undefined);

  install("--transport", "http");
  const second = JSON.parse(fs.readFileSync(snapshot, "utf8"));
  assert.deepEqual(second, stdioEntry, "the second http run found an http entry and left the snapshot alone");
});

test("MCP-ISSUE-104: the approval secret is created once, reused, and readable by the user alone", () => {
  assert.equal(approvalSecretEnvName(getServer("codebase-index")), "CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET");
  assert.equal(approvalSecretEnvName(getServer("observe-mcp")), null);
  assert.match(approvalSecretFile(getServer("codebase-index")), /[\\/]\.claude[\\/]mcp[\\/]http[\\/]codebase-index\.approval-secret$/);

  const file = path.join(TMP, "secret-dir", "codebase-index.approval-secret");
  const first = ensureApprovalSecret(file);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(ensureApprovalSecret(file), first, "a restart reuses the stored secret");
  if (process.platform === "win32") {
    const acl = spawnSync("icacls", [file], { encoding: "utf8" }).stdout;
    const entries = acl
      .split(/\r?\n/)
      .map((l) => l.replace(file, "").trim())
      .filter((l) => /:\(/.test(l));
    const user = os.userInfo().username.toLowerCase();
    assert.equal(entries.length, 1, `only one ACL entry: ${acl}`);
    assert.ok(entries[0].toLowerCase().split(":")[0].split("\\").pop() === user, `the entry is the user's: ${entries[0]}`);
    assert.ok(!/\(I\)/.test(acl), "no inherited entries");
  } else {
    assert.equal(fs.statSync(file).mode & 0o077, 0, "no group / other bits");
  }

  fs.writeFileSync(file, "short\n");
  assert.throws(() => ensureApprovalSecret(file), /no usable secret/);

  // A start that stopped between creating the (empty, restricted) file and writing the secret: start over.
  fs.writeFileSync(file, "");
  assert.match(ensureApprovalSecret(file), /^[0-9a-f]{64}$/);
});

const NETSTAT = (pid) => `Active Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n  TCP    127.0.0.1:7341         0.0.0.0:0              LISTENING       ${pid}\r\n  TCP    127.0.0.1:7342         0.0.0.0:0              LISTENING       999\r\n`;

test("parseListenerPid picks the LISTENING pid for exactly that port", () => {
  assert.equal(parseListenerPid(NETSTAT(111), 7341), 111);
  assert.equal(parseListenerPid(NETSTAT(111), "7342"), 999);
  assert.equal(parseListenerPid(NETSTAT(111), 734), null);
});

const SUP = (key) => `"C:\\Program Files\\nodejs\\node.exe" D:\\ws\\scripts\\serve-http.mjs --server ${key} --config C:\\e.json`;

/**
 * A stubbed machine for `restartServer`: `procs` maps pid -> { parent, cmd, created }; the listener moves
 * from `listener` to `next` once taskkill and then schtasks run. Every call is recorded in `calls`.
 */
function fakeMachine(procs, { listener = 111, next = 222, start = 5000 } = {}) {
  const state = { listener, calls: [] };
  state.exec = (cmd, args) => {
    state.calls.push([cmd, ...args]);
    const a = args.join(" ");
    if (cmd === "netstat") return NETSTAT(state.listener ?? 0).replace(/LISTENING\s+0/, "TIME_WAIT      0");
    if (cmd === "taskkill") { state.listener = null; return ""; }
    if (cmd === "schtasks") { state.listener = next; return ""; }
    if (a.includes("ConvertTo-Json")) {
      const p = procs[a.match(/ProcessId=(\d+)/)[1]];
      return p ? JSON.stringify(p) : "";
    }
    return `${start}\r\n`; // a start time
  };
  return state;
}

test("--restart kills the supervisor tree, runs the task and returns old -> new pid", async () => {
  const server = getServer("codebase-index");
  const m = fakeMachine({ 111: { parent: 50, cmd: "node index.js", created: 3 }, 50: { parent: 7, cmd: SUP("codebase-index"), created: 2 }, 7: { parent: 1, cmd: "explorer.exe", created: 1 } });
  let clock = 1000;
  const out = await restartServer(server, 7341, { exec: m.exec, sleep: async () => { clock += 10; }, now: () => clock });
  assert.deepEqual(out, { oldPid: 111, newPid: 222 });
  assert.deepEqual(m.calls.find((c) => c[0] === "taskkill"), ["taskkill", "/T", "/F", "/PID", "50"]);
  assert.deepEqual(m.calls.find((c) => c[0] === "schtasks"), ["schtasks", "/Run", "/TN", "mcp-local\\codebase-index-http"]);
  assert.ok(m.calls.findIndex((c) => c[0] === "taskkill") < m.calls.findIndex((c) => c[0] === "schtasks"));
});

test("--restart does not accept the old pid or a stale start time as the new listener", async () => {
  const server = getServer("codebase-index");
  const m = fakeMachine({ 333: { parent: 50, cmd: "node index.js", created: 3 }, 50: { parent: 0, cmd: SUP("codebase-index"), created: 2 } }, { listener: 333, next: 333, start: 10 });
  m.exec = ((inner) => (cmd, args) => (cmd === "taskkill" ? "" : inner(cmd, args)))(m.exec); // the port never frees
  let clock = 1000;
  await assert.rejects(
    restartServer(server, 7341, { exec: m.exec, sleep: async () => { clock += 100; }, now: () => clock, timeoutMs: 1000 }),
    /no new listener on port 7341/
  );
});

test("--restart kills from the hand-off serve-http when the supervisor runs under one", async () => {
  const server = getServer("codebase-index");
  const m = fakeMachine({
    111: { parent: 50, cmd: "node index.js", created: 30 },
    50: { parent: 40, cmd: SUP("codebase-index").replace("D:\\ws\\scripts", "C:\\deploy\\codebase-index\\abc-1\\scripts"), created: 20 },
    40: { parent: 30, cmd: SUP("codebase-index"), created: 10 },
    30: { parent: 1, cmd: "conhost.exe --headless", created: 5 }
  });
  let clock = 1000;
  const out = await restartServer(server, 7341, { exec: m.exec, sleep: async () => { clock += 10; }, now: () => clock });
  assert.deepEqual(out, { oldPid: 111, newPid: 222 });
  assert.deepEqual(m.calls.find((c) => c[0] === "taskkill"), ["taskkill", "/T", "/F", "/PID", "40"]);
});

test("--restart refuses, and kills nothing, unless the listener's parent is this server's serve-http", async () => {
  const server = getServer("codebase-index");
  const listener = { parent: 50, cmd: "app.exe", created: 30 };
  const cases = [
    ["an unrelated parent", { 111: listener, 50: { parent: 1, cmd: "C:\\Program Files\\App\\launcher.exe", created: 20 } }],
    ["serve-http for another server", { 111: listener, 50: { parent: 1, cmd: SUP("observe-mcp"), created: 20 } }],
    ["a key that only starts the same", { 111: listener, 50: { parent: 1, cmd: SUP("codebase-index-old"), created: 20 } }],
    ["no parent at all", { 111: { ...listener, parent: 0 } }]
  ];
  for (const [what, procs] of cases) {
    const m = fakeMachine(procs);
    await assert.rejects(restartServer(server, 7341, { exec: m.exec, sleep: async () => {} }), /not serve-http\.mjs --server codebase-index — not killing it/, what);
    assert.ok(!m.calls.some((c) => c[0] === "taskkill" || c[0] === "schtasks"), `${what}: nothing killed, nothing run`);
  }
});

test("--restart stops at the supervisor when the hand-off above it is another server's, or younger (a reused pid)", async () => {
  const server = getServer("codebase-index");
  const base = { 111: { parent: 50, cmd: "node index.js", created: 30 }, 50: { parent: 40, cmd: SUP("codebase-index"), created: 20 } };
  for (const grand of [{ parent: 1, cmd: SUP("observe-mcp"), created: 10 }, { parent: 1, cmd: SUP("codebase-index"), created: 25 }, { parent: 1, cmd: "cmd.exe", created: 10 }]) {
    const m = fakeMachine({ ...base, 40: grand });
    let clock = 1000;
    await restartServer(server, 7341, { exec: m.exec, sleep: async () => { clock += 10; }, now: () => clock });
    assert.deepEqual(m.calls.find((c) => c[0] === "taskkill"), ["taskkill", "/T", "/F", "/PID", "50"], grand.cmd);
  }
});

test("isServeHttpFor needs node running serve-http.mjs and exactly this --server key", () => {
  const server = { key: "codebase-index" };
  assert.ok(isServeHttpFor(SUP("codebase-index"), server));
  // The task's conhost names the same words; measured on the live tree, it sits above the supervisor.
  assert.ok(!isServeHttpFor(`"conhost.exe" --headless ${SUP("codebase-index")}`, server));
  assert.ok(!isServeHttpFor(`node other.mjs D:\\ws\\scripts\\serve-http.mjs --server codebase-index`, server));
  assert.ok(isServeHttpFor('node "C:\\a b\\scripts\\serve-http.mjs" --server "codebase-index"', server));
  assert.ok(!isServeHttpFor(SUP("codebase-index-x"), server));
  assert.ok(!isServeHttpFor("node not-serve-http.mjs.bak --server codebase-index", server));
  assert.ok(!isServeHttpFor("node serve-http.mjs", server));
  assert.ok(!isServeHttpFor(null, server));
});

/**
 * V-A: a temp workspace with one server `srv` -> @mcp/sdk -> @mcp/core (and an @mcp/unused it never
 * reaches), third-party deps in the server's and the root's node_modules, @mcp/* linked as npm links them.
 */
function fakeWorkspace() {
  const root = fs.mkdtempSync(path.join(TMP, "ws-"));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const pkg = (dir, name, deps = {}) => write(`${dir}/package.json`, JSON.stringify({ name, type: "module", main: "dist/index.js", dependencies: deps }));
  pkg("packages/core", "@mcp/core");
  write("packages/core/dist/index.js", 'export const core = "core-v1";\n');
  pkg("packages/sdk", "@mcp/sdk", { "@mcp/core": "*" });
  write("packages/sdk/dist/index.js", 'export { core } from "@mcp/core";\nexport { dep } from "rootdep";\n');
  pkg("packages/unused", "@mcp/unused");
  write("packages/unused/dist/index.js", "");
  pkg("srv", "srv", { "@mcp/sdk": "file:../packages/sdk", localdep: "1" });
  write("srv/dist/index.js", 'import { core, dep } from "@mcp/sdk";\nimport { local } from "localdep";\nconsole.log(["srv-v1", core, dep, local].join(" "));\n');
  pkg("srv/node_modules/localdep", "localdep");
  write("srv/node_modules/localdep/index.js", 'export const local = "local";\n');
  write("srv/node_modules/.package-lock.json", "{}");
  pkg("node_modules/rootdep", "rootdep");
  write("node_modules/rootdep/index.js", 'export const dep = "rootdep";\n');
  for (const nm of ["srv/node_modules/@mcp", "node_modules/@mcp"]) fs.mkdirSync(path.join(root, nm), { recursive: true });
  fs.symlinkSync(path.join(root, "packages/sdk"), path.join(root, "srv/node_modules/@mcp/sdk"), "junction");
  for (const p of ["core", "sdk", "unused"]) fs.symlinkSync(path.join(root, "packages", p), path.join(root, "node_modules/@mcp", p), "junction");
  return { root, server: { key: "srv", dir: "srv" }, deployRoot: path.join(root, "..", `${path.basename(root)}-deploy`) };
}

const runEntry = (entry) => spawnSync(process.execPath, [entry], { encoding: "utf-8" });

test("V-A: the deploy copies built output, junctions third-party deps, and runs without the tree's dist", () => {
  const { root, server, deployRoot } = fakeWorkspace();
  const d = deployServer(server, { workspaceRoot: root, deployRoot, sha: "abc123" });
  assert.equal(d.dir, path.join(deployRoot, "srv", "abc123-1"));
  assert.deepEqual(d.packages, ["@mcp/core", "@mcp/sdk"]);
  assert.ok(!fs.existsSync(path.join(d.dir, "packages", "unused")), "a package the server never reaches is not copied");
  assert.ok(!isLink(path.join(d.dir, "srv", "dist")) && fs.existsSync(path.join(d.dir, "srv", "dist", "index.js")));
  assert.ok(isLink(path.join(d.dir, "srv", "node_modules", "localdep")), "third-party code is a junction");
  assert.ok(!isLink(path.join(d.dir, "srv", "node_modules", "@mcp")), "@mcp is a real dir");
  assert.equal(fs.realpathSync(path.join(d.dir, "srv", "node_modules", "@mcp", "sdk")), fs.realpathSync(path.join(d.dir, "packages", "sdk")));
  assert.equal(fs.realpathSync(path.join(d.dir, "node_modules", "@mcp", "core")), fs.realpathSync(path.join(d.dir, "packages", "core")));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(deployRoot, "srv", "current.json"), "utf-8")).dir, d.dir);

  const before = runEntry(d.entry);
  assert.equal(before.status, 0, before.stderr);
  assert.equal(before.stdout.trim(), "srv-v1 core-v1 rootdep local");

  // A rebuild in the tree — the server's dist and a package's — changes nothing in the deploy...
  fs.writeFileSync(path.join(root, "srv/dist/index.js"), 'console.log("srv-v2");\n');
  fs.writeFileSync(path.join(root, "packages/core/dist/index.js"), 'export const core = "core-v2";\n');
  assert.equal(runEntry(d.entry).stdout.trim(), "srv-v1 core-v1 rootdep local");
  // ...until the next deploy.
  const d2 = deployServer(server, { workspaceRoot: root, deployRoot, sha: "abc123" });
  assert.equal(d2.n, 2);
  assert.equal(runEntry(d2.entry).stdout.trim(), "srv-v2");
  assert.equal(resolveServeEntry(server, { deployRoot }).entry, d2.entry);
});

test("V-A: only the newest 2 deploys stay, the running one is spared, and pruning never deletes through a junction", () => {
  const { root, server, deployRoot } = fakeWorkspace();
  const first = deployServer(server, { workspaceRoot: root, deployRoot, sha: "s1" });
  fs.writeFileSync(path.join(deployRoot, "srv", "running.json"), JSON.stringify({ dir: first.dir, sha: "s1", pid: 1 }));
  deployServer(server, { workspaceRoot: root, deployRoot, sha: "s2" });
  deployServer(server, { workspaceRoot: root, deployRoot, sha: "s3" });
  assert.deepEqual(listDeploys(path.join(deployRoot, "srv")).map((x) => `${x.sha}-${x.n}`), ["s3-3", "s2-2", "s1-1"], "the running deploy survives");

  fs.writeFileSync(path.join(deployRoot, "srv", "running.json"), JSON.stringify({ dir: null, pid: 2 }));
  const last = deployServer(server, { workspaceRoot: root, deployRoot, sha: "s4" });
  assert.equal(last.pruned.length, 2);
  assert.deepEqual(listDeploys(path.join(deployRoot, "srv")).map((x) => `${x.sha}-${x.n}`), ["s4-4", "s3-3"]);
  // Every junction target is intact: the tree's node_modules, the root's, and the packages.
  for (const rel of ["srv/node_modules/localdep/index.js", "node_modules/rootdep/index.js", "packages/core/dist/index.js", "packages/sdk/package.json", "srv/dist/index.js"]) {
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel} survived the prune`);
  }
});

test("V-A: an unbuilt server is refused and leaves no deploy behind; no deploy yet serves the tree", () => {
  const { root, server, deployRoot } = fakeWorkspace();
  fs.rmSync(path.join(root, "packages/core/dist"), { recursive: true });
  assert.throws(() => deployServer(server, { workspaceRoot: root, deployRoot, sha: "x" }), /not built — missing .*core/);
  assert.deepEqual(listDeploys(path.join(deployRoot, "srv")), []);
  assert.equal(resolveServeEntry(getServer("codebase-index"), { deployRoot }).deploy, null);
});

test("V-A: doctor's [deploy] verdict names the running copy and a deploy waiting for --restart", () => {
  const cur = { dir: "D/b-2", sha: "b", n: 2 };
  const verify = () => ({ record: { head: "b".repeat(40), dirty: false, stale: [] }, recorded: "f".repeat(64), actual: "f".repeat(64), ok: true });
  const running = { dir: "D/b-2", sha: "b", pid: 9, supervisor: "D/b-2/scripts/serve-http.mjs" };
  assert.deepEqual(deployCheck(cur, running, { verify }), ["pass", "pid 9 runs b (HEAD bbbbbbbbbbbb, clean, hash ffffffffffff) from D/b-2"]);
  assert.match(deployCheck(cur, { ...running, dir: "D/a-1", sha: "a" }, { verify })[1], /deploy b-2 is waiting for --restart/);
  assert.match(deployCheck(cur, { ...running, supervisor: null }, { verify })[1], /supervisor runs from the working tree/);
  assert.match(deployCheck(cur, running, { verify: () => null })[1], /records no copy integrity hash/);
  assert.match(deployCheck(null, { dir: null, pid: 9 })[1], /working tree's dist/);
  assert.equal(deployCheck(cur, null)[0], "warn");
});

test("isolation: a native package and each one that loads it are copied; the rest stay junctions", () => {
  const { root, server, deployRoot } = fakeWorkspace();
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write("srv/node_modules/nat/package.json", JSON.stringify({ name: "nat" }));
  write("srv/node_modules/nat/build/Release/nat.node", "MZ");
  write("srv/node_modules/loader/package.json", JSON.stringify({ name: "loader", optionalDependencies: { "@sc/bin": "1" } }));
  write("srv/node_modules/@sc/bin/package.json", JSON.stringify({ name: "@sc/bin" }));
  write("srv/node_modules/@sc/bin/vec0.dll", "MZ");
  write("srv/node_modules/@sc/plain/package.json", JSON.stringify({ name: "@sc/plain" }));
  write("srv/node_modules/wrap/package.json", JSON.stringify({ name: "wrap", dependencies: { nat: "1" } }));
  write("srv/node_modules/wrap/node_modules/inner/index.js", "");
  assert.deepEqual(nativePackages(path.join(root, "srv/node_modules")), ["@sc/bin", "loader", "nat", "wrap"]);

  const d = deployServer(server, { workspaceRoot: root, deployRoot, sha: "n1" });
  const nm = path.join(d.dir, "srv", "node_modules");
  for (const name of ["nat", "loader", "@sc/bin", "wrap"]) assert.ok(!isLink(path.join(nm, name)) && fs.existsSync(path.join(nm, name, "package.json")), `${name} is copied`);
  assert.ok(fs.existsSync(path.join(nm, "nat", "build", "Release", "nat.node")));
  for (const name of ["localdep", "@sc/plain", "wrap/node_modules/inner"]) assert.ok(isLink(path.join(nm, name)), `${name} stays a junction`);
  assert.ok(!isLink(path.join(nm, "@sc")), "a scope with a copied package is a real dir");
  assert.deepEqual(d.native, { srv: ["@sc/bin", "loader", "nat", "wrap"], ".": [] });
  assert.equal(runEntry(d.entry).stdout.trim(), "srv-v1 core-v1 rootdep local");
});

test("isolation: the supervisor's import closure is what serve-http.mjs imports", () => {
  const closure = importClosure(path.join(ROOT, "scripts", "serve-http.mjs"));
  assert.deepEqual(closure, ["lib/cli.mjs", "lib/deploy.mjs", "lib/junctions.mjs", "lib/log.mjs", "lib/manifest.mjs", "serve-http.mjs"]);
});

/** A minimal @mcp/manifest for the fake workspace: one server `srv` that declares the http vars. */
function addFakeManifest(root) {
  const dir = path.join(root, "packages", "manifest");
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@mcp/manifest", type: "module", main: "dist/index.js", dependencies: { "@mcp/core": "*" } }));
  fs.writeFileSync(
    path.join(dir, "dist", "index.js"),
    'import path from "node:path";\nexport const WORKSPACE_ROOT = process.cwd();\n' +
      'export const SERVERS = [{ key: "srv", dir: "srv", entry: "dist/index.js", env: [{ name: "SRV_HTTP_PORT" }, { name: "SRV_HTTP_TOKEN" }] }];\n' +
      "export const getServer = (k) => SERVERS.find((s) => s.key === k);\nexport const serverKeys = () => SERVERS.map((s) => s.key);\n" +
      "export const serverEntryPath = (s) => path.join(WORKSPACE_ROOT, s.dir, s.entry);\n"
  );
  fs.symlinkSync(dir, path.join(root, "node_modules/@mcp/manifest"), "junction");
}

test("isolation: the supervisor is copied with its closure and runs with the working tree gone", () => {
  const { root, server, deployRoot } = fakeWorkspace();
  addFakeManifest(root);
  const d = deployServer(server, { workspaceRoot: root, deployRoot, sha: "sup1" });
  assert.equal(d.supervisor, path.join(d.dir, "scripts", "serve-http.mjs"));
  assert.deepEqual(d.supervisorPackages, ["@mcp/core", "@mcp/manifest"]);
  assert.deepEqual(d.packages, ["@mcp/core", "@mcp/sdk"], "the server's own closure is recorded apart");
  assert.equal(ownDeploy(d.supervisor)?.dir, d.dir);
  assert.equal(ownDeploy(path.join(ROOT, "scripts", "serve-http.mjs")), null, "the tree's copy is not a deploy");

  // Move the tree away: the copied supervisor resolves everything it loads inside the deploy.
  const moved = `${root}-moved`;
  fs.renameSync(root, moved);
  try {
    const r = spawnSync(process.execPath, [d.supervisor, "--server", "srv", "--task", "print"], { cwd: d.dir, encoding: "utf-8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout + r.stderr, /<Task version="1\.2"/);
  } finally {
    fs.renameSync(moved, root);
  }
});

const git = (root, ...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf-8" });

test("isolation: the record proves the copy — HEAD, dirty, stale, and a hash doctor recomputes", () => {
  const { root, server, deployRoot } = fakeWorkspace();
  fs.mkdirSync(path.join(root, "srv", "src"));
  fs.writeFileSync(path.join(root, "srv", "src", "index.ts"), "// v1\n");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(root, "srv", "src", "index.ts"), old, old);
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\ndist/\n");
  for (const args of [["init", "-q"], ["add", ".gitignore", "srv/package.json", "srv/src/index.ts", "packages/core/package.json", "packages/sdk/package.json", "packages/unused/package.json"], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]]) {
    assert.equal(git(root, ...args).status, 0);
  }
  const head = git(root, "rev-parse", "HEAD").stdout.trim();

  const clean = deployServer(server, { workspaceRoot: root, deployRoot });
  assert.equal(clean.head, head);
  assert.equal(clean.sha, head.slice(0, 12));
  assert.equal(clean.dirty, false);
  assert.deepEqual(clean.stale, []);
  assert.match(clean.hash, /^[0-9a-f]{64}$/);
  assert.equal(deployHash(clean.dir), clean.hash);
  const running = { dir: clean.dir, sha: clean.sha, pid: 9, supervisor: clean.supervisor };
  assert.equal(deployCheck(clean, running)[0], "pass", deployCheck(clean, running)[1]);

  // A file of the copy changed after the deploy: the hash no longer matches, and doctor fails it.
  fs.appendFileSync(path.join(clean.dir, "srv", "dist", "index.js"), "// patched\n");
  const [status, msg] = deployCheck(clean, running);
  assert.equal(status, "fail");
  assert.match(msg, /changed after the deploy/);
  assert.equal(verifyDeploy(clean.dir).ok, false);

  // An uncommitted edit and a src newer than dist: both recorded, both warned.
  fs.writeFileSync(path.join(root, "srv", "src", "index.ts"), "// v2, not built\n");
  const dirty = deployServer(server, { workspaceRoot: root, deployRoot });
  assert.equal(dirty.dirty, true);
  assert.deepEqual(dirty.stale, ["srv"]);
  assert.equal(dirty.hash, clean.hash, "same dist copied: same hash, whatever the label");
  const [s2, m2] = deployCheck(dirty, { ...running, dir: dirty.dir });
  assert.equal(s2, "warn");
  assert.match(m2, /dirty/);
  assert.match(m2, /uncommitted changes/);
  assert.match(m2, /stale build of srv/);
});

test("isolation: a nested native package is copied, and so is the package holding it; prune keeps the tree intact", () => {
  const { root, server, deployRoot } = fakeWorkspace();
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  // tree-sitter-typescript/node_modules/tree-sitter-javascript ships its own win32 .node.
  write("srv/node_modules/outer/package.json", JSON.stringify({ name: "outer" }));
  write("srv/node_modules/outer/node_modules/innernat/package.json", JSON.stringify({ name: "innernat" }));
  write("srv/node_modules/outer/node_modules/innernat/prebuilds/win32-x64/innernat.node", "MZ");
  write("srv/node_modules/outer/node_modules/innerjs/index.js", "");
  assert.deepEqual(nativePackages(path.join(root, "srv/node_modules")), ["outer"]);

  const first = deployServer(server, { workspaceRoot: root, deployRoot, sha: "q1" });
  const outer = path.join(first.dir, "srv", "node_modules", "outer");
  assert.ok(!isLink(outer), "the package holding a native one is copied");
  assert.ok(!isLink(path.join(outer, "node_modules")) && !isLink(path.join(outer, "node_modules", "innernat")), "the nested native package is copied");
  assert.ok(fs.existsSync(path.join(outer, "node_modules", "innernat", "prebuilds", "win32-x64", "innernat.node")));
  assert.ok(isLink(path.join(outer, "node_modules", "innerjs")), "a nested plain package stays a junction");

  deployServer(server, { workspaceRoot: root, deployRoot, sha: "q2" });
  const third = deployServer(server, { workspaceRoot: root, deployRoot, sha: "q3", inUse: () => false });
  assert.deepEqual(third.pruned, [first.dir]);
  for (const rel of ["srv/node_modules/outer/node_modules/innerjs/index.js", "srv/node_modules/outer/node_modules/innernat/prebuilds/win32-x64/innernat.node", "srv/node_modules/localdep/index.js"]) {
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel} survived the prune`);
  }
});

test("prune skips a deploy a live process still names, and leaves it whole", () => {
  const { root, server, deployRoot } = fakeWorkspace();
  const first = deployServer(server, { workspaceRoot: root, deployRoot, sha: "u1" });
  deployServer(server, { workspaceRoot: root, deployRoot, sha: "u2" });
  const asked = [];
  const third = deployServer(server, { workspaceRoot: root, deployRoot, sha: "u3", inUse: (dir) => (asked.push(dir), dir === first.dir) });
  assert.deepEqual(asked, [first.dir]);
  assert.deepEqual(third.pruned, []);
  assert.ok(fs.existsSync(path.join(first.dir, "srv", "dist", "index.js")), "the in-use deploy keeps its JS");
  assert.equal(pruneDeploys(server, { deployRoot, inUse: () => false }).length, 1, "the next prune removes it once free");
});

// A real mapped binary: Windows refuses to delete it (EPERM), so the deploy must lose nothing.
const REAL_NATIVE = path.join(ROOT, "codebase-index-mcp", "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
test("prune of a deploy whose native file is mapped leaves the deploy intact", { skip: process.platform !== "win32" || !fs.existsSync(REAL_NATIVE) }, async () => {
  const { root, server, deployRoot } = fakeWorkspace();
  fs.mkdirSync(path.join(root, "srv/node_modules/nat/build/Release"), { recursive: true });
  fs.writeFileSync(path.join(root, "srv/node_modules/nat/package.json"), JSON.stringify({ name: "nat" }));
  fs.copyFileSync(REAL_NATIVE, path.join(root, "srv/node_modules/nat/build/Release/nat.node"));
  const first = deployServer(server, { workspaceRoot: root, deployRoot, sha: "m1" });
  const mapped = path.join(first.dir, "srv", "node_modules", "nat", "build", "Release", "nat.node");
  const child = spawn(process.execPath, ["-e", `process.dlopen({ exports: {} }, ${JSON.stringify(mapped)}); console.log("loaded"); setInterval(() => {}, 1000)`], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("exit", (code) => reject(new Error(`the loader exited ${code}`)));
    });
    deployServer(server, { workspaceRoot: root, deployRoot, sha: "m2" });
    // inUse says free (running.json lied): the mapped binary itself must stop the delete.
    const third = deployServer(server, { workspaceRoot: root, deployRoot, sha: "m3", inUse: () => false });
    assert.deepEqual(third.pruned, []);
    for (const rel of ["srv/dist/index.js", "srv/package.json", "packages/core/dist/index.js", "srv/node_modules/nat/build/Release/nat.node", "deploy.json"]) {
      assert.ok(fs.existsSync(path.join(first.dir, rel)), `${rel} is still in the deploy`);
    }
  } finally {
    child.kill();
    await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", resolve)));
  }
  assert.equal(pruneDeploys(server, { deployRoot, inUse: () => false }).length, 1, "removed once unmapped");
});

test("hand-off: only to a current deploy whose supervisor copy exists, and never from a deploy", () => {
  const { root, server, deployRoot } = fakeWorkspace();
  assert.equal(handOffTarget(server, { deployRoot, own: null }), null, "no deploy yet: serve from here");
  const d = deployServer(server, { workspaceRoot: root, deployRoot, sha: "h1" });
  assert.equal(handOffTarget(server, { deployRoot, own: null })?.dir, d.dir);
  assert.equal(handOffTarget(server, { deployRoot, own: d }), null, "a deploy's own supervisor serves");
  fs.rmSync(d.supervisor);
  assert.equal(handOffTarget(server, { deployRoot, own: null }), null, "a missing supervisor copy: serve from here");
  const cur = path.join(deployRoot, "srv", "current.json");
  fs.writeFileSync(cur, JSON.stringify({ ...JSON.parse(fs.readFileSync(cur, "utf-8")), supervisor: null }));
  assert.equal(handOffTarget(server, { deployRoot, own: null }), null, "a deploy made before the supervisor copy: serve from here");
});
