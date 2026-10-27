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
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getServer } from "./lib/manifest.mjs";
import { approvalSecretEnvName, approvalSecretFile, ensureApprovalSecret, httpClientEntry, httpEnvNames, readEnvFile, taskCreateArgs, taskDeniedHint, taskXml, writeEnvFile } from "./serve-http.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "serve-http-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

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
