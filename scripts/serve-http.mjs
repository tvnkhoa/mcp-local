#!/usr/bin/env node

/**
 * Serve one MCP server over streamable HTTP, so every Claude session shares one process (R4).
 *
 *   node scripts/serve-http.mjs --server codebase-index                 # run it (foreground)
 *   node scripts/serve-http.mjs --server codebase-index --log <file>    # stderr to a file
 *   node scripts/serve-http.mjs --server codebase-index --task print    # the logon task, printed
 *   node scripts/serve-http.mjs --server codebase-index --task register # ... and registered
 *   node scripts/serve-http.mjs --server codebase-index --task unregister
 *
 * Flags: --config <path> (default ~/.claude/mcp/http/<key>.env.json), --log <path>.
 *
 * The served process takes its whole env from the env file, `{ "env": { ... } }`, which
 * `install-mcp --transport http` writes: the same values a stdio registration would carry, plus
 * `<PREFIX>_HTTP_PORT` and `<PREFIX>_HTTP_TOKEN`. A client registration then holds only the URL
 * and the Authorization header. Only a server whose manifest declares both vars can be served.
 *
 * The listener is 127.0.0.1 only, behind a Host/Origin allow-list and the bearer token — see
 * packages/sdk/src/httpTransport.ts. A second copy on the same port fails with EADDRINUSE, which is
 * what keeps it to one process.
 *
 * `--task register` runs `schtasks /Create /XML` for a per-user task at logon and daily 08:00 (no
 * elevation, replaced if present). It is the only thing here that changes the machine, and only when asked by name.
 */

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { serverEntryPath } from "./lib/manifest.mjs";
import { parseArgs, resolveServers } from "./lib/cli.mjs";
import { err, info, ok } from "./lib/log.mjs";

const SCRIPT = fileURLToPath(import.meta.url);

/** The server's HTTP env var names, or null when it cannot be served over HTTP. */
export function httpEnvNames(server) {
  const port = server.env.find((f) => f.name.endsWith("_HTTP_PORT"))?.name;
  const token = server.env.find((f) => f.name.endsWith("_HTTP_TOKEN"))?.name;
  return port && token ? { port, token } : null;
}

export function httpStateDir() {
  return path.join(os.homedir(), ".claude", "mcp", "http");
}

export function defaultEnvFile(server) {
  return path.join(httpStateDir(), `${server.key}.env.json`);
}

/**
 * R4-4': where install-mcp keeps the stdio entry it replaced, so a `*-stdio` profile in
 * ~/.claude/mcp/build-profiles.mjs can still build a per-session stdio server after the switch.
 */
export function stdioSnapshotFile(server) {
  return path.join(os.homedir(), ".claude", "mcp", "stdio", `${server.key}.json`);
}

/** A stdio entry: it has a command and is not an http registration. */
export function isStdioEntry(entry) {
  return entry !== null && typeof entry === "object" && typeof entry.command === "string" && entry.type !== "http";
}

export function defaultLogFile(server) {
  return path.join(httpStateDir(), `${server.key}.log`);
}

/** `{ env }` from the env file, or null when there is none. Throws on a malformed one. */
export function readEnvFile(file) {
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (parsed === null || typeof parsed !== "object" || typeof parsed.env !== "object") {
    throw new Error(`${file}: expected { "env": { ... } }`);
  }
  return parsed.env;
}

/** Written owner-only where the platform honours a mode; it holds the token and any secrets. */
export function writeEnvFile(file, env) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ env }, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
}

/** MCP-ISSUE-104: the server's refactor approval secret var, or null when it has none. */
export function approvalSecretEnvName(server) {
  return server.env.find((f) => f.name.endsWith("_REFACTOR_APPROVAL_SECRET"))?.name ?? null;
}

export function approvalSecretFile(server) {
  return path.join(httpStateDir(), `${server.key}.approval-secret`);
}

/**
 * MCP-ISSUE-104: the served process's refactor approval secret, created once and reused, so tokens and
 * previews outlive a restart. The file is the user's alone: mode 0600, and on Windows (which ignores the mode)
 * icacls drops inherited entries and grants only the current user. A file that cannot be locked down is
 * removed and the supervisor refuses to serve.
 */
export function ensureApprovalSecret(file, { user = currentUser(), platform = process.platform } = {}) {
  if (fs.existsSync(file)) {
    const secret = fs.readFileSync(file, "utf-8").trim();
    if (secret.length >= 32) return secret;
    // Empty: a previous start stopped between creating the file and writing the secret. Start over.
    if (secret.length > 0) throw new Error(`${file} holds no usable secret — delete it and restart to generate a new one`);
    fs.rmSync(file, { force: true });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Created EMPTY and restricted first, so the secret is never on disk under the folder's inherited ACL.
  fs.writeFileSync(file, "", { encoding: "utf-8", mode: 0o600, flag: "wx" });
  if (platform === "win32") {
    try {
      execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], { stdio: "ignore" });
    } catch (e) {
      fs.rmSync(file, { force: true });
      throw new Error(`could not restrict ${file} to ${user}: ${e.message}`, { cause: e });
    }
  }
  const secret = randomBytes(32).toString("hex");
  fs.writeFileSync(file, `${secret}\n`, { encoding: "utf-8" });
  return secret;
}

/** The client registration for a served server: URL plus header, never the server's env. */
export function httpClientEntry(port, token) {
  return { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } };
}

