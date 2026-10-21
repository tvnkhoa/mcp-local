import assert from "node:assert/strict";
import test from "node:test";

import { buildVitestCommand, detectPackageManager, planTestRuns, type PlanFs } from "./testRunPlan.js";
import { resolveExportsSubpath, splitPackageSpecifier } from "./testDiffGraph.js";
import { importKeyOf, isRunnableTestFile } from "./testsForDiff.js";

test("runnable tests vs helpers in a test folder; import keys for gap naming", () => {
  assert.equal(isRunnableTestFile("packages/core/test/turn.test.ts"), true);
  assert.equal(isRunnableTestFile("packages/console/test/render.ts"), false);
  assert.equal(isRunnableTestFile("tests/test_api.py"), true);
  assert.equal(importKeyOf("packages/core/audit/index.ts"), "audit");
  assert.equal(importKeyOf("../audit/index.js"), "audit");
  assert.equal(importKeyOf("./ledger.js"), "ledger");
});

/** R11 (MCP-ISSUE-080): grouping tests per package and building the command. Nothing runs. */

function memFs(files: Record<string, string>): PlanFs {
  return { exists: (p) => p in files, read: (p) => files[p] ?? null };
}

const monorepo = {
  "package.json": JSON.stringify({ name: "mono", packageManager: "pnpm@11.0.0" }),
  "pnpm-lock.yaml": "",
  "packages/core/package.json": JSON.stringify({ name: "@demo/core", devDependencies: { vitest: "^4" } }),
  "packages/core/vitest.config.ts": "export default defineConfig({ test: { include: ['test/**/*.test.ts'], exclude: ['**/*.dom.test.ts'] } })",
  "packages/core/test/ledger.test.ts": "import { x } from '../src/ledger.js'",
  "packages/core/test/ledger.dom.test.ts": "",
  "packages/ui/package.json": JSON.stringify({ name: "@demo/ui", scripts: { test: "vitest run" } }),
  "packages/ui/vitest.config.mts": "export default { test: { include: ['src/**/*.dom.test.ts'], environment: 'jsdom' } }",
  "packages/ui/src/panel.dom.test.ts": "",
  "packages/ui/src/panel.test.ts": "",
  "tools/check.test.mjs": "import test from 'node:test'",
  "tools/package.json": JSON.stringify({ name: "tools" })
};

test("package manager from the lockfile; corepack when packageManager is declared", () => {
  assert.deepEqual(detectPackageManager(memFs(monorepo)), { manager: "pnpm", lockfile: "pnpm-lock.yaml", corepack: true });
  assert.equal(detectPackageManager(memFs({ "package-lock.json": "" })).manager, "npm");
  assert.equal(detectPackageManager(memFs({ "yarn.lock": "" })).manager, "yarn");
});

test("tests are grouped per package with one command each; files relative to the root", () => {
  const plan = planTestRuns(
    ["packages/core/test/ledger.test.ts", "packages/ui/src/panel.dom.test.ts", "packages/core/test/ledger.dom.test.ts", "packages/ui/src/panel.test.ts", "tools/check.test.mjs"],
    memFs(monorepo)
  );
  assert.equal(plan.groups.length, 2);
  const core = plan.groups.find((g) => g.package === "@demo/core")!;
  assert.deepEqual(core.files, ["test/ledger.test.ts"]);
  assert.equal(core.command, "cd packages/core && ./node_modules/.bin/vitest run test/ledger.test.ts");
  const ui = plan.groups.find((g) => g.package === "@demo/ui")!;
  assert.equal(ui.command, "cd packages/ui && ./node_modules/.bin/vitest run src/panel.dom.test.ts");
  // wec.aria acceptance: a pnpm repo still gets no package-manager command.
  assert.ok(plan.groups.every((g) => !/(pnpm|yarn|npm|npx|corepack)/.test(g.command)), JSON.stringify(plan.groups.map((g) => g.command)));

  const reasons = Object.fromEntries(plan.excluded.map((e) => [e.testFile, e.reason]));
  assert.match(reasons["packages/core/test/ledger.dom.test.ts"]!, /excluded by "\*\*\/\*\.dom\.test\.ts"/);
  assert.match(reasons["packages/ui/src/panel.test.ts"]!, /not matched by include \["src\/\*\*\/\*\.dom\.test\.ts"\]/);

  const node = plan.other.find((o) => o.testFile === "tools/check.test.mjs")!;
  assert.equal(node.runner, "unknown");
  assert.equal(node.hint, "node --test tools/check.test.mjs");
});

