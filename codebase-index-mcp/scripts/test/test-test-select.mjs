/**
 * `run-tests.mjs --changed` (row V-E): scripts/test-map.json covers every suite script, and the
 * selection over it fails safe — an unmapped change runs the whole suite, an unmapped script always
 * runs, and only `skip` paths (other servers, pure docs) are left out. `--mapped-only` (row P1) turns the
 * whole-suite fallback off: section 8 runs the CLI over a scratch git repo with and without it. Hub files
 * (row 17) get narrow entries (section 9), and --mapped-only caps the mapped harnesses at --max (default
 * 12): over it the CLI prints the selection and exits 3 without running anything (section 10).
 *
 * Usage: node scripts/test/test-test-select.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

r = selectForChanges({ changed: ["cim/scripts/test/b.mjs", "scripts/new-thing.mjs"], map: small, suite: smallSuite, mappedOnly: true });
assert.equal(r.whole, false, "mappedOnly: an uncovered file does not widen the run");
assert.deepEqual(r.uncovered, ["scripts/new-thing.mjs"], "mappedOnly: the uncovered file is still reported");
assert.deepEqual(names(r), ["test:unit", "test:b", "test:unmapped"], "mappedOnly: the mapped harnesses plus what always runs");

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
assert.equal(real(["scripts/serve-http.mjs", "scripts/new-server.mjs"]).whole, true, "an unlisted root script beside a none file still selects the whole suite");
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

// 8. The CLI, end to end: run-tests.mjs --changed <base> --list over a scratch repo (GIT_DIR / GIT_WORK_TREE point
// git there) whose change touches one mapped file and one unmapped file.
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "test-select-"));
  const env = { ...process.env, GIT_DIR: path.join(repo, ".git"), GIT_WORK_TREE: repo, CI: "true" };
  const git = (...args) => {
    const out = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
    assert.equal(out.status, 0, `git ${args.join(" ")}: ${out.stderr}`);
    return out.stdout.trim();
  };
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  git("init", "-q");
  write("codebase-index-mcp/scripts/test/test-test-select.mjs", "// base\n");
  write("scripts/new-thing.mjs", "// base\n");
  git("add", "codebase-index-mcp/scripts/test/test-test-select.mjs", "scripts/new-thing.mjs");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  write("codebase-index-mcp/scripts/test/test-test-select.mjs", "// changed\n");
  write("scripts/new-thing.mjs", "// changed\n");

  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "run-tests.mjs"), ...args], { cwd: ROOT, env, encoding: "utf8" });
  // The --list block: the lines after "<n> script(s):", minus the (excluded) notes.
  const listed = (out) => {
    const lines = out.stdout.split(/\r?\n/);
    const head = lines.findIndex((l) => /^\d+ script\(s\):$/.test(l));
    assert.ok(head >= 0, out.stdout);
    return lines.slice(head + 1).filter((l) => l.startsWith("  ") && !l.includes("(excluded)")).map((l) => l.trim());
  };

  const whole = cli("--changed", base, "--list");
  assert.equal(whole.status, 0, whole.stderr);
  assert.match(whole.stdout, /not in test-map\.json → WHOLE SUITE: scripts\/new-thing\.mjs/);
  assert.deepEqual(listed(whole), suite, "without --mapped-only the unmapped file still lists the whole suite");

  const mapped = cli("--changed", base, "--mapped-only", "--list");
  assert.equal(mapped.status, 0, `unmapped files alone exit 0: ${mapped.stderr}`);
  assert.match(mapped.stderr, /WARNING not in test-map\.json.*scripts\/new-thing\.mjs/, "the unmapped file is a warning");
  const expected = selectForChanges({ changed: ["codebase-index-mcp/scripts/test/test-test-select.mjs"], map, suite }).selected.map((s) => s.name);
  assert.deepEqual(listed(mapped), expected, "--mapped-only lists exactly the mapped set plus what always runs");
  assert.ok(expected.includes("test:test-select") && expected.length < suite.length);

  const badBase = cli("--changed", "no-such-ref", "--mapped-only", "--list");
  assert.equal(badBase.status, 2, "--mapped-only with a base that does not resolve exits 2, never a silent pass");
  assert.equal(cli("--mapped-only", "--list").status, 2, "--mapped-only without --changed is a usage error");
  fs.rmSync(repo, { recursive: true, force: true });
}

// 9. Hub files: no group reaches them, each is named by exactly the harnesses `hubs` gives a reason for, and a
// change to one maps to at most 12 harnesses — not the 66/71 that @dist selected (row 17, 17 Nov).
const groupRes = Object.values(map.groups).flat().map(globToRegExp);
const mappedOf = (r) => r.selected.filter((s) => !["always runs", "no map entry (fail safe)"].includes(s.why)).map((s) => s.name);
assert.ok(Object.keys(map.hubs ?? {}).length >= 5, "the hub files are declared");
for (const [hub, { why, harnesses }] of Object.entries(map.hubs)) {
  assert.ok(typeof why === "string" && why.length > 0, `${hub}: hubs gives a reason`);
  assert.ok(!groupRes.some((re) => re.test(hub)), `${hub}: a hub must not be reachable through a group (it would select every @dist harness)`);
  for (const [name, reason] of Object.entries(harnesses)) {
    assert.ok(typeof reason === "string" && reason.length > 0, `${hub}: ${name} has a reason`);
    assert.ok(map.harnesses[name]?.includes(hub), `${hub}: hubs names ${name}, which does not list it`);
  }
  const listing = Object.entries(map.harnesses).filter(([, entries]) => entries.includes(hub)).map(([name]) => name).sort();
  assert.deepEqual(listing, Object.keys(harnesses).sort(), `${hub}: every harness listing it has a reason in hubs`);
  const hit = real([hub]);
  assert.equal(hit.whole, false, `${hub}: covered`);
  assert.deepEqual(mappedOf(hit).sort(), Object.keys(harnesses).sort(), `${hub}: selects exactly its narrow entry`);
  assert.ok(mappedOf(hit).length <= 12, `${hub}: ${String(mappedOf(hit).length)} harnesses > 12`);
}
// Narrowing the directory globs left no sibling uncovered: every non-test .ts in those directories still reaches @dist.
for (const dir of ["middleware", "repositories", "resources", "services/indexing"]) {
  for (const f of fs.readdirSync(path.join(ROOT, "src", dir)).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
    const file = `codebase-index-mcp/src/${dir}/${f}`;
    if (file in map.hubs) continue;
    assert.ok(groupRes.some((re) => re.test(file)), `${file}: listed in @dist`);
  }
}

// 10. --max: over the cap the CLI prints the selection and exits 3, running nothing; the merge-gate path
// (--changed without --mapped-only) has no cap and keeps its whole-suite fail safe.
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "test-select-max-"));
  const env = { ...process.env, GIT_DIR: path.join(repo, ".git"), GIT_WORK_TREE: repo, CI: "true" };
  const git = (...args) => {
    const out = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
    assert.equal(out.status, 0, `git ${args.join(" ")}: ${out.stderr}`);
    return out.stdout.trim();
  };
  const SERVER = "codebase-index-mcp/src/server.ts";
  const HUB = "codebase-index-mcp/src/middleware/freshness.ts";
  const NEW = "scripts/new-thing.mjs";
  for (const rel of [SERVER, HUB, NEW]) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), "// base\n");
  }
  git("init", "-q");
  git("add", SERVER, HUB, NEW);
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "run-tests.mjs"), ...args], { cwd: ROOT, env, encoding: "utf8" });
  const change = (...rels) => {
    for (const rel of [SERVER, HUB, NEW]) fs.writeFileSync(path.join(repo, rel), rels.includes(rel) ? "// changed\n" : "// base\n");
  };
  const listedCount = (out) => Number(/^(\d+) script\(s\):$/m.exec(out.stdout)?.[1]);

  change(SERVER); // in @dist: every harness that runs against dist/
  const dist = selectForChanges({ changed: [SERVER], map, suite });
  assert.ok(mappedOf(dist).length > 12, "precondition: a @dist file maps to more than 12 harnesses");
  const capped = cli("--changed", base, "--mapped-only", "--list");
  assert.equal(capped.status, 3, `over the default cap exits 3: ${capped.stderr}`);
  assert.ok(capped.stdout.includes(`selected ${String(dist.selected.length)}/${String(suite.length)}:`), "the selection is printed");
  assert.match(capped.stderr, /--max 12: the change maps to \d+ harnesses \(listed above\) — nothing was run/);
  assert.ok(Number.isNaN(listedCount(capped)), "nothing is listed as to-run");
  const cappedRun = cli("--changed", base, "--mapped-only");
  assert.equal(cappedRun.status, 3, "without --list too: exit 3 before the heavy lock or any harness");
  assert.doesNotMatch(cappedRun.stdout, /^ok\s/m, "no harness ran");
  assert.equal(cli("--changed", base, "--mapped-only", "--max", "999", "--list").status, 0, "a raised --max lets it through");
  const gate = cli("--changed", base, "--list");
  assert.equal(gate.status, 0, "the merge-gate path (no --mapped-only) has no cap");
  assert.equal(listedCount(gate), dist.selected.length);
  assert.equal(cli("--changed", base, "--max", "5", "--list").status, 3, "an explicit --max applies without --mapped-only too");

  change(HUB); // a hub: its narrow entry, under the cap
  const hub = cli("--changed", base, "--mapped-only", "--list");
  assert.equal(hub.status, 0, hub.stderr);
  assert.ok(hub.stdout.includes(`test:freshness-worker ← ${HUB}`));
  assert.equal(listedCount(hub), selectForChanges({ changed: [HUB], map, suite }).selected.length);

  change(SERVER, NEW); // an unmapped file: the merge gate still runs the whole suite, never capped
  const whole = cli("--changed", base, "--list");
  assert.equal(whole.status, 0);
  assert.match(whole.stdout, /not in test-map\.json → WHOLE SUITE: scripts\/new-thing\.mjs/);
  assert.equal(listedCount(whole), suite.length, "whole suite, never capped");

  for (const bad of [["--max", "0"], ["--max", "x"], ["--max"]]) {
    assert.equal(cli("--changed", base, "--mapped-only", ...bad, "--list").status, 2, `${bad.join(" ")} is a usage error`);
  }
  assert.equal(cli("--max", "5", "--list").status, 2, "--max without --changed is a usage error");
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(`test-test-select: all checks passed (${String(suite.length)} suite scripts mapped)`);
