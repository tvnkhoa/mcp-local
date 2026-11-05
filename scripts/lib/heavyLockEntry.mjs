#!/usr/bin/env node
/**
 * The deployed heavy lock's stable entry (row H-5). `node scripts/heavy-lock.mjs deploy` copies this file,
 * unchanged, to `<deployRoot>/heavy-lock/heavy-lock.mjs`; other repos' wrappers run that path. It runs the
 * copy `current.json` (beside it) names, so only an explicit deploy changes what they run.
 *
 * A broken deploy (no or unreadable `current.json`, its copy missing or pruned, a module of it missing)
 * exits `DEPLOY_BROKEN_EXIT` (78, EX_CONFIG) with one line, never 0/1 (a command's own result), 75/76 (the
 * lock's) or 130 (a signal). Builtins only; it lives outside any versioned copy and is not meant to run
 * from the source tree.
 */

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEPLOY_BROKEN_EXIT = 78;

function broken(why) {
  console.error(`heavy-lock deploy broken: ${why} (${fileURLToPath(new URL(".", import.meta.url))}). A leader re-runs npm run heavy-lock:deploy in mcp-local.`);
  process.exit(DEPLOY_BROKEN_EXIT);
}

let entry = null;
try {
  const current = JSON.parse(fs.readFileSync(new URL("./current.json", import.meta.url), "utf8"));
  if (typeof current?.entry !== "string" || current.entry === "") throw new Error("current.json names no entry");
  entry = new URL(current.entry, import.meta.url);
  if (!fs.existsSync(entry)) throw new Error(`${current.entry} is missing (pruned or deleted)`);
} catch (error) {
  broken(error instanceof SyntaxError ? `current.json is not JSON (${error.message})` : error.code === "ENOENT" ? "no current.json" : String(error.message));
}
try {
  await import(entry.href);
} catch (error) {
  if (error?.code === "ERR_MODULE_NOT_FOUND") broken(String(error.message).split("\n")[0]);
  throw error;
}