function taskName(server) {
  return `mcp-local\\${server.key}-http`;
}

const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The task definition, registered from XML because `schtasks /Create` flags cannot express it: the
 * flag form refuses to start on battery, is killed when the laptop leaves AC, has a 72 h execution
 * limit and cuts /TR at 261 characters. Triggers: logon of the current user, plus daily 08:00 with
 * StartWhenAvailable so a missed 08:00 runs on wake. No repetition, no restart-on-failure: a shutdown
 * ends the server and the next logon or morning starts it. `conhost --headless` keeps a console
 * window from opening; the process still gets a console, which node needs for its stdio.
 */
export function taskXml(server, { envFile, logFile, node = process.execPath, script = SCRIPT, user = currentUser() }) {
  const args = `--headless "${node}" "${script}" --server ${server.key} --config "${envFile}" --log "${logFile}"`;
  const u = xmlEscape(user);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${u}</UserId>
    </LogonTrigger>
    <CalendarTrigger>
      <StartBoundary>2026-01-01T08:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${u}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>conhost.exe</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function currentUser() {
  const name = os.userInfo().username;
  return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${name}` : name;
}

/** The schtasks arguments that register the task from an XML file (no elevation, replaced if present). */
export function taskCreateArgs(server, { xmlFile }) {
  return ["/Create", "/TN", taskName(server), "/XML", xmlFile, "/F"];
}

/**
 * "Access is denied" on /Create /F is not the XML: a task first registered from an elevated prompt
 * keeps an ACL that gives its user read only, so a non-elevated session can neither replace nor
 * delete it (a task this script created is the user's to replace). Remove it once, elevated.
 */
export function taskDeniedHint(server) {
  return `If this was "Access is denied" and ${taskName(server)} already exists, it was created elevated and a normal prompt cannot replace it. Once, from an ELEVATED prompt: schtasks /Delete /TN "${taskName(server)}" /F — then re-run --task register.`;
}

function runTask(server, mode, envFile, logFile) {
  if (mode === "print" || mode === "register") {
    const xml = taskXml(server, { envFile, logFile });
    const xmlFile = path.join(os.tmpdir(), `${server.key}-http-task.xml`);
    const args = taskCreateArgs(server, { xmlFile });
    info(`schtasks ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`);
    info(xml);
    if (mode === "register") {
      // schtasks reads UTF-16 LE with a BOM.
      fs.writeFileSync(xmlFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]));
      try {
        execFileSync("schtasks", args, { stdio: "inherit" });
      } catch (e) {
        throw new Error(`${e.message}\n${taskDeniedHint(server)}`, { cause: e });
      } finally {
        fs.rmSync(xmlFile, { force: true });
      }
      ok(`Registered ${taskName(server)} (at logon and daily 08:00). Start it now with: schtasks /Run /TN "${taskName(server)}"`);
    }
    return;
  }
  if (mode === "unregister") {
    execFileSync("schtasks", ["/Delete", "/TN", taskName(server), "/F"], { stdio: "inherit" });
    ok(`Removed ${taskName(server)}`);
    return;
  }
  throw new Error(`--task must be print, register or unregister, got ${mode}`);
}

function serve(server, envFile, logFile) {
  const names = httpEnvNames(server);
  const env = readEnvFile(envFile);
  if (env === null) {
    throw new Error(`no env file at ${envFile} — run: node scripts/install-mcp.mjs --server ${server.key} --transport http`);
  }
  if (!env[names.port] || !env[names.token]) {
    throw new Error(`${envFile} must set ${names.port} and ${names.token}`);
  }
  // MCP-ISSUE-104: a secret the env file sets wins; otherwise the persisted one (the server refuses HTTP without).
  const secretName = approvalSecretEnvName(server);
  const secretEnv = secretName && !env[secretName] ? { [secretName]: ensureApprovalSecret(approvalSecretFile(server)) } : {};
  const stderr = logFile ? fs.openSync(logFile, "a") : "inherit";
  // Inherit PATH and the like; every server setting comes from the env file and wins.
  const child = spawn(process.execPath, [serverEntryPath(server), "--transport", "http"], {
    env: { ...process.env, ...env, ...secretEnv },
    stdio: ["ignore", "ignore", stderr]
  });
  info(`${server.key}: serving on http://127.0.0.1:${env[names.port]}/mcp (pid ${child.pid})`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => {
    if (code !== 0) err(`${server.key}: exited ${signal ?? code}${logFile ? ` — see ${logFile}` : ""}`);
    process.exit(code ?? 1);
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2), {}, { config: ["--config"], log: ["--log"], task: ["--task"] });
  if (args.servers.length !== 1) throw new Error("pass exactly one --server <key>");
  const [server] = resolveServers(args.servers);
  if (httpEnvNames(server) === null) {
    throw new Error(`${server.key} declares no *_HTTP_PORT / *_HTTP_TOKEN env vars — it cannot be served over HTTP`);
  }
  const envFile = path.resolve(args.config ?? defaultEnvFile(server));
  const logFile = args.log ? path.resolve(args.log) : null;
  if (args.task) {
    runTask(server, args.task, envFile, logFile ?? defaultLogFile(server));
    return;
  }
  serve(server, envFile, logFile);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (e) {
    err(e.message);
    process.exit(1);
  }
}
