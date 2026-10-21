/**
 * R3 exact — one TypeScript LanguageService per repo, built lazily and kept warm.
 *
 * Blueprint: the R3 spike (2026-10-20, wec.aria: 804 root files, 2 774 program files, 16.7 s cold,
 * ~1 GB RSS, warm `findReferences` 4-65 ms). A rebuild per query is not viable, so the host lives in
 * a small LRU (max {@link MAX_CACHED_HOSTS}) keyed by repo.
 *
 * **Documented simplification — one union program per repo, not one per tsconfig.** tsserver builds
 * a project per tsconfig; wec.aria alone has ~70 (per-package, per-directory composite sub-projects,
 * test/server variants, deliberately broken `violations/` configs). This host instead builds ONE
 * program over every indexed TS/JS file, with the compiler options of the repo's BASE tsconfig
 * (`tsconfig.base.json`, else `tsconfig.json`, else `jsconfig.json` at the repo root; TypeScript
 * defaults when none), overridden with `allowJs: true`, `checkJs: false`, `noEmit: true`,
 * `composite: false` and no `rootDir`/`outDir`/build-info. An empty `types: []` is dropped, because
 * per-package configs opt their `@types` back in and the union stands for all of them. Consequences:
 * a package whose own tsconfig differs materially (DOM libs, JSX settings, `paths`) is checked under
 * the base options — references still resolve through imports, but a value whose type depends on
 * the missing lib can degrade to an error type. `.mjs`/`.js` are included with `checkJs` off, so a
 * reference through an untyped (`any`) value is invisible there (the spike measured 25 % of `.mjs`
 * declarations as `any`). `.vue` files are NOT in this program: they get their own Vue-aware program
 * (`vueProgram.ts`, the Volar lane), built lazily beside this one when the repo has `.vue` files.
 *
 * Module resolution is the repo's own (`exports` conditions, pnpm symlinks): the host supplies
 * `realpath`, so a workspace package reached through a symlink has one identity in the program, and
 * no `customConditions` are added — a runtime condition (wec.aria's `aria-runtime`) would resolve
 * contracts to stale `dist/` JavaScript.
 *
 * Invalidation: the cache entry carries the repo's latest index run id. When it changes, the root-file
 * list is re-read and every cached snapshot is re-stamped by mtime, so the LanguageService re-parses
 * only the files that changed — not the whole program.
 */

import fs from "node:fs";
import path from "node:path";

import ts from "typescript";

import type { AnswerBudget } from "./caps.js";
import { detectRepoVueVersion, loadVolar, planVueProgram, versionMismatch, VueProgram } from "./vueProgram.js";

export const MAX_CACHED_HOSTS = 2;

/** TS/JS extensions that go into the union program. `.vue` goes into the Vue program instead. */
export const PROGRAM_EXTENSIONS = [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"] as const;

/** Directories never in the program — build output, dependencies, deliberately non-compiling fixtures. */
export const EXCLUDED_DIRS = new Set(["node_modules", "dist", "dist-runtime", "violations", ".git", "coverage"]);

const BUILD_CONFIG_FILE = /(?:^|\/)(?:vite|vitest)\.config\.[cm]?[jt]s$/;

/** True when a repo-relative (forward-slash) path belongs in the program. */
export function isProgramFile(relativePath: string): boolean {
  const p = relativePath.replace(/\\/g, "/");
  if (p.endsWith(".d.ts") && p.includes("node_modules/")) return false;
  if (!PROGRAM_EXTENSIONS.some((ext) => p.endsWith(ext))) return false;
  if (BUILD_CONFIG_FILE.test(p)) return false;
  return !p.split("/").some((segment) => EXCLUDED_DIRS.has(segment));
}

/**
 * Root files from disk — for callers with no index (the live check script, tests). The server itself
 * uses the indexed file list ({@link RepoProgramInput.relativeFiles}).
 */
export function collectProgramFilesFromDisk(repoPath: string, extensions: readonly string[] = PROGRAM_EXTENSIONS): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walk(path.join(dir, entry.name), childRel);
      } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
        if (extensions !== PROGRAM_EXTENSIONS || isProgramFile(childRel)) out.push(childRel);
      }
    }
  };
  walk(repoPath, "");
  return out.sort();
}

