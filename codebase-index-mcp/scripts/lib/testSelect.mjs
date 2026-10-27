/**
 * Which scripts make up the suite, and which of them a change needs (row V-E, 2026-10-27).
 *
 * `run-tests.mjs --changed [<base>]` runs only the harnesses whose declared paths a change touches.
 * The declaration is `scripts/test-map.json`, checked in, so the selection is reviewable and
 * `test:test-select` fails when a `test:*` script has no entry.
 *
 * Fail safe in every direction: a changed file no glob covers selects the WHOLE suite, a script with
 * no entry is always selected, and a base that cannot be resolved runs everything. Only paths the map
 * names as `skip` (other servers, pure docs) are ignored, and the output says so.
 *
 * Map paths are relative to the git top level (the workspace root), forward slashes. Globs know `**`
 * (any depth, including none), `*` (within one segment) and `?`; a pattern with no `/` matches at the
 * top level only. An entry starting with `@` names a group in `groups`.
 */

import { execFileSync } from "node:child_process";

/**
 * Non-`test:*` scripts that are nonetheless part of the suite.
 * `guard:no-llm-runtime` enforces the hard no-LLM policy and must never be
 * optional; `verify:enhancements` is a test script that predates the naming
 * convention.
 */
export const EXTRA = ["guard:no-llm-runtime", "verify:enhancements"];

/**
 * Deliberately excluded, with the reason. Anything added here must be run
 * somewhere else — see `.github/workflows/ci.yml`.
 */
export const EXCLUDED = {
  "benchmark:plan:check": "a performance gate, not a correctness test; run as its own CI step",
  // Discovery would otherwise find the alias that invokes THIS runner, and recurse until the
  // process table gives up. `test:integration` is a name for "everything except the unit suite",
  // which is a flag here, not a script to spawn.
  "test:integration": "an alias for this runner (--integration-only); spawning it would recurse"
};

/** Every script in the suite, `test:unit` first — a compile-level break should not wait behind ~60 harnesses. */
export function suiteScripts(scripts) {
  return [
    ...EXTRA.filter((name) => name in scripts),
    ...Object.keys(scripts)
      .filter((name) => name.startsWith("test:"))
      .sort()
  ]
    .filter((name) => !(name in EXCLUDED))
    .sort((a, b) => (a === "test:unit" ? -1 : b === "test:unit" ? 1 : 0));
}

export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** A harness's globs with `@group` references expanded. */
function expand(entries, groups) {
  return entries.flatMap((entry) => (entry.startsWith("@") ? (groups[entry.slice(1)] ?? []) : [entry]));
}

/**
 * Pure selection: changed paths + the map + the suite → what runs and why.
 *
 * Returns `{ whole, selected: [{ name, why }], skipped: [{ file, reason }], unitOnly, uncovered }`.
 */
export function selectForChanges({ changed, map, suite }) {
  const groups = map.groups ?? {};
  const matcher = (globs) => {
    const res = globs.map(globToRegExp);
    return (file) => res.some((re) => re.test(file));
  };
  const skips = Object.entries(map.skip ?? {}).map(([reason, globs]) => ({ reason, test: matcher(globs) }));
  const unit = matcher(map.unit ?? []);
  const harnesses = Object.entries(map.harnesses ?? {}).map(([name, entries]) => ({ name, test: matcher(expand(entries, groups)) }));
  const always = new Set(map.always ?? []);

  const skipped = [];
  const unitOnly = [];
  const uncovered = [];
  const hits = new Map();
  for (const file of changed) {
    const skip = skips.find((s) => s.test(file));
    if (skip !== undefined) {
      skipped.push({ file, reason: skip.reason });
      continue;
    }
    if (unit(file)) {
      unitOnly.push(file);
      continue;
    }
    const matched = harnesses.filter((h) => h.test(file));
    if (matched.length === 0) uncovered.push(file);
    for (const h of matched) hits.set(h.name, [...(hits.get(h.name) ?? []), file]);
  }

  const whole = uncovered.length > 0;
  const selected = [];
  for (const name of suite) {
    if (whole) selected.push({ name, why: "whole suite" });
    else if (always.has(name)) selected.push({ name, why: "always runs" });
    else if (!(name in (map.harnesses ?? {}))) selected.push({ name, why: "no map entry (fail safe)" });
    else if (hits.has(name)) selected.push({ name, why: describeFiles(hits.get(name)) });
  }
  return { whole, selected, skipped, unitOnly, uncovered };
}

function describeFiles(files) {
  return files.length <= 2 ? files.join(", ") : `${files.slice(0, 2).join(", ")}, +${String(files.length - 2)} more`;
}

/**
 * What is wrong with the map, as a list of messages — empty when it is sound.
 * `exists(path)` answers for a literal (wildcard-free) path relative to the git top level.
 */
export function checkMap({ map, suite, exists }) {
  const problems = [];
  const groups = map.groups ?? {};
  const always = new Set(map.always ?? []);
  const harnesses = map.harnesses ?? {};
  for (const name of suite) {
    if (!always.has(name) && !(name in harnesses)) problems.push(`${name}: no entry in test-map.json harnesses (or always)`);
  }
  for (const name of [...always, ...Object.keys(harnesses)]) {
    if (!suite.includes(name)) problems.push(`${name}: in test-map.json but not a script in the suite`);
  }
  const literals = [...(map.unit ?? []), ...Object.values(map.skip ?? {}).flat(), ...Object.values(groups).flat()];
  for (const [name, entries] of Object.entries(harnesses)) {
    if (entries.length === 0) problems.push(`${name}: empty entry — every harness depends on something`);
    for (const entry of entries) {
      if (entry.startsWith("@")) {
        if (!(entry.slice(1) in groups)) problems.push(`${name}: unknown group ${entry}`);
      } else literals.push(entry);
    }
  }
  for (const glob of literals) {
    if (!/[*?]/.test(glob) && !exists(glob)) problems.push(`${glob}: no such file (a typo selects nothing)`);
  }
  return problems;
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Files changed since `base` (default: the merge-base with origin/main): committed, staged,
 * unstaged and untracked, relative to the git top level. Deletions and both sides of a rename count.
 */
export function changedFiles({ cwd, base }) {
  const top = git(["rev-parse", "--show-toplevel"], cwd);
  const from = base ?? git(["merge-base", "HEAD", "origin/main"], top);
  const lines = [
    ...git(["diff", "--name-only", "--no-renames", from], top).split("\n"),
    ...git(["ls-files", "--others", "--exclude-standard"], top).split("\n")
  ];
  return { top, base: from, files: [...new Set(lines.filter(Boolean))].sort() };
}
