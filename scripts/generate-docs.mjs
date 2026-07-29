#!/usr/bin/env node
/**
 * Write the generated blocks in each server's README from the manifest (S-36).
 *
 * Two blocks per README, delimited by `<!-- BEGIN/END GENERATED: <id> -->`:
 *
 *   env-table   the full environment contract
 *   tool-list   every tool the server advertises
 *
 * Everything outside the markers is preserved byte-for-byte, which is what makes this safe to run
 * against a README that is mostly hand-written prose — two of these are in Vietnamese, and one
 * carries a 60-line annotated tool catalogue that is more useful than any generated list.
 *
 * Tool names come from `packages/manifest/src/generated/toolLists.ts`, which
 * `scripts/generate-tools.mjs` derives from `contracts/`. Run that first if tools changed.
 *
 *   node scripts/generate-docs.mjs [--check]
 */

import path from "node:path";

import { WORKSPACE_ROOT } from "./lib/manifest.mjs";
import { staleTargets, writeTargets } from "./lib/generate.mjs";
import { err, ok, warn } from "./lib/log.mjs";

const CHECK = process.argv.includes("--check");

if (CHECK) {
  const stale = staleTargets("docs");
  if (stale.length === 0) {
    ok("generate:docs — all README blocks match the manifest");
    process.exit(0);
  }
  for (const target of stale) {
    err(`STALE  ${path.relative(WORKSPACE_ROOT, target.file)}`);
  }
  warn("Run `npm run generate:docs` and commit the result.");
  process.exit(1);
}

const written = writeTargets("docs");
if (written.length === 0) {
  ok("generate:docs — no change");
} else {
  for (const file of written) ok(`wrote ${file}`);
}
