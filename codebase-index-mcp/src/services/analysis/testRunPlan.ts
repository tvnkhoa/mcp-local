/**
 * R11: which runner would run each test, under which config, and the command line for it.
 *
 * NOTHING here executes anything. The package manager comes from the lockfile, the package from the
 * nearest `package.json`, the config from the nearest `vitest.config.*` / `vite.config.*` walking up
 * from the package directory (vitest's own `findUp` from the directory it runs in), and the config is
 * read lexically by `vitestConfig.ts`. A test file is resolved against its config's `include` /
 * `exclude`; one no config admits is reported with the reason instead of being put in a command
 * that would silently not run it.
 *
 * File access goes through `PlanFs` so the planning is unit-testable without a disk.
 */

import path from "node:path";
import {
  VITEST_CONFIG_NAMES,
  VITEST_DEFAULT_EXCLUDE,
  VITEST_DEFAULT_INCLUDE,
  VITEST_WORKSPACE_NAMES,
  matchesVitestGlobs,
  parseVitestConfigText,
  parseVitestWorkspaceText,
  type ParsedVitestConfig,
  type VitestProject
} from "./vitestConfig.js";
import { minimatch } from "minimatch";

/** Repo-relative POSIX paths. `read` returns null for a missing/unreadable file. */
export type PlanFs = { exists: (rel: string) => boolean; read: (rel: string) => string | null };

export type PackageManager = { manager: "pnpm" | "yarn" | "npm" | "bun"; lockfile: string | null; corepack: boolean };

const posix = path.posix;
const dirOf = (p: string) => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
};
const join = (a: string, b: string) => posix.normalize(a ? `${a}/${b}` : b).replace(/^\.\/?$/, "").replace(/\/$/, "");
const relTo = (from: string, to: string) => {
  const r = posix.relative(from || ".", to || ".");
  return r === "" ? "." : r;
};

function readJson(fs: PlanFs, rel: string): Record<string, unknown> | null {
  const t = fs.read(rel);
  if (t === null) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The package manager, from the repo-root lockfile; `packageManager` in the root package.json means corepack. */
export function detectPackageManager(fs: PlanFs): PackageManager {
  const rootPkg = readJson(fs, "package.json");
  const declared = typeof rootPkg?.["packageManager"] === "string" ? String(rootPkg["packageManager"]) : "";
  const corepack = /^(pnpm|yarn)@/.test(declared);
  const locks: [string, PackageManager["manager"]][] = [
    ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lockb", "bun"], ["bun.lock", "bun"], ["package-lock.json", "npm"]
  ];
  for (const [file, manager] of locks) {
    if (fs.exists(file)) return { manager, lockfile: file, corepack: corepack && declared.startsWith(manager) };
  }
  const fromField = /^(pnpm|yarn|npm|bun)@/.exec(declared)?.[1] as PackageManager["manager"] | undefined;
  return { manager: fromField ?? "npm", lockfile: null, corepack };
}

export type PackageInfo = { dir: string; name: string | null; json: Record<string, unknown> };

/** Nearest package.json at or above the file's directory (repo root included). */
export function findPackage(fs: PlanFs, file: string, cache: Map<string, PackageInfo | null>): PackageInfo | null {
  let dir = dirOf(file);
  const visited: string[] = [];
  for (;;) {
    if (cache.has(dir)) {
      const hit = cache.get(dir)!;
      for (const v of visited) cache.set(v, hit);
      return hit;
    }
    visited.push(dir);
    const json = readJson(fs, dir ? `${dir}/package.json` : "package.json");
    if (json) {
      const info: PackageInfo = { dir, name: typeof json["name"] === "string" ? String(json["name"]) : null, json };
      for (const v of visited) cache.set(v, info);
      return info;
    }
    if (dir === "") break;
    dir = dirOf(dir);
  }
  for (const v of visited) cache.set(v, null);
  return null;
}

/** Vitest's config lookup: nearest dir (walking up from `startDir`) holding a vitest/vite config. */
export function findVitestConfigFile(fs: PlanFs, startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    for (const name of VITEST_CONFIG_NAMES) {
      const rel = dir ? `${dir}/${name}` : name;
      if (fs.exists(rel)) return rel;
    }
    if (dir === "") return null;
    dir = dirOf(dir);
  }
}

