/**
 * `run-tests.mjs --changed` (row V-E): scripts/test-map.json covers every suite script, and the
 * selection over it fails safe — an unmapped change runs the whole suite, an unmapped script always
 * runs, and only `skip` paths (other servers, pure docs) are left out.
 *
 * Usage: node scripts/test/test-test-select.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkMap, globToRegExp, selectForChanges, suiteScripts } from "../lib/testSelect.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOP = path.resolve(ROOT, "..");
const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
const map = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "test-map.json"), "utf8"));
const suite = suiteScripts(scripts);

// 1. The checked-in map is sound: every suite script has an entry, no entry is stale, no literal path is a typo.
const problems = checkMap({ map, suite, exists: (p) => fs.existsSync(path.join(TOP, p)) });
assert.deepEqual(problems, [], `scripts/test-map.json:\n  ${problems.join("\n  ")}`);

// 2. The check catches each kind of drift.
const drift = checkMap({
  map: { always: ["test:unit"], groups: { dist: ["src/**"] }, harnesses: { "test:a": ["@dist"], "test:gone": ["x/**"], "test:b": ["@nope", "no/such/file.mjs"] } },
  suite: ["test:unit", "test:a", "test:b", "test:new"],
  exists: () => false
});
assert.ok(drift.some((p) => p.startsWith("test:new: no entry")), "a test:* script with no map entry fails the check");
assert.ok(drift.some((p) => p.startsWith("test:gone: in test-map.json but not a script")), "a stale entry fails the check");
assert.ok(drift.some((p) => p.includes("unknown group @nope")), "an unknown group fails the check");
assert.ok(drift.some((p) => p.startsWith("no/such/file.mjs: no such file")), "a mistyped literal path fails the check");

// 3. Globs.
assert.ok(globToRegExp("a/**/*.ts").test("a/b/c/d.ts") && globToRegExp("a/**/*.ts").test("a/d.ts"), "** spans any depth, including none");
assert.ok(!globToRegExp("a/*.ts").test("a/b/c.ts"), "* stays within one segment");
assert.ok(globToRegExp("*.md").test("README.md") && !globToRegExp("*.md").test("docs/x.md"), "a pattern with no slash is top level only");
assert.ok(!globToRegExp("tsconfig*.json").test("tsconfigXjson.x"), "dots are literal");

// 4. Selection against a small map.
const small = {
  always: ["test:unit"],
  skip: { "other server": ["postgres-mcp/**"], docs: ["docs/**"] },
  unit: ["cim/src/**/*.test.ts"],
  groups: { dist: ["cim/src/**", "packages/**"] },
  harnesses: { "test:a": ["cim/scripts/test/a.mjs", "@dist"], "test:b": ["cim/scripts/test/b.mjs"] }
};
const smallSuite = ["test:unit", "test:a", "test:b", "test:unmapped"];
const pick = (changed) => selectForChanges({ changed, map: small, suite: smallSuite });
const names = (r) => r.selected.map((s) => s.name);

let r = pick(["cim/scripts/test/b.mjs"]);
assert.deepEqual(names(r), ["test:unit", "test:b", "test:unmapped"], "a harness file selects that harness; test:unit always; an unmapped script always (fail safe)");
assert.equal(r.selected.find((s) => s.name === "test:b").why, "cim/scripts/test/b.mjs", "the reason names the file");

r = pick(["packages/sdk/src/x.ts"]);
assert.deepEqual(names(r), ["test:unit", "test:a", "test:unmapped"], "a group reference (@dist) selects through the group");

r = pick(["cim/src/x.test.ts"]);
assert.deepEqual(names(r), ["test:unit", "test:unmapped"], "a unit test file needs only test:unit");
assert.deepEqual(r.unitOnly, ["cim/src/x.test.ts"]);

r = pick(["postgres-mcp/src/a.ts", "docs/x.md"]);
assert.equal(r.whole, false);
assert.deepEqual(r.skipped, [{ file: "postgres-mcp/src/a.ts", reason: "other server" }, { file: "docs/x.md", reason: "docs" }], "skips are reported with their reason");
assert.deepEqual(names(r), ["test:unit", "test:unmapped"]);

