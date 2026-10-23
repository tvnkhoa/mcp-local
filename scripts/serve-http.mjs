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
 * `--task register` runs `schtasks /Create` for a per-user ONLOGON task (no elevation, replaced if
 * present). It is the only thing here that changes the machine, and only when asked by name.
 */

import { execFileSync, spawn } from "node:child_process";
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

/** The client registration for a served server: URL plus header, never the server's env. */
export function httpClientEntry(port, token) {
  return { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } };
}

function taskName(server) {
  return `mcp-local\\${server.key}-http`;
}

/**
 * The schtasks arguments for the logon task. `conhost --headless` keeps a console window from
 * opening at every logon; the process still gets a console, which node needs for its stdio.
 */
export function taskCreateArgs(server, { envFile, logFile, node = process.execPath, script = SCRIPT }) {
  const command = `conhost.exe --headless "${node}" "${script}" --server ${server.key} --config "${envFile}" --log "${logFile}"`;
  return ["/Create", "/TN", taskName(server), "/SC", "ONLOGON", "/RL", "LIMITED", "/F", "/TR", command];
}

function runTask(server, mode, envFile, logFile) {
  if (mode === "print" || mode === "register") {
    const args = taskCreateArgs(server, { envFile, logFile });
    info(`schtasks ${args.map((a) => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ")}`);
    if (mode === "register") {
      execFileSync("schtasks", args, { stdio: "inherit" });
      ok(`Registered ${taskName(server)} (runs at logon). Start it now with: schtasks /Run /TN "${taskName(server)}"`);
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
  const stderr = logFile ? fs.openSync(logFile, "a") : "inherit";
  // Inherit PATH and the like; every server setting comes from the env file and wins.
  const child = spawn(process.execPath, [serverEntryPath(server), "--transport", "http"], {
    env: { ...process.env, ...env },
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
