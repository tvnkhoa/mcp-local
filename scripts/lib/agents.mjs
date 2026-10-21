// Detect installed code agents and read/write their MCP server config.
// Generalized from codebase-index-mcp/scripts/setup.mjs (was hardcoded to one server).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  readJsonc,
  writeFileAtomic,
  hasJsoncComments,
  editJsoncText,
  stripJsoncComments,
  stripTrailingCommas,
  toConfigPath,
} from "./jsonc.mjs";
import { ok, warn, err, info } from "./log.mjs";

// Returns [{ name, type, configPath }] for every agent config found on this machine.
// type ∈ "claude-code" | "claude" | "vscode" | "opencode"
// `home` / `appData` exist so tests can point detection at a temp directory.
export function detectAgents({
  home = os.homedir(),
  appData = process.env.APPDATA || path.join(home, "AppData", "Roaming"),
} = {}) {
  const detected = [];

  // Claude Code — MCP servers live in ~/.claude.json (state), not settings.json.
  const ccState = path.join(home, ".claude.json");
  const ccSettings = path.join(home, ".claude", "settings.json");
  if (fs.existsSync(ccState) || fs.existsSync(ccSettings)) {
    detected.push({ name: "Claude Code", type: "claude-code", configPath: ccState });
  }

  for (const p of [
    path.join(appData, "Claude", "claude_desktop_config.json"),
    path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    path.join(home, ".config", "Claude", "claude_desktop_config.json"),
  ]) {
    if (fs.existsSync(p)) { detected.push({ name: "Claude Desktop", type: "claude", configPath: p }); break; }
  }

  for (const p of [
    path.join(appData, "Code", "User", "settings.json"),
    path.join(home, "Library", "Application Support", "Code", "User", "settings.json"),
    path.join(home, ".config", "Code", "User", "settings.json"),
  ]) {
    if (fs.existsSync(p)) { detected.push({ name: "VS Code", type: "vscode", configPath: p }); break; }
  }

  for (const p of [
    path.join(home, ".config", "opencode", "opencode.json"),
    path.join(home, ".config", "opencode", "opencode.jsonc"),
    path.join(appData, "opencode", "opencode.json"),
  ]) {
    if (fs.existsSync(p)) { detected.push({ name: "OpenCode", type: "opencode", configPath: p }); break; }
  }

  return detected;
}

// One backup per config file per process — a run that writes the same file for
// several servers must not spawn a fresh 56KB backup on every write.
const backedUp = new Set();

/**
 * How many `<config>.backup.<ms>` files to keep per config file (P4b).
 *
 * Every install, update and uninstall that touches a config leaves a backup, and nothing ever
 * removed them — `~/.claude.json` is tens of KB, so a machine that ran `setup` regularly collected
 * hundreds beside it. Five covers "undo the last few runs", which is what a backup is for.
 */
export const BACKUP_KEEP = 5;

/**
 * Delete all but the newest `keep` backups of `configPath`. Returns the removed paths.
 * Only the names `backup()` writes (`<basename>.backup.<digits>`) are considered, so a copy the
 * operator made by hand under any other name is never touched.
 */
export function rotateBackups(configPath, keep = BACKUP_KEEP) {
  const dir = path.dirname(configPath);
  const prefix = `${path.basename(configPath)}.backup.`;
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const stamp = (n) => Number(n.slice(prefix.length));
  const ours = names
    .filter((n) => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length)))
    .sort((a, b) => stamp(a) - stamp(b));
  const removed = [];
  for (const n of ours.slice(0, Math.max(0, ours.length - keep))) {
    const p = path.join(dir, n);
    try { fs.rmSync(p, { force: true }); removed.push(p); } catch { /* best effort */ }
  }
  return removed;
}

function backup(configPath) {
  if (!fs.existsSync(configPath)) return null;
  if (backedUp.has(configPath)) return null;
  const b = `${configPath}.backup.${Date.now()}`;
  fs.copyFileSync(configPath, b);
  backedUp.add(configPath);
  rotateBackups(configPath);
  return b;
}

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) return {};
  return readJsonc(configPath); // throws on unrecoverable syntax error
}