/** The repo's base tsconfig, by the fixed order documented above; null = TypeScript defaults. */
export function findBaseTsconfig(repoPath: string): string | null {
  for (const name of ["tsconfig.base.json", "tsconfig.json", "jsconfig.json"]) {
    const candidate = path.join(repoPath, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveCompilerOptions(repoPath: string): { options: ts.CompilerOptions; tsconfig: string | null; diagnostics: string[] } {
  const tsconfig = findBaseTsconfig(repoPath);
  let options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true };
  const diagnostics: string[] = [];
  if (tsconfig) {
    const read = ts.readConfigFile(tsconfig, (f) => ts.sys.readFile(f));
    if (read.error) {
      diagnostics.push(ts.flattenDiagnosticMessageText(read.error.messageText, " "));
    } else {
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(tsconfig), undefined, tsconfig);
      options = parsed.options;
      // "No inputs found" is expected for a base config that lists no files; anything else is reported.
      for (const d of parsed.errors) if (d.code !== 18003) diagnostics.push(ts.flattenDiagnosticMessageText(d.messageText, " "));
    }
  }
  const merged: ts.CompilerOptions = { ...options, allowJs: true, checkJs: false, noEmit: true, composite: false, declaration: false, declarationMap: false, incremental: false, skipLibCheck: true };
  delete merged.rootDir;
  delete merged.outDir;
  delete merged.tsBuildInfoFile;
  delete merged.configFilePath;
  delete merged.emitDeclarationOnly;
  if (Array.isArray(merged.types) && merged.types.length === 0) delete merged.types;
  return { options: merged, tsconfig, diagnostics };
}

type Snapshot = { mtimeMs: number; version: number; snapshot: ts.IScriptSnapshot | undefined };

/**
 * The repo's Vue lane. `fallback` keeps every `.vue` mentioning the name a named gap, with `reason`:
 * the plugin could not load, or the repo's Vue language-core major differs from ours.
 */
export type VueLane =
  | { state: "none" }
  | { state: "fallback"; reason: string; vueFiles: string[]; repoVersion: { version: string; source: string } | null }
  | { state: "ready"; program: VueProgram; vueFiles: string[]; ourVersion: string; repoVersion: { version: string; source: string } | null };

export type RepoProgramInput = {
  repoId: string;
  repoPath: string;
  /** Changes when the repo is re-indexed; a change re-reads the root files and re-stamps snapshots. */
  runKey: string;
  /** Repo-relative paths of the indexed files; filtered with {@link isProgramFile}. */
  relativeFiles: readonly string[];
};

/** A warm LanguageService for one repo. */
export class RepoLanguageService {
  readonly ls: ts.LanguageService;
  readonly options: ts.CompilerOptions;
  readonly tsconfig: string | null;
  readonly configDiagnostics: string[];
  runKey: string;
  rootFiles: string[];
  /** Wall-clock of the call that built the program (null until built). */
  coldMs: number | null = null;
  private projectVersion = 1;
  private readonly snapshots = new Map<string, Snapshot>();
  private budget: AnswerBudget | null = null;
  private vueState: { runKey: string; lane: VueLane } | null = null;

  constructor(readonly repoId: string, readonly repoPath: string, runKey: string, relativeFiles: readonly string[]) {
    this.runKey = runKey;
    this.rootFiles = toAbsolute(repoPath, relativeFiles);
    const resolved = resolveCompilerOptions(repoPath);
    this.options = resolved.options;
    this.tsconfig = resolved.tsconfig;
    this.configDiagnostics = resolved.diagnostics;
    this.ls = ts.createLanguageService(this.createHost(), ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames, repoPath));
  }

  get isBuilt(): boolean {
    return this.coldMs !== null;
  }

  /** Re-read the root files and re-stamp changed snapshots; the LS re-parses only those. */
  refresh(runKey: string, relativeFiles: readonly string[]): void {
    this.runKey = runKey;
    this.rootFiles = toAbsolute(this.repoPath, relativeFiles);
    for (const [file, snap] of this.snapshots) {
      const mtimeMs = statMtime(file);
      if (mtimeMs !== snap.mtimeMs) this.snapshots.delete(file);
    }
    this.projectVersion++;
  }

  /**
   * The Vue lane for the current run, planned on first use after a (re)index: `.vue` files from disk,
   * the version gate, and the Vue program — refreshed in place when its tsconfig is unchanged.
   */
  vueLane(): VueLane {
    if (this.vueState && this.vueState.runKey === this.runKey) return this.vueState.lane;
    const previous = this.vueState?.lane;
    const vueFiles = collectProgramFilesFromDisk(this.repoPath, [".vue"]);
    let lane: VueLane;
    if (vueFiles.length === 0) {
      lane = { state: "none" };
    } else {
      const loaded = loadVolar();
      const plan = planVueProgram(this.repoPath, vueFiles, this.tsconfig);
      const repoVersion = detectRepoVueVersion(this.repoPath, plan.configDirs);
      const mismatch = "api" in loaded ? versionMismatch(loaded.api.version, repoVersion?.version ?? null) : null;
      if ("error" in loaded) lane = { state: "fallback", reason: loaded.error, vueFiles, repoVersion };
      else if (mismatch) lane = { state: "fallback", reason: mismatch, vueFiles, repoVersion };
      else if (previous?.state === "ready" && previous.program.tsconfig === plan.tsconfig && sameList(previous.program.plan.configDirs, plan.configDirs)) {
        previous.program.refresh(vueFiles, this.rootFiles);
        lane = { ...previous, vueFiles, repoVersion };
      } else {
        const program = new VueProgram(loaded.api, this.repoPath, plan, this.rootFiles, () => this.budget?.token.isCancellationRequested() ?? false);
        if (program.vueTypes) {
          lane = { state: "ready", program, vueFiles, ourVersion: loaded.api.version, repoVersion };
        } else {
          program.dispose();
          const from = path.relative(this.repoPath, plan.tsconfig ? path.dirname(plan.tsconfig) : this.repoPath).replace(/\\/g, "/") || ".";
          lane = { state: "fallback", reason: `the 'vue' package does not resolve from ${from} (dependencies not installed?); template expressions would be untyped`, vueFiles, repoVersion };
        }
      }
    }
    if (previous?.state === "ready" && (lane.state !== "ready" || lane.program !== previous.program)) previous.program.dispose();
    this.vueState = { runKey: this.runKey, lane };
    return lane;
  }

  /** The program, building it when cold. The budget is consulted by the LS between files. */
  program(budget: AnswerBudget): ts.Program {
    this.budget = budget;
    const started = performance.now();
    const wasBuilt = this.isBuilt;
    const program = this.ls.getProgram();
    if (!program) throw new Error("TypeScript LanguageService returned no program");
    if (!wasBuilt) this.coldMs = Math.round(performance.now() - started);
    budget.check("program build");
    return program;
  }

  withBudget<T>(budget: AnswerBudget, fn: () => T): T {
    this.budget = budget;
    try {
      return fn();
    } finally {
      this.budget = null;
    }
  }

  dispose(): void {
    this.ls.dispose();
    this.snapshots.clear();
    if (this.vueState?.lane.state === "ready") this.vueState.lane.program.dispose();
    this.vueState = null;
  }

  private readSnapshot(fileName: string): Snapshot {
    const cached = this.snapshots.get(fileName);
    if (cached) return cached;
    const text = ts.sys.readFile(fileName);
    const snap: Snapshot = { mtimeMs: statMtime(fileName), version: this.projectVersion, snapshot: text === undefined ? undefined : ts.ScriptSnapshot.fromString(text) };
    this.snapshots.set(fileName, snap);
    return snap;
  }

  private createHost(): ts.LanguageServiceHost {
    const cwd = this.repoPath;
    const options = this.options;
    const moduleCache = ts.createModuleResolutionCache(cwd, (x) => (ts.sys.useCaseSensitiveFileNames ? x : x.toLowerCase()), options);
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => options,
      getProjectVersion: () => String(this.projectVersion),
      getScriptFileNames: () => this.rootFiles,
      getScriptVersion: (f) => String(this.readSnapshot(f).version),
      getScriptSnapshot: (f) => this.readSnapshot(f).snapshot,
      getCurrentDirectory: () => cwd,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: (f) => ts.sys.fileExists(f),
      readFile: (f, enc) => ts.sys.readFile(f, enc),
      readDirectory: (p, ext, exc, inc, depth) => ts.sys.readDirectory(p, ext, exc, inc, depth),
      directoryExists: (d) => ts.sys.directoryExists(d),
      getDirectories: (d) => ts.sys.getDirectories(d),
      // pnpm: a workspace package is a symlink; realpath gives the contract file one identity.
      realpath: (p) => (ts.sys.realpath ? ts.sys.realpath(p) : p),
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      getCancellationToken: () => ({ isCancellationRequested: () => this.budget?.token.isCancellationRequested() ?? false }),
      getScriptKind: (f) => scriptKindOf(f)
    };
    // One resolution cache for the whole program; pnpm `exports` lookups dominate a cold build.
    host.resolveModuleNameLiterals = (literals, containingFile, redirected, opts, containingSourceFile) =>
      literals.map((lit) =>
        ts.resolveModuleName(lit.text, containingFile, opts, host as ts.ModuleResolutionHost, moduleCache, redirected, ts.getModeForUsageLocation(containingSourceFile, lit, opts))
      );
    return host;
  }
}