test("an unreadable include falls back to the package dir and says so", () => {
  const fs = memFs({
    "package.json": JSON.stringify({ name: "solo", devDependencies: { vitest: "^4" } }),
    "vitest.config.ts": "export default { test: { include: patterns } }",
    "x/a.test.ts": ""
  });
  const plan = planTestRuns(["x/a.test.ts"], fs);
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.groups[0]!.configStatus, "unreadable");
  assert.match(plan.groups[0]!.notes.join(), /not statically readable \(include: identifier patterns\)/);
  assert.equal(plan.groups[0]!.command, "./node_modules/.bin/vitest run x/a.test.ts");
});

test("test.projects: a file goes in when any inline project includes it", () => {
  const fs = memFs({
    "package.json": JSON.stringify({ name: "p", devDependencies: { vitest: "^4" } }),
    "package-lock.json": "",
    "vitest.config.ts": `export default defineConfig({ test: { projects: [
      { test: { name: 'node', include: ['test/**/*.test.ts'], exclude: ['**/*.dom.test.ts'] } },
      { test: { name: 'dom', include: ['**/*.dom.test.ts'] } } ] } })`,
    "test/a.test.ts": "",
    "test/b.dom.test.ts": "",
    "src/c.ts.snap": ""
  });
  const plan = planTestRuns(["test/a.test.ts", "test/b.dom.test.ts"], fs);
  const g = plan.groups[0]!;
  assert.deepEqual(g.files, ["test/a.test.ts", "test/b.dom.test.ts"]);
  assert.deepEqual(g.projectsByFile, { "test/a.test.ts": ["node"], "test/b.dom.test.ts": ["dom"] });
});

test("a package with no vitest and no node:test import gets runner unknown with no command", () => {
  const fs = memFs({ "package.json": JSON.stringify({ name: "x" }), "a.test.js": "describe()" });
  const plan = planTestRuns(["a.test.js"], fs);
  assert.equal(plan.groups.length, 0);
  assert.equal(plan.other[0]!.runner, "unknown");
  assert.equal(plan.other[0]!.hint, undefined);
});

test("command building: the package's own vitest binary, never a package manager", () => {
  assert.equal(buildVitestCommand("packages/b", "packages/b", ["t/x.test.ts"]), "cd packages/b && ./node_modules/.bin/vitest run t/x.test.ts");
  assert.equal(buildVitestCommand("packages/b", "packages/b/web", ["x.test.ts"]), "cd packages/b && ./node_modules/.bin/vitest run --root web x.test.ts");
  assert.equal(buildVitestCommand("", "", ["x.test.ts"]), "./node_modules/.bin/vitest run x.test.ts");
  assert.equal(buildVitestCommand("apps/web", "apps/web", ["my file.test.ts"]), 'cd apps/web && ./node_modules/.bin/vitest run "my file.test.ts"');
});

test("workspace specifiers resolve through package.json exports", () => {
  assert.deepEqual(splitPackageSpecifier("@aria/core/audit"), { name: "@aria/core", subpath: "audit" });
  assert.deepEqual(splitPackageSpecifier("lodash/fp"), { name: "lodash", subpath: "fp" });
  assert.equal(splitPackageSpecifier("./x"), null);
  const known = new Set(["packages/core/audit/index.ts", "packages/core/src/index.ts", "packages/core/features/a.ts"]);
  const exportsField = {
    ".": { "aria-runtime": "./dist-runtime/src/index.js", default: "./src/index.ts" },
    "./audit": { "aria-runtime": "./dist-runtime/audit/index.js", default: "./audit/index.ts" },
    "./features/*": "./features/*.js"
  };
  assert.equal(resolveExportsSubpath(exportsField, "packages/core", "", known), "packages/core/src/index.ts");
  assert.equal(resolveExportsSubpath(exportsField, "packages/core", "audit", known), "packages/core/audit/index.ts");
  assert.equal(resolveExportsSubpath(exportsField, "packages/core", "features/a", known), "packages/core/features/a.ts");
  assert.equal(resolveExportsSubpath(exportsField, "packages/core", "nope", known), null);
});