function parseJsoncText(text) {
  try { return JSON.parse(text); }
  catch { return JSON.parse(stripTrailingCommas(stripJsoncComments(text))); }
}

/**
 * How many times to re-read, merge and write when the read-back finds our change missing (P4a).
 *
 * `~/.claude.json` is Claude Code's live state file, and a running Claude Code rewrites it from its
 * own in-memory copy — so a change written while it runs can be overwritten moments later. Claude
 * Code takes no lock we could share, so the defence is to shrink the window and to notice when it
 * was hit: parse the file immediately before the atomic write (not whenever the caller first looked
 * at it), then read it back and confirm the change is there. A lost change is re-merged onto
 * whatever the other writer left, which keeps both.
 */
const WRITE_ATTEMPTS = 3;

/** The buckets a server entry may live in, as key paths from the config root. */
const BUCKETS = [["mcpServers"], ["mcp", "servers"], ["mcp"], ["mcp.servers"]];

function at(obj, keys) {
  let cur = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

const asJson = (v) => JSON.parse(JSON.stringify(v));

/**
 * Commit one change to an agent config with the smallest read→write window available.
 *
 *   mutate(cfg)  the structural change, applied to a FRESH parse taken just before writing
 *   edits        the same change as `editJsoncText` edits. Used instead of a rewrite when the file
 *                is a VS Code settings.json holding comments, so the comments survive (P4c)
 *   check(cfg)   true when the file read back after the write carries the change
 *
 * Returns "ok" | "lost" (the read-back kept failing) | "refused" (comments present and the text
 * edit did not parse back to exactly what `mutate` produces — nothing was written).
 *
 * P4c, the choice: a targeted text edit, guarded. Rewriting a commented settings.json as JSON is
 * what deleted the comments; refusing outright would make the installer useless for anyone who
 * keeps comments, which in VS Code is most people. The edit only splices the spans of our own keys,
 * and its result is re-parsed and compared with the structural result before anything is written —
 * so the residual risk of a scanner bug is a printed snippet, never a damaged file.
 */
function commit(agent, { mutate, edits, check }) {
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
    const exists = fs.existsSync(agent.configPath);
    const raw = exists ? fs.readFileSync(agent.configPath, "utf-8") : "";
    const fresh = exists ? parseJsoncText(raw) : {};
    const next = mutate(structuredClone(fresh));

    let text = JSON.stringify(next, null, 2);
    if (agent.type === "vscode" && exists && hasJsoncComments(raw)) {
      const edited = edits ? editJsoncText(raw, edits) : null;
      let same = false;
      if (edited !== null) {
        try { same = isDeepStrictEqual(asJson(parseJsoncText(edited)), asJson(next)); } catch { same = false; }
      }
      if (!same) return "refused";
      text = edited;
    }

    fs.mkdirSync(path.dirname(agent.configPath), { recursive: true });
    writeFileAtomic(agent.configPath, text);

    let after = null;
    try { after = loadConfig(agent.configPath); } catch { after = null; }
    if (after && check(after)) return "ok";
    if (attempt < WRITE_ATTEMPTS) {
      warn(`${agent.name}: change missing from ${agent.configPath} right after writing it — another process wrote the file; re-merging (attempt ${String(attempt + 1)}/${String(WRITE_ATTEMPTS)})`);
    }
  }
  return "lost";
}

// Env names whose values are masked when a snippet is printed for manual pasting.
const SECRETISH = /PASS|SECRET|TOKEN|KEY|CONNECTION|CREDENTIAL|AUTH/i;

/** What to paste by hand when a commented settings.json could not be edited safely. */
function printManualSnippet(agent, key, mcpConfig) {
  const env = mcpConfig.env ?? {};
  const hidden = Object.keys(env).filter((k) => SECRETISH.test(k));
  const shown = hidden.length
    ? { ...mcpConfig, env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, hidden.includes(k) ? "<fill in>" : v])) }
    : mcpConfig;
  const snippet = JSON.stringify({ mcp: { servers: { [key]: shown } } }, null, 2);
  warn(`${agent.name}: ${agent.configPath} has comments, and an edit that keeps them could not be verified — not rewritten.`);
  warn(`Merge this into the file by hand (under "mcp" → "servers"):`);
  console.log(snippet.split("\n").map((l) => `    ${l}`).join("\n"));
  if (hidden.length) warn(`Masked, not printed — fill these in yourself: ${hidden.join(", ")}`);
}