function scriptKindOf(f: string): ts.ScriptKind {
  if (/\.[mc]?js$/.test(f)) return ts.ScriptKind.JS;
  if (f.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (f.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (f.endsWith(".json")) return ts.ScriptKind.JSON;
  return ts.ScriptKind.TS;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function statMtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

function toAbsolute(repoPath: string, relativeFiles: readonly string[]): string[] {
  const root = repoPath.replace(/\\/g, "/").replace(/\/$/, "");
  return relativeFiles.filter(isProgramFile).map((rel) => `${root}/${rel.replace(/\\/g, "/")}`);
}

/**
 * The repo root as the file system spells it. Files the program reaches through module resolution
 * come back realpath'd, so a root given in another spelling — a Windows 8.3 short name such as
 * `C:\Users\RUNNER~1` on a CI runner, or a symlinked checkout — would put one file under two
 * names and every repo-relative path outside the root.
 */
function canonicalRepoPath(repoPath: string): string {
  try {
    return fs.realpathSync.native(repoPath);
  } catch {
    return repoPath;
  }
}

// ── LRU cache ────────────────────────────────────────────────────────────────

const cache = new Map<string, RepoLanguageService>();

/**
 * The warm LanguageService for a repo, created on first use. A changed `runKey` refreshes it in place;
 * a third repo evicts the least recently used one (its program is disposed).
 */
export function getRepoLanguageService(input: RepoProgramInput): RepoLanguageService {
  const repoPath = canonicalRepoPath(input.repoPath);
  const existing = cache.get(input.repoId);
  if (existing && existing.repoPath === repoPath) {
    cache.delete(input.repoId);
    cache.set(input.repoId, existing);
    if (existing.runKey !== input.runKey) existing.refresh(input.runKey, input.relativeFiles);
    return existing;
  }
  if (existing) dropRepoLanguageService(input.repoId);
  const created = new RepoLanguageService(input.repoId, repoPath, input.runKey, input.relativeFiles);
  cache.set(input.repoId, created);
  while (cache.size > MAX_CACHED_HOSTS) {
    const oldest = cache.keys().next().value as string;
    dropRepoLanguageService(oldest);
  }
  return created;
}

export function dropRepoLanguageService(repoId: string): void {
  const entry = cache.get(repoId);
  if (!entry) return;
  cache.delete(repoId);
  entry.dispose();
}

/** Test seam: the repos currently holding a warm host, least recently used first. */
export function cachedRepoIds(): string[] {
  return [...cache.keys()];
}
