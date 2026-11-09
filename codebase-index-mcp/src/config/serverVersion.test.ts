import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { nearestPackageJson, runningEntryPath } from "./serverVersion.js";

/** MCP-ISSUE-124: the entry runs from dist/ (tsc) or dist/bundle/ (esbuild); both must find the package and the entry. */
function fakePackage(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "srvver-"));
  fs.mkdirSync(path.join(root, "dist", "bundle"), { recursive: true });
  fs.mkdirSync(path.join(root, "dist", "tools", "handlers"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
  return root;
}

test("nearestPackageJson finds the package from dist/ and from dist/bundle/", () => {
  const root = fakePackage();
  const expected = path.join(root, "package.json");
  assert.equal(nearestPackageJson(path.join(root, "dist")), expected);
  assert.equal(nearestPackageJson(path.join(root, "dist", "bundle")), expected);
  assert.equal(nearestPackageJson(path.join(root, "dist", "bundle"), 0), null, "maxUp bounds the walk");
});

test("runningEntryPath: unbundled resolves relative to the module, bundled is the entry itself", () => {
  const root = fakePackage();
  const handler = pathToFileURL(path.join(root, "dist", "tools", "handlers", "indexHandler.js")).href;
  assert.equal(runningEntryPath(handler, "indexHandler", "../../index.js"), path.join(root, "dist", "index.js"));
  const bundled = pathToFileURL(path.join(root, "dist", "bundle", "index.js")).href;
  assert.equal(runningEntryPath(bundled, "indexHandler", "../../index.js"), path.join(root, "dist", "bundle", "index.js"));
});
