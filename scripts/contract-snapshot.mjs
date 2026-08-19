#!/usr/bin/env node
/**
 * Golden tool-contract snapshots (migration-plan step S-06).
 *
 * Starts each server over a real stdio MCP handshake, captures its `tools/list`
 * response, and writes it to `contracts/<key>.json`. In `--check` mode it does the
 * same and diffs against what is committed, exiting non-zero on any drift.
 *
 * This is the safety net for migrating a server's internals: the contract a client
 * sees is exactly `tools/list`, so a snapshot diff turns "did I change the API?"
 * from a code-review judgement call into a mechanical answer.
 *
 * Determinism matters more than realism here:
 *   - Every env var the manifest declares is OVERRIDDEN with a fixed placeholder,
 *     so a developer's real credentials can neither leak into a snapshot nor make
 *     one machine's output differ from another's.
 *   - Tools are sorted by name and every object key is sorted, so the diff shows
 *     semantic change rather than serialization order.
 *
 * Usage:
 *   node scripts/contract-snapshot.mjs            # write/update snapshots
 *   node scripts/contract-snapshot.mjs --check    # verify, non-zero on drift
 *   node scripts/contract-snapshot.mjs --server bitbucket-mcp
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { SERVERS } from "./lib/manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS_DIR = path.join(ROOT, "contracts");

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const only = (() => {
  const i = argv.indexOf("--server");
  return i === -1 ? null : argv[i + 1];
})();

/**
 * Fixed placeholder for a declared env var.
 *
 * Never the manifest's `default`: those can be absolute paths from the machine
 * that generated them, which would make snapshots differ per developer.
 */
function placeholderFor(entry) {
  const name = entry.name;
  // A connection string has to actually parse — the server validates it at startup. Which means
  // the placeholder has to be in the right DIALECT: sqlserver-mcp parses ADO.NET key/value pairs
  // and rejects a postgres URI outright, so a shared placeholder would fail the boot check for a
  // reason that has nothing to do with the server's contract.
  if (/^SQLSERVER_/.test(name) && /CONNECTION/.test(name)) {
    return "data source=localhost;initial catalog=snapshot;User Id=snapshot;Password=snapshot";
  }
  if (/CONNECTION|_DSN$/.test(name)) return "postgres://snapshot:snapshot@localhost:5432/snapshot";
  if (/_(URL|BASE_URL)$/.test(name)) return "https://contract-snapshot.invalid";
  // Must be a real directory: allowlist resolution rejects a path that is absent.
  if (/ROOTS$/.test(name)) return ROOT;
  if (/(_PATH|_DB_PATH)$/.test(name)) return path.join(ROOT, "contract-snapshot.db");
  if (/(ENABLED|DRY_RUN)/.test(name)) return "false";
  if (/(_MS|_SIZE|_LIMIT|_PAGELEN|_TIMEOUT)$/.test(name)) return "1000";
  return `contract-snapshot-${name.toLowerCase()}`;
}

function snapshotEnvFor(server) {
  // Inherit the ambient env so node itself can run (PATH, SystemRoot, ...), then
  // pin every declared var so the result cannot vary by machine or leak a secret.
  const env = { ...process.env };
  const groupsFilled = new Set();

  for (const entry of server.env ?? []) {
    // `PG_ENV_*` is a wildcard declaration for the installer's benefit, not a real
    // variable name.
    if (entry.name.includes("*")) continue;

    // A `group` means "at least one of these must be set": fill the first member,
    // unset the rest, so the server takes exactly one well-defined auth /
    // connection path instead of an ambiguous mixture.
    const isGroupRepresentative =
      typeof entry.group === "string" && !groupsFilled.has(entry.group);
    if (isGroupRepresentative) groupsFilled.add(entry.group);

    if (entry.required === true || isGroupRepresentative) {
      env[entry.name] = placeholderFor(entry);
      continue;
    }

    // Everything else is optional, which means the server has a working default.
    // Unset it rather than inventing a value: a placeholder for something like
    // PG_ALLOWED_ENVIRONMENTS is not a harmless string, it is a filter that
    // matches nothing. Unsetting also stops the developer's real env from
    // reaching the snapshot.
    delete env[entry.name];
  }
  return env;
}

