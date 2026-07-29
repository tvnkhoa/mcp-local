/**
 * A reinstall must not reset a server's configured environment.
 *
 * `configureAgent` writes `[key]: mcpConfig`, replacing a server's entry wholesale — so whatever the
 * installer assembles IS the new env, and anything it omits is deleted. `collectEnv` used to build
 * that purely from manifest prompts and defaults, which meant `npm run setup` silently reset every
 * tuned value: on this machine it narrowed `CODEBASE_INDEX_ALLOWED_ROOTS` from `D:/1.SourceCode/` to
 * `D:/1.SourceCode/mcp-local`, flipped docs and telemetry off, and dropped four tuning knobs.
 *
 * The failure was invisible in two ways worth remembering:
 *   - `mcp:doctor` reported PASS, because it only asserts required keys are *present* — and they
 *     were, at the wrong values.
 *   - the server still started and answered `initialize`, so `verify` passed too. Only a tool call
 *     that needed the wider allowlist (`dead_code_scan` over a repo outside it) returned the empty
 *     result that exposed it.
 *
 * Source-level assertions, because the alternative is driving the real installer against a real
 * agent config. What is pinned is the shape that made the bug possible.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const installer = fs.readFileSync(path.join(ROOT, "scripts/install-mcp.mjs"), "utf8");
const agents = fs.readFileSync(path.join(ROOT, "scripts/lib/agents.mjs"), "utf8");

test("the installer reads the existing configuration before assembling env", () => {
  assert.match(
    installer,
    /readServerEntry/,
    "install-mcp must read the current entry; without it a reinstall cannot preserve anything"
  );
  assert.match(installer, /function existingEnvFor/, "expected the existing-env helper");
});

test("collectEnv receives the detected agents", () => {
  // The regression shape: collectEnv(server) with no agents argument cannot see current values.
  assert.doesNotMatch(
    installer,
    /collectEnv\(server\)\s*;/,
    "collectEnv must be called with the agent list, not the server alone"
  );
  assert.match(installer, /collectEnv\(server,\s*agents\)/);
});

test("a configured value takes precedence over the manifest default", () => {
  // Both the prompt default and the silent path must prefer `current`.
  assert.match(
    installer,
    /current\s*\?\?\s*field\.default/,
    "the prompt default should be the configured value, falling back to the manifest default"
  );
  const silentBranch = /\}\s*else if \(current !== undefined\) \{[\s\S]*?value = current;/;
  assert.match(installer, silentBranch, "the non-prompt path must reuse the configured value");
});

test("values the manifest does not declare are preserved too", () => {
  // postgres-mcp's real config carries PGSSLMODE and NODE_TLS_REJECT_UNAUTHORIZED — libpq's and
  // Node's own names. They are configuration the operator set; a manifest-driven rebuild of the env
  // would drop them, and no manifest change can prevent that.
  assert.match(installer, /undeclared/, "expected undeclared keys to be carried over");
  assert.match(installer, /!server\.env\.some\(\(f\) => f\.name === k\)/);
});

test("configureAgent still replaces the entry wholesale — which is why the above matters", () => {
  // If this ever becomes a merge, the preservation logic is belt-and-braces rather than load-bearing.
  // Pinned so the comment above cannot quietly become false.
  assert.match(
    agents,
    /merged\.mcpServers = \{ \.\.\.\(merged\.mcpServers \?\? \{\}\), \[key\]: mcpConfig \}/,
    "configureAgent replaces the per-server entry; env preservation must happen before this point"
  );
});

test("uninstall can still target a key the manifest no longer declares", () => {
  // The S-44 rename needed this, and it is what made the env loss reachable: uninstall-then-install
  // guarantees a fresh entry. Keep the escape hatch, and keep it separate from --server.
  const uninstall = fs.readFileSync(path.join(ROOT, "scripts/uninstall-mcp.mjs"), "utf8");
  assert.match(uninstall, /--key/, "expected the raw-key escape hatch");
  assert.doesNotMatch(
    uninstall,
    /catch[\s\S]{0,80}resolveServers/,
    "an unknown --server must stay an error, not silently fall back to a raw key"
  );
});