/** The structural change for registering `key`, per agent type, or null for an unknown type. */
function configureChange(agent, key, mcpConfig) {
  if (agent.type === "claude" || agent.type === "claude-code") {
    return {
      mutate: (merged) => {
        merged.mcpServers = { ...(merged.mcpServers ?? {}), [key]: mcpConfig };
        return merged;
      },
      check: (cfg) => isDeepStrictEqual(cfg.mcpServers?.[key], asJson(mcpConfig)),
    };
  }
  if (agent.type === "opencode") {
    const entry = {
      type: "local",
      command: [mcpConfig.command, ...mcpConfig.args],
      enabled: true,
      environment: mcpConfig.env,
    };
    return {
      mutate: (merged) => {
        merged.mcp = { ...(merged.mcp ?? {}), [key]: entry };
        if (!merged.$schema) merged.$schema = "https://opencode.ai/config.json";
        return merged;
      },
      check: (cfg) => isDeepStrictEqual(cfg.mcp?.[key], asJson(entry)),
    };
  }
  if (agent.type === "vscode") {
    return {
      mutate: (merged) => {
        const flat = merged["mcp.servers"] ?? {};
        const nested = merged.mcp?.servers ?? {};
        delete merged["mcp.servers"];
        merged.mcp = { ...(merged.mcp ?? {}), servers: { ...flat, ...nested, [key]: mcpConfig } };
        return merged;
      },
      // Equal to `mutate` only when there is no legacy flat "mcp.servers" key to fold in. When
      // there is, commit()'s comparison fails and the file is refused rather than half-migrated.
      edits: [{ path: ["mcp", "servers", key], value: mcpConfig }],
      check: (cfg) => isDeepStrictEqual(cfg.mcp?.servers?.[key], asJson(mcpConfig)),
    };
  }
  return null;
}

// Write { command, args, env } for `key` into one agent config file.
// mcpConfig: { command:"node", args:[absPath], env:{...} }
export function configureAgent(agent, key, mcpConfig) {
  try {
    loadConfig(agent.configPath);
  } catch (parseErr) {
    warn(`Cannot parse ${agent.configPath}: ${parseErr.message}`);
    warn(`Skipping ${agent.name} — fix the JSON syntax error manually first`);
    return false;
  }

  const change = configureChange(agent, key, mcpConfig);
  if (!change) {
    warn(`${agent.name}: unknown agent type '${agent.type}' — skipped`);
    return false;
  }

  const b = agent.noBackup ? null : backup(agent.configPath);
  if (b) info(`Backup: ${b}`);
  let result;
  try {
    result = commit(agent, change);
  } catch (e) {
    warn(`${agent.name}: could not update ${agent.configPath}: ${e.message}`);
    return false;
  }
  if (result === "refused") { printManualSnippet(agent, key, mcpConfig); return false; }
  if (result === "lost") {
    err(`${agent.name}: '${key}' is still missing from ${agent.configPath} after ${String(WRITE_ATTEMPTS)} writes — another process keeps overwriting it. Close that agent and re-run.`);
    return false;
  }
  ok(`Configured ${agent.name}`);
  return true;
}

