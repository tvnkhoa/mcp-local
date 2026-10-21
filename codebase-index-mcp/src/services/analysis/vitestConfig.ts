/**
 * R11 (wec.aria release G): read a vitest config WITHOUT executing it.
 *
 * `link_tests_to_source(forWorkingTreeDiff: true)` has to say which config would run a test and
 * whether that config's `include` admits it. Executing a config file is out of the question — it is
 * code from the indexed repo, and this server reads, it does not run. So the config is read
 * lexically: comments stripped, the `test: { ... }` object found by brace matching, and only LITERAL
 * values taken — a string, an array of strings, an object of those. Anything else (an identifier, a
 * spread, a call, a template with `${}`) makes that key `unreadable`, and the caller says so and falls
 * back to the package directory rather than guessing.
 *
 * Pure: no fs, no git. Unit-tested in vitestConfig.test.ts.
 */

import { minimatch } from "minimatch";

/** Vitest's own default `include` (vitest 1-4). */
export const VITEST_DEFAULT_INCLUDE = ["**/*.{test,spec}.?(c|m)[jt]s?(x)"];
/** Vitest 4's default `exclude` (3.x also excluded dist/cypress/config files; 4 narrowed it to these). */
export const VITEST_DEFAULT_EXCLUDE = ["**/node_modules/**", "**/.git/**"];

export const VITEST_CONFIG_NAMES = [
  "vitest.config.ts", "vitest.config.mts", "vitest.config.cts", "vitest.config.js", "vitest.config.mjs", "vitest.config.cjs",
  "vite.config.ts", "vite.config.mts", "vite.config.cts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"
];
export const VITEST_WORKSPACE_NAMES = [
  "vitest.workspace.ts", "vitest.workspace.mts", "vitest.workspace.js", "vitest.workspace.mjs", "vitest.workspace.json"
];

/** A literal value, or the marker for one that cannot be read without running the file. */
export type Lit = string | number | boolean | null | Lit[] | { [key: string]: Lit } | Unreadable;
export type Unreadable = { unreadable: string };

export function isUnreadable(v: unknown): v is Unreadable {
  return typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as Unreadable).unreadable === "string" && Object.keys(v).length === 1;
}

/** One project of a `test.projects` array or a `vitest.workspace` file. */
export type VitestProject =
  | { kind: "inline"; name: string | null; include: string[] | null; exclude: string[] | null; root: string | null; unreadable: string[] }
  | { kind: "path"; glob: string }
  | { kind: "unreadable"; reason: string };

export type ParsedVitestConfig = {
  /** A `test: { ... }` object was found. Without one vitest applies its defaults. */
  hasTestBlock: boolean;
  /** `test.include` as written; null when absent (defaults apply) or unreadable (see `unreadable`). */
  include: string[] | null;
  exclude: string[] | null;
  /** `test.root`, else the config's top-level `root`; null when neither is a literal. */
  root: string | null;
  projects: VitestProject[] | null;
  /** Keys that were present but not statically readable, with why: `include: identifier baseInclude`. */
  unreadable: string[];
};

// ── lexing ───────────────────────────────────────────────────────────────────

/** Replace comments with spaces (offsets kept), leaving string and template contents intact. */
export function stripJsComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (c === "/" && n === "*") {
      out += "  "; i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { out += src[i] === "\n" ? "\n" : " "; i++; }
      if (i < src.length) { out += "  "; i += 2; }
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const end = skipString(src, i);
      out += src.slice(i, end); i = end;
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** Index just past the string starting at `i` (a quote char). Unterminated → end of input. */
function skipString(src: string, i: number): number {
  const q = src[i];
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === "\\") { j += 2; continue; }
    if (src[j] === q) return j + 1;
    j++;
  }
  return src.length;
}

/** Index just past the bracket group opening at `i` (`{`, `[` or `(`), string-aware. */
function skipGroup(src: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j]!;
    if (c === "'" || c === '"' || c === "`") { j = skipString(src, j); continue; }
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return src.length;
}

/** Split the inside of a group at top-level commas. */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let j = 0;
  while (j < inner.length) {
    const c = inner[j]!;
    if (c === "'" || c === '"' || c === "`") { j = skipString(inner, j); continue; }
    if (c === "{" || c === "[" || c === "(") { j = skipGroup(inner, j); continue; }
    if (c === ",") { parts.push(inner.slice(start, j)); start = j + 1; }
    j++;
  }
  parts.push(inner.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function unquote(s: string): string | null {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === "'" || t[0] === '"') && t[t.length - 1] === t[0]) {
    return t.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  if (t.length >= 2 && t[0] === "`" && t[t.length - 1] === "`" && !t.includes("${")) return t.slice(1, -1);
  return null;
}

