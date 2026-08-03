// Re-export shim for `@mcp/manifest` (migration-plan step S-34).
//
// The manifest data and its helpers now live in `packages/manifest/src`, typed. This file exists
// so the consumers under `scripts/` kept working without a flag day.
//
// Why it is not a bare `export * from "@mcp/manifest"`:
//
// The package resolves to `packages/manifest/dist`, which is gitignored — so on a fresh clone, or
// after `clean:packages`, the import fails. A bare re-export surfaces that as
// ERR_MODULE_NOT_FOUND naming a path inside node_modules, which reads like a broken install
// rather than "you have not built yet". `npm run mcp:doctor` is exactly the command someone runs
// when things look broken, and it must not be the one that misleads them.
//
// ---------------------------------------------------------------------------------------------
// Backlog B-10 asked for this file to be deleted, with the actionable message "re-homed". It is
// staying, and the reason is a fact about ESM rather than a preference:
//
//   A static `import ... from "@mcp/manifest"` is **resolved during linking**, before the body of
//   any module in the graph runs. So a preflight module imported first — the obvious re-homing —
//   cannot fire: the graph fails to link before its check executes. Measured, not reasoned: that
//   preflight was built, and every entry point still died on a raw ERR_MODULE_NOT_FOUND.
//
// A dynamic `await import()` inside a try/catch is the only construct that can intercept it, and a
// dynamic import cannot be star-re-exported — which is exactly why this file must restate the
// export names below. **The name list is the price of the message, not an oversight.**
//
// What *was* a real defect is that the list had drifted: it re-exported eight names while the
// package exported ten, so `TOOL_LISTS` and `TOTAL_TOOL_COUNT` were silently unreachable through
// here. Fixed, and `manifestShim.test.mjs` now diffs the two surfaces so it cannot drift again.
// ---------------------------------------------------------------------------------------------

let manifest;
try {
  manifest = await import("@mcp/manifest");
} catch (cause) {
  if (cause?.code === "ERR_MODULE_NOT_FOUND" || cause?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
    throw new Error(
      "@mcp/manifest is not built yet. Run `npm run build:packages` from the workspace root " +
        "(about 1s), then retry. Packages compile to gitignored dist/, so a fresh clone always " +
        "needs this once.",
      { cause }
    );
  }
  throw cause;
}

export const {
  SERVERS,
  TOOL_LISTS,
  TOTAL_TOOL_COUNT,
  WORKSPACE_ROOT,
  evaluateEnv,
  evaluateEnvValues,
  getServer,
  serverDirPath,
  serverEntryPath,
  serverKeys
} = manifest;
