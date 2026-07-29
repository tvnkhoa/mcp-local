#!/usr/bin/env node
/**
 * Write each server's `.env.example` from the manifest (S-35).
 *
 * These four files had drifted badly: the manifest declared 41 vars, the four `.env.example`
 * files documented 68 between them, and the code actually read 89. No two agreed, and nothing
 * checked. Generating them collapses the contract to one place.
 *
 *   node scripts/generate-env.mjs [--check]
 */

import path from "node:path";

import { WORKSPACE_ROOT } from "./lib/manifest.mjs";
import { staleTargets, writeTargets } from "./lib/generate.mjs";
import { err, ok, warn } from "./lib/log.mjs";

const CHECK = process.argv.includes("--check");

if (CHECK) {
  const stale = staleTargets("env");
  if (stale.length === 0) {
    ok("generate:env — all .env.example files match the manifest");
    process.exit(0);
  }
  for (const target of stale) {
    err(`STALE  ${path.relative(WORKSPACE_ROOT, target.file)}${target.missing ? " (missing)" : ""}`);
  }
  warn("Run `npm run generate:env` and commit the result.");
  process.exit(1);
}

const written = writeTargets("env");
if (written.length === 0) {
  ok("generate:env — no change");
} else {
  for (const file of written) ok(`wrote ${file}`);
}