/** Recursively sort object keys so the diff reflects meaning, not key order. */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

async function captureTools(server) {
  const cwd = path.join(ROOT, server.dir);
  const entry = path.join(cwd, server.entry);
  if (!fs.existsSync(entry)) {
    throw new Error(`${server.key}: ${server.entry} not found — run the server's build first`);
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server.entry],
    cwd,
    env: snapshotEnvFor(server),
    stderr: "pipe"
  });
  const client = new Client({ name: "contract-snapshot", version: "1.0.0" });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = [...listed.tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => sortDeep(tool));
    return { server: server.key, toolCount: tools.length, tools };
  } finally {
    await client.close().catch(() => {});
  }
}

function snapshotPath(server) {
  return path.join(CONTRACTS_DIR, `${server.key}.json`);
}

/** First differing path between two JSON values, for a readable failure message. */
function firstDifference(before, after, at = "") {
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  if (
    before === null || after === null ||
    typeof before !== "object" || typeof after !== "object" ||
    Array.isArray(before) !== Array.isArray(after)
  ) {
    return { at: at || "(root)", before, after };
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) {
    const found = firstDifference(before[key], after[key], at ? `${at}.${key}` : key);
    if (found !== null) return found;
  }
  return { at: at || "(root)", before, after };
}

async function main() {
  const targets = SERVERS.filter((s) => only === null || s.key === only || s.dir === only);
  if (targets.length === 0) {
    console.error(`No server matched "${only}". Known: ${SERVERS.map((s) => s.key).join(", ")}`);
    process.exit(2);
  }

  fs.mkdirSync(CONTRACTS_DIR, { recursive: true });

  let drifted = 0;
  let failed = 0;

  for (const server of targets) {
    const file = snapshotPath(server);
    let captured;
    try {
      captured = await captureTools(server);
    } catch (error) {
      failed += 1;
      console.error(`FAIL   ${server.key.padEnd(22)} ${error.message}`);
      continue;
    }
    const serialized = `${JSON.stringify(captured, null, 2)}\n`;

    if (!CHECK) {
      const existed = fs.existsSync(file);
      const unchanged = existed && fs.readFileSync(file, "utf8") === serialized;
      fs.writeFileSync(file, serialized);
      const label = !existed ? "CREATE" : unchanged ? "SAME  " : "UPDATE";
      console.log(`${label} ${server.key.padEnd(22)} ${captured.toolCount} tools`);
      continue;
    }

    if (!fs.existsSync(file)) {
      drifted += 1;
      console.error(`MISSING ${server.key.padEnd(21)} no committed snapshot — run without --check`);
      continue;
    }
    const committed = JSON.parse(fs.readFileSync(file, "utf8"));
    const diff = firstDifference(committed, captured);
    if (diff === null) {
      console.log(`OK     ${server.key.padEnd(22)} ${captured.toolCount} tools`);
    } else {
      drifted += 1;
      console.error(`DRIFT  ${server.key.padEnd(22)} ${committed.toolCount} -> ${captured.toolCount} tools`);
      console.error(`         at: ${diff.at}`);
      console.error(`   committed: ${JSON.stringify(diff.before)?.slice(0, 300)}`);
      console.error(`     current: ${JSON.stringify(diff.after)?.slice(0, 300)}`);
    }
  }

  if (failed > 0 || drifted > 0) {
    if (drifted > 0) {
      console.error(
        `\n${drifted} contract(s) drifted. If the change is intended, re-run without --check and commit the diff.`
      );
    }
    process.exit(1);
  }
  console.log(`\n${targets.length} contract(s) ${CHECK ? "verified" : "written"}.`);
}

await main();