r = pick(["cim/scripts/test/b.mjs", "scripts/new-thing.mjs"]);
assert.equal(r.whole, true, "one uncovered file runs the whole suite");
assert.deepEqual(r.uncovered, ["scripts/new-thing.mjs"]);
assert.deepEqual(names(r), smallSuite, "never fewer tests on an unmapped change");

r = pick([]);
assert.deepEqual(names(r), ["test:unit", "test:unmapped"], "no change: only what always runs");

// 5. The real map: a root script outside the map runs everything; another server's file runs only what always runs.
const real = (changed) => selectForChanges({ changed, map, suite });
assert.equal(real(["scripts/some-new-root-script.mjs"]).whole, true, "an unmapped root scripts/ file selects the whole suite");
const scriptOnly = Object.entries(map.harnesses).filter(([, globs]) => !globs.includes("@dist")).map(([name]) => name);
assert.deepEqual(
  real(["package.json"]).selected.map((s) => s.name),
  suite.filter((name) => !scriptOnly.includes(name)),
  "the root package.json reaches every harness that runs against dist/, and only those"
);
const pg = real(["postgres-mcp/src/index.ts"]);
assert.deepEqual(pg.selected.map((s) => s.name), ["test:unit", "guard:no-llm-runtime"]);
const selfIndexed = real(["codebase-index-mcp/docs/backlog.md"]).selected.map((s) => s.name);
assert.ok(selfIndexed.includes("test:search-regex") && !selfIndexed.includes("test:bus-edges"), "a doc inside the package reaches the harnesses that index the package itself, not the fixture ones");

// 6. `none`: explicit root files no harness loads are skipped as @none; an unlisted root script still runs everything.
const inert = real(["scripts/serve-http.mjs", ".github/workflows/ci.yml"]);
assert.equal(inert.whole, false);
assert.deepEqual(inert.skipped, [{ file: "scripts/serve-http.mjs", reason: "@none" }, { file: ".github/workflows/ci.yml", reason: "@none" }]);
assert.deepEqual(inert.selected.map((s) => s.name), ["test:unit", "guard:no-llm-runtime"]);
assert.equal(real(["scripts/serve-http.mjs", "scripts/run-servers.mjs"]).whole, true, "an unlisted root script beside a none file still selects the whole suite");
const broad = checkMap({ map: { none: ["scripts/**", "scripts/*.mjs", "packages/sdk/**", ".github/**"], harnesses: {} }, suite: [], exists: () => true });
assert.deepEqual(
  broad.map((p) => p.split(":")[0]),
  ["scripts/**", "scripts/*.mjs", "packages/sdk/**"],
  "none refuses broad globs over scripts/, packages/ and non-<dir>/** patterns; .github/** is allowed"
);

// 7. No catch-all coverage: a new file anywhere in the package that no harness names runs the whole suite.
const fresh = real(["codebase-index-mcp/scripts/lib/new.mjs"]);
assert.equal(fresh.whole, true, "a new unmapped file in the package selects the whole suite");
assert.deepEqual(fresh.uncovered, ["codebase-index-mcp/scripts/lib/new.mjs"]);
const lint = checkMap({
  map: {
    skip: { docs: ["docs/**"] },
    unit: ["cim/src/**/*.test.ts"],
    harnesses: { "test:a": ["codebase-index-mcp/**"], "test:b": ["**"], "test:c": ["docs/adr/**"], "test:d": ["cim/src/x.test.ts"], "test:e": ["cim/src/**"] }
  },
  suite: ["test:a", "test:b", "test:c", "test:d", "test:e"],
  exists: () => true
});
assert.ok(lint.some((p) => p.startsWith("test:a: codebase-index-mcp/** is a catch-all")), "a package-root ** is refused");
assert.ok(lint.some((p) => p.startsWith("test:b: ** is a catch-all")), "a bare ** is refused");
assert.ok(lint.some((p) => p.startsWith("test:c: docs/adr/** is shadowed by docs/**")), "a glob a skip rule takes first is refused");
assert.ok(lint.some((p) => p.startsWith("test:d: cim/src/x.test.ts is shadowed by cim/src/**/*.test.ts")), "a path the unit rule takes first is refused");
assert.ok(!lint.some((p) => p.startsWith("test:e")), "a narrower directory glob is fine");

console.log(`test-test-select: all checks passed (${String(suite.length)} suite scripts mapped)`);