// Remove `key` from one agent config file. Returns true if something was removed.
export function unconfigureAgent(agent, key) {
  let cfg;
  try {
    cfg = loadConfig(agent.configPath);
  } catch (e) {
    warn(`Cannot parse ${agent.configPath}: ${e.message} — skipped`);
    return false;
  }

  // opencode places servers directly under .mcp, hence the ["mcp"] bucket.
  const present = (c) => BUCKETS.some((bucket) => {
    const obj = at(c, bucket);
    return obj && typeof obj === "object" && key in obj;
  });
  if (!present(cfg)) return false;

  const b = agent.noBackup ? null : backup(agent.configPath);
  if (b) info(`Backup: ${b}`);
  let result;
  try {
    result = commit(agent, {
      mutate: (c) => {
        for (const bucket of BUCKETS) {
          const obj = at(c, bucket);
          if (obj && typeof obj === "object" && key in obj) delete obj[key];
        }
        return c;
      },
      edits: BUCKETS.map((bucket) => ({ path: [...bucket, key], remove: true })),
      check: (c) => !present(c),
    });
  } catch (e) {
    warn(`${agent.name}: could not update ${agent.configPath}: ${e.message}`);
    return false;
  }
  if (result === "refused") {
    warn(`${agent.name}: ${agent.configPath} has comments, and an edit that keeps them could not be verified — not rewritten. Delete the "${key}" entry under "mcp" → "servers" by hand.`);
    return false;
  }
  if (result === "lost") {
    err(`${agent.name}: '${key}' is back in ${agent.configPath} after ${String(WRITE_ATTEMPTS)} writes — another process keeps restoring it. Close that agent and re-run.`);
    return false;
  }
  ok(`Removed '${key}' from ${agent.name}`);
  return true;
}

/**
 * Point each registration of `key` that launches this server's entry from ANOTHER location at
 * `entryPath` instead (P4e). Only that one path element of `args` (or of opencode's `command`
 * array) changes; `env`, `command` and any other args are left exactly as they are.
 *
 * `mcp:update` used to rebuild and re-render the skill but leave the registration alone, so after
 * the checkout moved, the agent kept launching the old path and only the doctor's [config] line
 * noticed. An element is recognised by ENDING in `entrySuffix` (`<server dir>/dist/index.js`) —
 * "the same server, somewhere else" — which also keeps the `<key>-*` prefix match from rewriting an
 * entry that merely shares the prefix but launches something else.
 *
 * Returns the names of the rewritten entries ([] when nothing needed it, or on failure).
 */
export function refreshServerPath(agent, key, entryPath, entrySuffix, { local = false } = {}) {
  let cfg;
  try { cfg = loadConfig(agent.configPath); } catch { return []; }
  const norm = (s) => String(s).replace(/\\/g, "/").toLowerCase();
  const suffix = `/${norm(entrySuffix).replace(/^\/+/, "")}`;
  const want = norm(entryPath);
  const stale = (a) => typeof a === "string" && norm(a).endsWith(suffix) && norm(a) !== want;

  // [{ keys, index }] — the array holding the path, and the element to replace.
  const targets = [];
  for (const { bucket, name, entry } of locateEntries(cfg, key, bucketsFor(cfg, local))) {
    const field = Array.isArray(entry.args) ? "args" : Array.isArray(entry.command) ? "command" : null;
    if (!field) continue;
    entry[field].forEach((a, index) => {
      if (stale(a)) targets.push({ name, keys: [...bucket, name, field], index });
    });
  }
  if (targets.length === 0) return [];

  const apply = (c) => {
    for (const t of targets) {
      const arr = at(c, t.keys);
      // Re-checked on the fresh read: only replace what is still the stale path.
      if (Array.isArray(arr) && stale(arr[t.index])) arr[t.index] = entryPath;
    }
    return c;
  };
  const expected = apply(structuredClone(cfg));
  const arrays = [...new Map(targets.map((t) => [JSON.stringify(t.keys), t.keys])).values()];

  const b = agent.noBackup ? null : backup(agent.configPath);
  if (b) info(`Backup: ${b}`);
  let result;
  try {
    result = commit(agent, {
      mutate: apply,
      edits: arrays.map((keys) => ({ path: keys, value: at(expected, keys) })),
      check: (c) => targets.every((t) => at(c, t.keys)?.[t.index] === entryPath),
    });
  } catch (e) {
    warn(`${agent.name}: could not update ${agent.configPath}: ${e.message}`);
    return [];
  }
  const names = [...new Set(targets.map((t) => t.name))];
  if (result === "refused") {
    warn(`${agent.name}: ${agent.configPath} has comments, and an edit that keeps them could not be verified — not rewritten. Set the entry path of ${names.join(", ")} to ${entryPath} by hand.`);
    return [];
  }
  if (result === "lost") {
    err(`${agent.name}: the new path for ${names.join(", ")} did not stick in ${agent.configPath} — another process keeps overwriting it.`);
    return [];
  }
  return names;
}

