import assert from "node:assert/strict";
import test from "node:test";

import { matchesVitestGlobs, parseVitestConfigText, parseVitestWorkspaceText, stripJsComments, VITEST_DEFAULT_INCLUDE } from "./vitestConfig.js";

/** R11 (MCP-ISSUE-080): a vitest config is read lexically, never executed. */

test("include / exclude / root are read from a literal test block", () => {
  const cfg = parseVitestConfigText(`
    import { defineConfig } from 'vitest/config'
    // include: ['commented/out/**']
    export default defineConfig({
      plugins: [vue()],
      test: {
        include: ['test/**/*.test.ts', "src/**/*.spec.ts"],
        exclude: ['**/*.dom.test.ts'],
        root: './pkg', /* not 'other' */
        testTimeout: 30_000,
      },
    })
  `);
  assert.equal(cfg.hasTestBlock, true);
  assert.deepEqual(cfg.include, ["test/**/*.test.ts", "src/**/*.spec.ts"]);
  assert.deepEqual(cfg.exclude, ["**/*.dom.test.ts"]);
  assert.equal(cfg.root, "./pkg");
  assert.deepEqual(cfg.unreadable, []);
});

test("a config with no test block reports defaults, not a guess", () => {
  const cfg = parseVitestConfigText(`export default defineConfig({ plugins: [vue({ customElement: true })] })`);
  assert.equal(cfg.hasTestBlock, false);
  assert.equal(cfg.include, null);
});

test("a test block without include keeps include null (defaults apply)", () => {
  const cfg = parseVitestConfigText(`export default defineConfig({ test: { testTimeout: 30_000 } })`);
  assert.equal(cfg.hasTestBlock, true);
  assert.equal(cfg.include, null);
  assert.deepEqual(cfg.unreadable, []);
});

test("a non-literal include is named unreadable, never evaluated", () => {
  const a = parseVitestConfigText(`const base = ['a']; export default { test: { include: base } }`);
  assert.equal(a.include, null);
  assert.match(a.unreadable.join(), /include: identifier base/);
  const b = parseVitestConfigText(`export default { test: { include: [...shared, 'x/**'] } }`);
  assert.match(b.unreadable.join(), /include: spread shared/);
  const c = parseVitestConfigText("export default { test: { include: [`${dir}/**`] } }");
  assert.match(c.unreadable.join(), /include: template literal/);
});

test("a function-form config is still read lexically", () => {
  const cfg = parseVitestConfigText(`export default defineConfig(({ mode }) => ({ root: 'web', test: { include: ['**/*.unit.ts'] } }))`);
  assert.deepEqual(cfg.include, ["**/*.unit.ts"]);
  assert.equal(cfg.root, "web");
});

test("test.projects: inline projects (incl. defineProject) and path globs", () => {
  const cfg = parseVitestConfigText(`
    export default defineConfig({
      test: {
        projects: [
          'packages/*',
          { extends: true, test: { name: 'node', include: ['test/**/*.test.ts'], exclude: ['**/*.dom.test.ts'] } },
          defineProject({ test: { name: 'dom', include: ['**/*.dom.test.ts'], environment: 'jsdom' } }),
          someProject,
        ],
      },
    })
  `);
  assert.equal(cfg.projects?.length, 4);
  assert.deepEqual(cfg.projects?.[0], { kind: "path", glob: "packages/*" });
  const node = cfg.projects?.[1];
  assert.ok(node && node.kind === "inline" && node.name === "node");
  assert.deepEqual(node.kind === "inline" ? node.exclude : null, ["**/*.dom.test.ts"]);
  const dom = cfg.projects?.[2];
  assert.ok(dom && dom.kind === "inline" && dom.name === "dom");
  assert.equal(cfg.projects?.[3]?.kind, "unreadable");
  // The project's own `test:` is not mistaken for the config's.
  assert.equal(cfg.include, null);
});

test("vitest.workspace files: JS and JSON", () => {
  const js = parseVitestWorkspaceText(`export default defineWorkspace(['packages/*', { test: { name: 'x', include: ['a/**'] } }])`, false);
  assert.equal(js.projects?.length, 2);
  const json = parseVitestWorkspaceText(`["apps/*"]`, true);
  assert.deepEqual(json.projects, [{ kind: "path", glob: "apps/*" }]);
});

test("comments are stripped but strings with // survive", () => {
  const s = stripJsComments(`const u = 'http://x'; // gone\n/* gone */ const v = 1`);
  assert.match(s, /'http:\/\/x'/);
  assert.doesNotMatch(s, /gone/);
});

test("glob matching: default include, exclude reason, include miss", () => {
  assert.equal(matchesVitestGlobs("test/a.test.ts", VITEST_DEFAULT_INCLUDE, []).included, true);
  assert.equal(matchesVitestGlobs("src/b.spec.mjs", VITEST_DEFAULT_INCLUDE, []).included, true);
  assert.equal(matchesVitestGlobs("src/helper.ts", VITEST_DEFAULT_INCLUDE, []).includeMiss, true);
  const ex = matchesVitestGlobs("test/x.dom.test.ts", ["test/**/*.test.ts"], ["**/*.dom.test.ts"]);
  assert.equal(ex.included, false);
  assert.equal(ex.excludedBy, "**/*.dom.test.ts");
});
