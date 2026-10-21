// Shared CLI arg parsing + server resolution for the root MCP scripts.
// Keeps the --server / --all handling and the unknown-server error text
// identical across install / doctor / uninstall / update.

import { SERVERS, getServer, serverKeys } from "./manifest.mjs";
import { err, info } from "./log.mjs";

// Parse argv into { servers: string[], ...booleans }.
// boolFlags maps a canonical name to its accepted tokens, e.g.
//   { yes: ["--yes", "-y"], skipSmoke: ["--skip-smoke"] }
// valueFlags maps a canonical name to the tokens that take a value (`--scope local` or
// `--scope=local`), e.g. { scope: ["--scope"] }. An absent value flag is `null`.
export function parseArgs(argv, boolFlags = {}, valueFlags = {}) {
  const out = { servers: [] };
  for (const name of Object.keys(boolFlags)) out[name] = false;
  for (const name of Object.keys(valueFlags)) out[name] = null;

  outer: for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--server") { const v = argv[++i]; if (v) out.servers.push(v); continue; }
    if (a.startsWith("--server=")) { out.servers.push(a.slice("--server=".length)); continue; }
    for (const [name, tokens] of Object.entries(valueFlags)) {
      for (const t of tokens) {
        if (a === t) { const v = argv[++i]; if (v !== undefined) out[name] = v; continue outer; }
        if (a.startsWith(`${t}=`)) { out[name] = a.slice(t.length + 1); continue outer; }
      }
    }
    for (const [name, tokens] of Object.entries(boolFlags)) {
      if (tokens.includes(a)) { out[name] = true; break; }
    }
  }
  return out;
}

// Resolve requested keys to server objects.
//   allowAllDefault: no --server given → all servers (install/doctor)
//   all:             an explicit --all flag was passed (uninstall/update)
// Exits the process with a clear message on an unknown or missing selection.
export function resolveServers(keys, { allowAllDefault = false, all = false } = {}) {
  if (all || (allowAllDefault && keys.length === 0)) return SERVERS;
  if (keys.length === 0) {
    err("Specify --server <key> or --all");
    info(`Known servers: ${serverKeys().join(", ")}`);
    process.exit(1);
  }
  return keys.map((k) => {
    const s = getServer(k);
    if (!s) { err(`Unknown server '${k}'. Known servers: ${serverKeys().join(", ")}`); process.exit(1); }
    return s;
  });
}