/**
 * Rename deprecated env keys in every registration of `key` to their canonical names.
 *
 * `renamesFor(presentKeys)` returns `[{ legacy, canonical }]` (the manifest's `deprecatedEnvInUse`).
 * A value is MOVED, never read for display: it is copied to the canonical key and the legacy key is
 * deleted. When the canonical key already holds a non-empty value, that value wins, exactly as it
 * does at runtime, and the legacy key is only deleted. Nothing else in the entry changes.
 *
 * Returns `[{ name, renamed: [{ legacy, canonical }] }]` per rewritten entry ([] when nothing
 * needed it, or on failure).
 */
export function renameEnvKeys(agent, key, renamesFor, { local = false } = {}) {
  let cfg;
  try { cfg = loadConfig(agent.configPath); } catch { return []; }

  const plans = [];
  for (const { bucket, name, entry } of locateEntries(cfg, key, bucketsFor(cfg, local))) {
    const field = entry.env && typeof entry.env === "object" ? "env" : entry.environment && typeof entry.environment === "object" ? "environment" : null;
    if (!field) continue;
    const present = Object.keys(entry[field]).filter((k) => entry[field][k] !== "" && entry[field][k] != null);
    const renamed = renamesFor(present);
    if (renamed.length) plans.push({ name, keys: [...bucket, name, field], renamed });
  }
  if (plans.length === 0) return [];

  const apply = (c) => {
    for (const p of plans) {
      const env = at(c, p.keys);
      if (!env || typeof env !== "object") continue;
      for (const { legacy, canonical } of p.renamed) {
        if (!(legacy in env)) continue;
        if (env[canonical] === undefined || env[canonical] === "") env[canonical] = env[legacy];
        delete env[legacy];
      }
    }
    return c;
  };
  const expected = apply(structuredClone(cfg));

  const b = agent.noBackup ? null : backup(agent.configPath);
  if (b) info(`Backup: ${b}`);
  let result;
  try {
    result = commit(agent, {
      mutate: apply,
      edits: plans.map((p) => ({ path: p.keys, value: at(expected, p.keys) })),
      check: (c) => plans.every((p) => p.renamed.every(({ legacy, canonical }) => {
        const env = at(c, p.keys);
        return env && !(legacy in env) && canonical in env;
      })),
    });
  } catch (e) {
    warn(`${agent.name}: could not update ${agent.configPath}: ${e.message}`);
    return [];
  }
  if (result === "refused") {
    warn(`${agent.name}: ${agent.configPath} has comments, and an edit that keeps them could not be verified — not rewritten. Rename by hand: ${plans.flatMap((p) => p.renamed.map((r) => `${r.legacy} → ${r.canonical}`)).join(", ")}`);
    return [];
  }
  if (result === "lost") {
    err(`${agent.name}: the env renames for ${plans.map((p) => p.name).join(", ")} did not stick in ${agent.configPath} — another process keeps overwriting it.`);
    return [];
  }
  return plans.map((p) => ({ name: p.name, renamed: p.renamed }));
}

/** Every server-shaped entry named `key` or `<key>-<suffix>`: [{ bucket, name, entry }]. */
/**
 * The buckets to search: the root ones (user scope), or — `local` — Claude Code's per-project
 * `projects["<path>"].mcpServers`, which is where `claude mcp add -s local` writes.
 */
function bucketsFor(cfg, local) {
  if (!local) return BUCKETS;
  const projects = cfg?.projects && typeof cfg.projects === "object" ? Object.keys(cfg.projects) : [];
  return projects.map((p) => ["projects", p, "mcpServers"]);
}