/** Parse one literal expression. A non-literal becomes `{ unreadable }` naming what it was. */
export function parseLiteral(text: string): Lit {
  const t = text.trim().replace(/\s+as\s+const$/, "").replace(/\s+satisfies\s+[\w.<>[\]]+$/, "");
  const s = unquote(t);
  if (s !== null) return s;
  if (t.startsWith("`")) return { unreadable: "template literal with ${}" };
  if (/^-?\d+(\.\d+)?(_\d+)*$/.test(t.replace(/_/g, ""))) return Number(t.replace(/_/g, ""));
  if (t === "true" || t === "false") return t === "true";
  if (t === "null" || t === "undefined") return null;
  if (t.startsWith("[") && skipGroup(t, 0) === t.length) {
    return splitTopLevel(t.slice(1, -1)).map((el) => (el.startsWith("...") ? { unreadable: `spread ${el.slice(3).trim().slice(0, 40)}` } : parseLiteral(el)));
  }
  if (t.startsWith("{") && skipGroup(t, 0) === t.length) return parseObject(t);
  // `defineProject({...})`, `defineConfig({...})`: the one-object call is the object.
  const call = /^(defineProject|defineConfig|defineWorkspace)\s*\(/.exec(t);
  if (call) {
    const open = t.indexOf("(");
    if (skipGroup(t, open) === t.length) {
      const args = splitTopLevel(t.slice(open + 1, -1));
      if (args.length === 1) return parseLiteral(args[0]!);
    }
  }
  return { unreadable: describeExpr(t) };
}

function describeExpr(t: string): string {
  if (/^[A-Za-z_$][\w$]*$/.test(t)) return `identifier ${t}`;
  if (/^[A-Za-z_$][\w$.]*\s*\(/.test(t)) return `call ${t.slice(0, t.indexOf("(")).trim()}()`;
  return `expression ${t.slice(0, 40)}`;
}

/** Parse `{ key: value, ... }`. Shorthand and spread members are kept as unreadable entries. */
function parseObject(t: string): { [key: string]: Lit } {
  const obj: { [key: string]: Lit } = {};
  for (const member of splitTopLevel(t.slice(1, -1))) {
    if (member.startsWith("...")) { obj[`...${member.slice(3).trim().slice(0, 40)}`] = { unreadable: "spread" }; continue; }
    const m = /^(?:(['"])(.*?)\1|([A-Za-z_$][\w$]*))\s*:/.exec(member);
    if (!m) {
      const short = /^[A-Za-z_$][\w$]*$/.exec(member);
      if (short) obj[member] = { unreadable: `shorthand ${member}` };
      continue; // a method, a computed key: not something vitest's include/root comes from
    }
    const key = m[2] ?? m[3]!;
    obj[key] = parseLiteral(member.slice(m[0].length));
  }
  return obj;
}

// ── config extraction ────────────────────────────────────────────────────────

/** Every `{` position whose object literal holds the key `key:` at its top level, in source order. */
function findObjectsHoldingKey(src: string, key: string): { open: number; keyAt: number }[] {
  const hits: { open: number; keyAt: number }[] = [];
  const stack: number[] = [];
  const re = new RegExp(`^${key}\\s*:`);
  let j = 0;
  while (j < src.length) {
    const c = src[j]!;
    if (c === "'" || c === '"' || c === "`") {
      // A quoted key: 'test': { ... }
      const end = skipString(src, j);
      if (src.slice(j + 1, end - 1) === key && /^\s*:/.test(src.slice(end)) && stack.length > 0) {
        hits.push({ open: stack[stack.length - 1]!, keyAt: j });
      }
      j = end;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") { stack.push(c === "{" ? j : -1); j++; continue; }
    if (c === "}" || c === "]" || c === ")") { stack.pop(); j++; continue; }
    if (/[A-Za-z_$]/.test(c) && !/[\w$.]/.test(src[j - 1] ?? " ")) {
      const top = stack[stack.length - 1];
      if (top !== undefined && top >= 0 && re.test(src.slice(j, j + key.length + 20))) {
        // Must be a property position: preceded (ignoring space) by `{` or `,`.
        const before = src.slice(0, j).trimEnd();
        if (before.endsWith("{") || before.endsWith(",")) hits.push({ open: top, keyAt: j });
      }
      while (j < src.length && /[\w$]/.test(src[j]!)) j++;
      continue;
    }
    j++;
  }
  return hits;
}

function asStringArray(v: Lit | undefined, key: string, unreadable: string[]): string[] | null {
  if (v === undefined || v === null) return null;
  if (isUnreadable(v)) { unreadable.push(`${key}: ${v.unreadable}`); return null; }
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) {
    const bad = v.find((x) => typeof x !== "string");
    if (bad !== undefined) { unreadable.push(`${key}: ${isUnreadable(bad) ? bad.unreadable : "non-string element"}`); return null; }
    return v as string[];
  }
  unreadable.push(`${key}: not an array`);
  return null;
}

function asString(v: Lit | undefined, key: string, unreadable: string[]): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  unreadable.push(`${key}: ${isUnreadable(v) ? v.unreadable : "not a string"}`);
  return null;
}

function toProjects(v: Lit, unreadable: string[], key: string): VitestProject[] | null {
  if (isUnreadable(v)) { unreadable.push(`${key}: ${v.unreadable}`); return null; }
  if (!Array.isArray(v)) { unreadable.push(`${key}: not an array`); return null; }
  return v.map((el): VitestProject => {
    if (typeof el === "string") return { kind: "path", glob: el };
    if (isUnreadable(el)) return { kind: "unreadable", reason: el.unreadable };
    if (el && typeof el === "object" && !Array.isArray(el)) {
      const pu: string[] = [];
      const test = el["test"];
      const t = test && typeof test === "object" && !Array.isArray(test) && !isUnreadable(test) ? test : {};
      if (test !== undefined && isUnreadable(test)) pu.push(`test: ${test.unreadable}`);
      return {
        kind: "inline",
        name: asString(t["name"], "name", pu),
        include: asStringArray(t["include"], "include", pu),
        exclude: asStringArray(t["exclude"], "exclude", pu),
        root: asString(t["root"], "root", pu) ?? asString(el["root"], "root", pu),
        unreadable: pu
      };
    }
    return { kind: "unreadable", reason: "not a string or object" };
  });
}

/** Read `include`, `exclude`, `root` and `projects` out of a vitest/vite config's source text. */
export function parseVitestConfigText(text: string): ParsedVitestConfig {
  const src = stripJsComments(text);
  const unreadable: string[] = [];
  const hits = findObjectsHoldingKey(src, "test");
  // The OUTERMOST object holding `test:` is the config; a `test:` inside `projects: [{ test }]` is a
  // project, read through `projects`.
  let config: { [key: string]: Lit } | null = null;
  for (const hit of hits) {
    const end = skipGroup(src, hit.open);
    const parsed = parseLiteral(src.slice(hit.open, end));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && !isUnreadable(parsed)) {
      const t = parsed["test"];
      if (t !== undefined) { config = parsed; break; }
    }
  }
  if (!config) {
    return { hasTestBlock: false, include: null, exclude: null, root: null, projects: null, unreadable };
  }
  const testVal = config["test"]!;
  if (isUnreadable(testVal) || typeof testVal !== "object" || testVal === null || Array.isArray(testVal)) {
    unreadable.push(`test: ${isUnreadable(testVal) ? testVal.unreadable : "not an object"}`);
    return { hasTestBlock: true, include: null, exclude: null, root: asString(config["root"], "root", unreadable), projects: null, unreadable };
  }
  const test = testVal;
  for (const k of Object.keys(test)) {
    if (k.startsWith("...")) unreadable.push(`test: spread ${k.slice(3)}`);
  }
  const include = asStringArray(test["include"], "include", unreadable);
  const exclude = asStringArray(test["exclude"], "exclude", unreadable);
  const root = asString(test["root"], "test.root", unreadable) ?? asString(config["root"], "root", unreadable);
  const projectsVal = test["projects"] ?? test["workspace"];
  const projects = projectsVal === undefined ? null : toProjects(projectsVal, unreadable, "projects");
  return { hasTestBlock: true, include, exclude, root, projects, unreadable };
}

/** A `vitest.workspace.*` file: its default-exported array, or JSON array. */
export function parseVitestWorkspaceText(text: string, isJson: boolean): { projects: VitestProject[] | null; unreadable: string[] } {
  const unreadable: string[] = [];
  if (isJson) {
    try {
      const v = JSON.parse(text) as Lit;
      return { projects: toProjects(v, unreadable, "workspace"), unreadable };
    } catch {
      return { projects: null, unreadable: ["workspace: invalid JSON"] };
    }
  }
  const src = stripJsComments(text);
  const m = /export\s+default\s+/.exec(src);
  if (!m) return { projects: null, unreadable: ["workspace: no default export"] };
  let rest = src.slice(m.index + m[0].length).trim();
  const call = /^defineWorkspace\s*\(/.exec(rest);
  if (call) rest = rest.slice(rest.indexOf("(") + 1).trim();
  if (!rest.startsWith("[")) return { projects: null, unreadable: [`workspace: ${describeExpr(rest.split(/[;\n]/)[0] ?? "")}`] };
  const arr = parseLiteral(rest.slice(0, skipGroup(rest, 0)));
  return { projects: toProjects(arr, unreadable, "workspace"), unreadable };
}

// ── matching ─────────────────────────────────────────────────────────────────

const GLOB_OPTS = { dot: true, nocase: false } as const;

/** `relPath` (POSIX, relative to the vitest root) against include/exclude globs. */
export function matchesVitestGlobs(relPath: string, include: readonly string[], exclude: readonly string[]): { included: boolean; excludedBy: string | null; includeMiss: boolean } {
  const norm = (g: string) => g.replace(/^\.\//, "");
  const inc = include.some((g) => minimatch(relPath, norm(g), GLOB_OPTS));
  if (!inc) return { included: false, excludedBy: null, includeMiss: true };
  const ex = exclude.find((g) => minimatch(relPath, norm(g), GLOB_OPTS));
  return ex ? { included: false, excludedBy: ex, includeMiss: false } : { included: true, excludedBy: null, includeMiss: false };
}
