// Re-export shim for `@mcp/manifest` (migration-plan step S-34).
//
// The manifest data and its helpers now live in `packages/manifest/src`, typed. This file exists
// so the seven consumers under `scripts/` kept working without a flag day, and the plan deletes it
// once they import the package directly.
//
// Why it is not a bare `export * from "@mcp/manifest"`:
//
// The package resolves to `packages/manifest/dist`, which is gitignored — so on a fresh clone, or
// after `clean:packages`, the import fails. A bare re-export surfaces that as
// ERR_MODULE_NOT_FOUND naming a path inside node_modules, which reads like a broken install
// rather than "you have not built yet". `npm run mcp:doctor` is exactly the command someone runs
// when things look broken, and it must not be the one that misleads them.

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
  WORKSPACE_ROOT,
  evaluateEnv,
  getServer,
  serverDirPath,
  serverEntryPath,
  serverKeys
} = manifest;