function locateEntries(cfg, key, buckets = BUCKETS) {
  const found = new Map();
  for (const bucket of buckets) {
    const obj = at(cfg, bucket);
    if (!obj || typeof obj !== "object") continue;
    for (const name of Object.keys(obj)) {
      if (name !== key && !name.startsWith(`${key}-`)) continue;
      const entry = obj[name];
      // `cfg.mcp` also holds non-server settings, so require something server-shaped.
      if (!entry || typeof entry !== "object" || (!entry.command && !entry.args)) continue;
      // Keyed by name alone for the root buckets (one entry per name, first bucket wins); local
      // buckets are per project, so the same name may legitimately appear in each.
      const id = bucket[0] === "projects" ? `${bucket[1]}::${name}` : name;
      if (!found.has(id)) found.set(id, { bucket, name, entry });
    }
  }
  return [...found.values()];
}

// Return the raw server entry for `key` from an agent config (or null). Read-only.
export function readServerEntry(agent, key) {
  let cfg;
  try {
    cfg = loadConfig(agent.configPath);
  } catch {
    return null;
  }
  return (
    cfg.mcpServers?.[key] ??
    cfg.mcp?.servers?.[key] ??
    cfg.mcp?.[key] ??
    cfg["mcp.servers"]?.[key] ??
    null
  );
}

/**
 * Every registration of `key` in an agent config: the canonical entry, plus any
 * environment-suffixed instance (`<key>-<suffix>`).
 *
 * One server run against several backends is a supported pattern, not a misconfiguration — the
 * same build registered twice with different credentials, e.g. `observe-mcp-ssdev_au` and
 * `observe-mcp-wecrm_au_prod`. `readServerEntry` only ever looked for the exact key, so the doctor
 * reported such a server as "not registered", skipped its env check, and then failed `start`
 * because it launched the process with no credentials at all. A healthy install read as broken.
 *
 * Returns `[{ name, entry, suffixed }]`. Callers are expected to REPORT the names they got rather
 * than collapse them to a count: a suffix match is a heuristic, and naming it is what keeps an
 * unrelated entry from being silently absorbed. That matters for the planned S-44 rename of
 * `codebase-index-local` → `codebase-index`, after which the stale old key would match as a
 * "suffixed instance" of the new one — visible if named, invisible if merely counted.
 */
export function readServerEntries(agent, key) {
  let cfg;
  try {
    cfg = loadConfig(agent.configPath);
  } catch {
    return [];
  }
  const found = locateEntries(cfg, key).map(({ name, entry }) => ({ name, entry, suffixed: name !== key }));
  // Canonical key first, then suffixed instances in a stable order.
  return found.sort((a, b) =>
    a.suffixed === b.suffixed ? a.name.localeCompare(b.name) : (a.suffixed ? 1 : -1)
  );
}

// ---- Claude Code local scope ---------------------------------------------------------------------
//
// `claude mcp add -s local`, run in a repo, writes the server under `projects["<repo>"].mcpServers`
// in ~/.claude.json: private to this machine and visible only in sessions opened in that repo. The
// functions below read and write that bucket directly, with the same fresh-read / atomic write /
// read-back as the user-scope writes above, rather than shelling out to the `claude` CLI: env
// values (tokens, connection strings) would otherwise travel through a command line and, on
// Windows, through cmd.exe quoting.

/** `p` as a comparable path: absolute, forward slashes, no trailing slash, case-folded on Windows. */
export function comparablePath(p) {
  const s = toConfigPath(path.resolve(String(p))).replace(/\/+$/, "");
  return process.platform === "win32" || /^[a-zA-Z]:/.test(s) ? s.toLowerCase() : s;
}

/**
 * The keys under `projects` that name `repo`. Claude Code keys a project by the cwd it was opened
 * in, so one repo can hold several spellings (`D:/x/repo` and `d:/x/repo`) — each one applies to
 * the sessions opened under that spelling, which is why writes go to all of them.
 */
function projectKeysFor(cfg, repo) {
  const want = comparablePath(repo);
  const projects = cfg?.projects && typeof cfg.projects === "object" ? Object.keys(cfg.projects) : [];
  return projects.filter((k) => comparablePath(k) === want);
}

/** Every local-scope registration of exactly `key`: `[{ repo, entry }]`, `repo` as Claude Code stored it. */
export function readLocalEntries(agent, key) {
  let cfg;
  try { cfg = loadConfig(agent.configPath); } catch { return []; }
  const out = [];
  for (const [repo, project] of Object.entries(cfg.projects ?? {})) {
    const entry = project?.mcpServers?.[key];
    if (entry && typeof entry === "object") out.push({ repo, entry });
  }
  return out;
}