function findWorkspaceFile(fs: PlanFs, startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    for (const name of VITEST_WORKSPACE_NAMES) {
      const rel = dir ? `${dir}/${name}` : name;
      if (fs.exists(rel)) return rel;
    }
    if (dir === "") return null;
    dir = dirOf(dir);
  }
}

function usesVitest(pkg: PackageInfo | null, root: PackageInfo | null, configFile: string | null, workspaceFile: string | null): boolean {
  const has = (p: PackageInfo | null) => {
    if (!p) return false;
    for (const k of ["dependencies", "devDependencies", "peerDependencies"]) {
      const d = p.json[k];
      if (d && typeof d === "object" && "vitest" in (d as object)) return true;
    }
    const scripts = p.json["scripts"];
    return !!scripts && typeof scripts === "object" && Object.values(scripts as Record<string, unknown>).some((s) => typeof s === "string" && /\bvitest\b/.test(s));
  };
  return has(pkg) || has(root) || (configFile !== null && /vitest\.config\./.test(configFile)) || workspaceFile !== null;
}

const NODE_TEST_IMPORT = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["']node:test["']/;
const JS_TEST_FILE = /\.(c|m)?[jt]sx?$|\.vue$/i;

export type PlannedTest = {
  testFile: string;
  runner: "vitest" | "unknown";
  package?: string | null;
  packageDir?: string;
  configFile?: string | null;
  projects?: string[];
  hint?: string;
  note?: string;
};

export type ExcludedTest = { testFile: string; reason: string; configFile: string | null };

export type RunGroup = {
  package: string | null;
  packageDir: string;
  configFile: string | null;
  configStatus: "read" | "defaults" | "unreadable";
  /** The vitest root the files are relative to (repo-relative, "" = repo root). */
  root: string;
  include: string[];
  exclude: string[];
  files: string[];
  command: string;
  notes: string[];
  /** With `test.projects`: which projects include each file. */
  projectsByFile?: Record<string, string[]>;
};

export type TestRunPlan = {
  packageManager: PackageManager;
  groups: RunGroup[];
  excluded: ExcludedTest[];
  other: PlannedTest[];
  configs: { configFile: string; status: "read" | "defaults" | "unreadable"; unreadable: string[] }[];
};

type ResolvedConfig = {
  file: string | null;
  parsed: ParsedVitestConfig | null;
  projects: VitestProject[] | null;
  workspaceFile: string | null;
  unreadable: string[];
};

function shellArg(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`;
}

/**
 * The command line for one group. Pure; unit-tested.
 *
 * Always the package's own vitest binary, run from the package directory — never a package manager.
 * wec.aria's acceptance of R11: `pnpm --filter … exec` rewrites tracked config (storeDir) and creates a
 * store inside a worktree other sessions share, which is why that repo forbids running pnpm at all; an
 * agent that copies the emitted command must not be able to dirty the tree. The binary needs the
 * package's node_modules to be installed already, and that is the caller's business.
 */
export function buildVitestCommand(runDir: string, root: string, files: readonly string[]): string {
  const rootArg = root !== runDir ? ` --root ${shellArg(relTo(runDir, root) || ".")}` : "";
  const fileArgs = files.map(shellArg).join(" ");
  const bin = "./node_modules/.bin/vitest";
  return runDir === "" ? `${bin} run${rootArg} ${fileArgs}` : `cd ${shellArg(runDir)} && ${bin} run${rootArg} ${fileArgs}`;
}

/**
 * Plan the given test files. `testFiles` are repo-relative; files are read through `fs` only to find
 * package.json / config files and to check a test for a `node:test` import.
 */
export function planTestRuns(testFiles: readonly string[], fs: PlanFs): TestRunPlan {
  const pm = detectPackageManager(fs);
  const pkgCache = new Map<string, PackageInfo | null>();
  const rootPkg = findPackage(fs, "package.json", pkgCache);
  const configCache = new Map<string, ResolvedConfig>();
  const groups = new Map<string, RunGroup>();
  const excluded: ExcludedTest[] = [];
  const other: PlannedTest[] = [];

  const resolveConfig = (runDir: string): ResolvedConfig => {
    const cached = configCache.get(runDir);
    if (cached) return cached;
    const file = findVitestConfigFile(fs, runDir);
    let parsed: ParsedVitestConfig | null = null;
    const unreadable: string[] = [];
    if (file) {
      const text = fs.read(file);
      if (text === null) unreadable.push("config file unreadable");
      else parsed = parseVitestConfigText(text);
    }
    let projects = parsed?.projects ?? null;
    let workspaceFile: string | null = null;
    if (!projects) {
      workspaceFile = findWorkspaceFile(fs, file ? dirOf(file) : runDir);
      if (workspaceFile) {
        const text = fs.read(workspaceFile);
        const ws = text === null ? { projects: null, unreadable: ["workspace file unreadable"] } : parseVitestWorkspaceText(text, workspaceFile.endsWith(".json"));
        projects = ws.projects;
        unreadable.push(...ws.unreadable);
      }
    }
    const resolved: ResolvedConfig = { file, parsed, projects, workspaceFile, unreadable: [...(parsed?.unreadable ?? []), ...unreadable] };
    configCache.set(runDir, resolved);
    return resolved;
  };

  for (const testFile of testFiles) {
    if (!JS_TEST_FILE.test(testFile)) {
      other.push({ testFile, runner: "unknown", note: "not a JS/TS test file; no runner command is derived for it" });
      continue;
    }
    const content = fs.read(testFile) ?? "";
    const pkg = findPackage(fs, testFile, pkgCache);
    if (NODE_TEST_IMPORT.test(content)) {
      other.push({ testFile, runner: "unknown", package: pkg?.name ?? null, hint: `node --test ${shellArg(testFile)}`, note: "imports node:test" });
      continue;
    }
    const runDir = pkg?.dir ?? dirOf(testFile);
    const cfg = resolveConfig(runDir);
    if (!usesVitest(pkg, rootPkg, cfg.file, cfg.workspaceFile)) {
      other.push({ testFile, runner: "unknown", package: pkg?.name ?? null, note: `no vitest dependency, vitest config or node:test import found for package ${pkg?.name ?? runDir ?? "(root)"}` });
      continue;
    }

    const parsed = cfg.parsed;
    const notes: string[] = [];
    // `root` resolves against the directory vitest runs in, as vitest's own `resolve(root)` does.
    const root = parsed?.root ? join(runDir, parsed.root) : runDir;
    const relToRoot = root ? (testFile.startsWith(`${root}/`) ? testFile.slice(root.length + 1) : null) : testFile;
    const includeUnreadable = cfg.unreadable.some((u) => /^(include|exclude|test|projects|workspace)\b/.test(u));
    let status: RunGroup["configStatus"] = !cfg.file || !parsed?.hasTestBlock ? "defaults" : "read";
    if (includeUnreadable) status = "unreadable";

    let include = parsed?.include ?? VITEST_DEFAULT_INCLUDE;
    let exclude = parsed?.exclude ?? VITEST_DEFAULT_EXCLUDE;
    let matchedProjects: string[] | undefined;
    let verdict: { ok: true } | { ok: false; reason: string };

    if (relToRoot === null) {
      verdict = { ok: false, reason: `outside the vitest root ${root || "(repo root)"} of ${cfg.file ?? "the default config"}` };
    } else if (includeUnreadable) {
      notes.push(`config not statically readable (${cfg.unreadable.join("; ")}); falling back to the package dir — every test file under it is treated as included`);
      verdict = { ok: true };
    } else if (cfg.projects && cfg.projects.length > 0) {
      const inline = cfg.projects.filter((p): p is Extract<VitestProject, { kind: "inline" }> => p.kind === "inline");
      const unreadableProjects = cfg.projects.filter((p) => p.kind === "unreadable");
      const pathProjects = cfg.projects.filter((p): p is Extract<VitestProject, { kind: "path" }> => p.kind === "path");
      const reasons: string[] = [];
      matchedProjects = [];
      for (const p of inline) {
        const pRoot = p.root ? join(root, p.root) : root;
        const pRel = pRoot ? (testFile.startsWith(`${pRoot}/`) ? testFile.slice(pRoot.length + 1) : null) : testFile;
        const label = p.name ?? `project#${String(inline.indexOf(p) + 1)}`;
        if (p.unreadable.length > 0) {
          matchedProjects.push(label);
          notes.push(`project ${label} not statically readable (${p.unreadable.join("; ")}); assumed to include it`);
          continue;
        }
        if (pRel === null) { reasons.push(`${label}: outside its root ${pRoot}`); continue; }
        const m = matchesVitestGlobs(pRel, p.include ?? VITEST_DEFAULT_INCLUDE, p.exclude ?? exclude);
        if (m.included) matchedProjects.push(label);
        else reasons.push(m.excludedBy ? `${label}: excluded by "${m.excludedBy}"` : `${label}: not matched by include ${JSON.stringify(p.include ?? VITEST_DEFAULT_INCLUDE)}`);
      }
      // A path project (`packages/*`) delegates to that directory's own config, which the walk from the
      // package dir would have found first; reaching here means the package has none, so the defaults apply.
      for (const p of pathProjects) {
        const cfgDir = cfg.file ? dirOf(cfg.file) : "";
        const pkgRel = relTo(cfgDir, runDir);
        if (minimatch(pkgRel, p.glob.replace(/^\.\//, "").replace(/\/$/, "")) || minimatch(pkgRel, dirOf(p.glob.replace(/^\.\//, "")))) {
          const m = matchesVitestGlobs(relToRoot, VITEST_DEFAULT_INCLUDE, VITEST_DEFAULT_EXCLUDE);
          if (m.included) matchedProjects.push(p.glob);
          else reasons.push(`${p.glob}: not matched by the default include`);
        }
      }
      for (const u of unreadableProjects) notes.push(`a project entry is not statically readable (${u.kind === "unreadable" ? u.reason : ""})`);
      include = inline.flatMap((p) => p.include ?? []);
      exclude = [];
      verdict = matchedProjects.length > 0 || unreadableProjects.length > 0
        ? { ok: true }
        : { ok: false, reason: `no project of ${cfg.file ?? cfg.workspaceFile ?? "the config"} includes it (${reasons.join("; ") || "no project applies to this package"})` };
    } else {
      const m = matchesVitestGlobs(relToRoot, include, exclude);
      verdict = m.included
        ? { ok: true }
        : { ok: false, reason: m.excludedBy ? `excluded by "${m.excludedBy}" in ${cfg.file ?? "vitest defaults"}` : `not matched by include ${JSON.stringify(include)} of ${cfg.file ?? "vitest defaults"} (root ${root || "(repo root)"})` };
    }

    if (!verdict.ok) {
      excluded.push({ testFile, reason: verdict.reason, configFile: cfg.file });
      continue;
    }

    const key = `${runDir}\u0000${cfg.file ?? ""}\u0000${root}`;
    let g = groups.get(key);
    if (!g) {
      g = { package: pkg?.name ?? null, packageDir: runDir, configFile: cfg.file, configStatus: status, root, include, exclude, files: [], command: "", notes: [] };
      if (status === "defaults") g.notes.push(cfg.file ? `${cfg.file} has no test block: vitest defaults apply` : "no vitest config found: vitest defaults apply");
      groups.set(key, g);
    }
    for (const n of notes) if (!g.notes.includes(n)) g.notes.push(n);
    const rel = relToRoot ?? testFile;
    if (!g.files.includes(rel)) g.files.push(rel);
    if (matchedProjects && matchedProjects.length > 0) (g.projectsByFile ??= {})[rel] = matchedProjects;
  }

  const out = [...groups.values()].sort((a, b) => a.packageDir.localeCompare(b.packageDir));
  for (const g of out) {
    g.files.sort();
    g.command = buildVitestCommand(g.packageDir, g.root, g.files);
  }
  const configs = [...configCache.values()]
    .filter((c) => c.file)
    .map((c) => ({
      configFile: c.file!,
      status: (c.unreadable.length > 0 ? "unreadable" : c.parsed?.hasTestBlock ? "read" : "defaults") as "read" | "defaults" | "unreadable",
      unreadable: c.unreadable
    }));
  return { packageManager: pm, groups: out, excluded, other, configs };
}
