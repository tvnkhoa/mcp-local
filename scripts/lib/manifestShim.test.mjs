/**
 * The shim must re-export everything the package exports (backlog B-10).
 *
 * `scripts/lib/manifest.mjs` cannot use `export *` — see the long comment at its head — so it
 * restates the export names by hand. A hand-maintained list against a growing package is the
 * classic drift shape, and it had already drifted: `TOOL_LISTS` and `TOTAL_TOOL_COUNT` were added
 * to `@mcp/manifest` and never reached the shim, so a `scripts/` consumer importing either got
 * nothing, silently.
 *
 * This test is the whole reason the shim is allowed to stay.
 */

import assert from "node:assert/strict";
import test from "node:test";

import * as shim from "./manifest.mjs";

const pkg = await import("@mcp/manifest");

/** Types are erased at runtime, so only value exports are comparable. */
const valueNames = (mod) =>
  Object.keys(mod)
    .filter((name) => name !== "default" && mod[name] !== undefined)
    .sort();

test("the shim re-exports every value the package exports", () => {
  const missing = valueNames(pkg).filter((name) => !(name in shim));
  assert.deepEqual(
    missing,
    [],
    `add these to the destructuring in scripts/lib/manifest.mjs: ${missing.join(", ")}`
  );
});

test("the shim exports nothing the package does not", () => {
  // The other direction matters too: a name left behind after the package drops it would resolve
  // to `undefined` at every call site rather than failing at import.
  const extra = valueNames(shim).filter((name) => !(name in pkg));
  assert.deepEqual(extra, [], `stale re-exports in scripts/lib/manifest.mjs: ${extra.join(", ")}`);
});

test("no re-exported value is undefined", () => {
  // Destructuring a name the package does not have yields `undefined` rather than throwing, which
  // is exactly how the TOOL_LISTS gap stayed invisible.
  for (const name of Object.keys(shim)) {
    assert.notEqual(shim[name], undefined, `${name} is re-exported as undefined`);
  }
});