/**
 * Register `key` at local scope for `repo` — the effect of `claude mcp add -s local` run in `repo`.
 * Writes every existing spelling of the project key; creates the forward-slash one when Claude Code
 * has never opened the repo. Replaces the entry wholesale, like {@link configureAgent}.
 */
export function configureLocal(agent, repo, key, mcpConfig) {
  try {
    loadConfig(agent.configPath);
  } catch (parseErr) {
    warn(`Cannot parse ${agent.configPath}: ${parseErr.message} — local scope not written`);
    return false;
  }
  const b = agent.noBackup ? null : backup(agent.configPath);
  if (b) info(`Backup: ${b}`);
  let result;
  try {
    result = commit(agent, {
      mutate: (cfg) => {
        cfg.projects = cfg.projects && typeof cfg.projects === "object" ? cfg.projects : {};
        const keys = projectKeysFor(cfg, repo);
        if (keys.length === 0) keys.push(toConfigPath(path.resolve(repo)));
        for (const k of keys) {
          const project = cfg.projects[k] && typeof cfg.projects[k] === "object" ? cfg.projects[k] : {};
          cfg.projects[k] = { ...project, mcpServers: { ...(project.mcpServers ?? {}), [key]: mcpConfig } };
        }
        return cfg;
      },
      check: (cfg) => {
        const keys = projectKeysFor(cfg, repo);
        return keys.length > 0 && keys.every((k) => isDeepStrictEqual(cfg.projects[k]?.mcpServers?.[key], asJson(mcpConfig)));
      },
    });
  } catch (e) {
    warn(`${agent.name}: could not update ${agent.configPath}: ${e.message}`);
    return false;
  }
  if (result !== "ok") {
    err(`${agent.name}: the local-scope entry for '${key}' did not stick in ${agent.configPath} — another process keeps overwriting it. Close that agent and re-run.`);
    return false;
  }
  ok(`Configured ${agent.name} at local scope for ${toConfigPath(repo)}`);
  return true;
}

/**
 * Remove the local-scope registration of `key` for `repo`, or for every project when `repo` is
 * null. Returns the project keys it was removed from ([] when there was none, or on failure).
 */
export function unconfigureLocal(agent, key, repo = null) {
  let cfg;
  try { cfg = loadConfig(agent.configPath); } catch { return []; }
  const holding = (c) => Object.keys(c.projects ?? {}).filter((k) =>
    c.projects[k]?.mcpServers && typeof c.projects[k].mcpServers === "object" && key in c.projects[k].mcpServers &&
    (repo === null || comparablePath(k) === comparablePath(repo)));
  const targets = holding(cfg);
  if (targets.length === 0) return [];
  const b = agent.noBackup ? null : backup(agent.configPath);
  if (b) info(`Backup: ${b}`);
  let result;
  try {
    result = commit(agent, {
      mutate: (c) => {
        for (const k of holding(c)) delete c.projects[k].mcpServers[key];
        return c;
      },
      check: (c) => holding(c).length === 0,
    });
  } catch (e) {
    warn(`${agent.name}: could not update ${agent.configPath}: ${e.message}`);
    return [];
  }
  if (result !== "ok") {
    err(`${agent.name}: '${key}' is back in a project of ${agent.configPath} after ${String(WRITE_ATTEMPTS)} writes — another process keeps restoring it.`);
    return [];
  }
  for (const k of targets) ok(`Removed '${key}' from ${agent.name} (local scope, ${k})`);
  return targets;
}

/**
 * A repo's `.mcp.json` as an agent-shaped target, so `configureAgent` / `unconfigureAgent` /
 * `readServerEntry` work on it unchanged. Project scope: the file is meant to be committed, so it
 * gets no `.backup.*` siblings — git is its history.
 */
export function projectMcpJson(repo) {
  return { name: `.mcp.json (${toConfigPath(repo)})`, type: "claude-code", configPath: path.join(repo, ".mcp.json"), noBackup: true };
}
