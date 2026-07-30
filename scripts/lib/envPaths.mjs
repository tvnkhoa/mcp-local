/**
 * The filesystem half of the doctor's env-value check.
 *
 * `evaluateEnvValues` in `@mcp/manifest` validates value SHAPE and deliberately stops there: that package
 * is imported by the generators and has no filesystem access. Whether a path actually exists is a
 * different question with a different severity, and it lives here.
 *
 * Extracted from `mcp-doctor.mjs` rather than left inline so it can be tested. A check nobody can test is
 * a check nobody knows is working — and a doctor that reports PASS because its check is inert is worse
 * than no doctor, which is the failure this whole line of work started from.
 */

import fs from "node:fs";
import path from "node:path";

/** A path naming a file the server creates on first run — only its parent has to exist. */
const CREATED_ON_FIRST_RUN = /\.(db|sqlite3?)$/i;

/**
 * @param server a manifest ServerDescriptor
 * @param envObj the env map from the agent config
 * @param exists injectable for tests; defaults to the real filesystem
 * @returns one message per field with missing paths, naming counts and never the paths themselves
 */
export function findMissingEnvPaths(server, envObj, exists = fs.existsSync) {
  const problems = [];

  for (const field of server.env) {
    if (field.kind !== "path" && field.kind !== "path-list") continue;
    const raw = envObj[field.name] ?? readAliased(field, envObj);
    if (!raw) continue;

    const entries = field.kind === "path-list" ? String(raw).split(",") : [String(raw)];
    const candidates = entries.map((p) => p.trim()).filter((p) => p !== "");
    const missing = candidates.filter((p) => !exists(CREATED_ON_FIRST_RUN.test(p) ? path.dirname(p) : p));

    if (missing.length > 0) {
      // Counts, not paths. A path is not a secret, but keeping every finding in this file
      // count-shaped means the "never prints values" guarantee needs no per-case reasoning.
      problems.push(
        `${field.name}: ${String(missing.length)} of ${String(candidates.length)} path(s) do not exist`
      );
    }
  }

  return problems;
}

/**
 * The pre-rename names still work at runtime, so validating only the canonical name would skip the check
 * for exactly the operators most likely to be carrying a stale value (S-43).
 */
function readAliased(field, envObj) {
  for (const alias of field.deprecatedAliases ?? []) {
    const v = envObj[alias];
    if (v !== undefined && String(v).trim() !== "") return v;
  }
  return undefined;
}
