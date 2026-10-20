/**
 * R3 exact for `.vue` — a second, Vue-aware TypeScript program per repo, built through Volar.
 *
 * Blueprint: the R3 spike's `web` host (2026-10-20, wec.aria: 175 `.vue` + console/portal `.ts`,
 * 933 program files, 6.5 s cold, ~430 MB on top of the TS program). `.vue` files are put in the
 * program through `@vue/language-core`'s language plugin: Volar generates a virtual TypeScript file
 * per SFC (script AND template expressions), the LanguageService answers on that virtual code, and
 * each hit is mapped back to the real `.vue` offset with Volar's source maps.
 *
 * **Why a second program and not the union program.** A Vue package is compiled under different
 * options: the vue-tsc reading of its tsconfig (`createParsedCommandLine`: `vueCompilerOptions`),
 * DOM libs, `module: preserve`, `moduleResolution: bundler`, `types: ["vite/client"]`. Under the
 * union program's base options (`nodenext`) a `.vue` import does not even resolve. So one Vue
 * program per repo, with:
 * - **options** from the tsconfig that owns the most `.vue` files (the nearest `tsconfig.json`
 *   above each `.vue`; the repo's base tsconfig when none is nearer), parsed the vue-tsc way, plus
 *   `allowNonTsExtensions` (tsserver sets it for plugin projects; without it every `.vue` root is
 *   dropped), `allowJs`, `checkJs: false`, `noEmit`. Other Vue-owning configs are assumed
 *   compatible — wec.aria's console and portal are identical — and are named in the meta;
 * - **root files**: every `.vue` file plus the TS/JS root files under the directories of those
 *   owning tsconfigs (the Vue packages' own `.ts`). Files outside them — contracts — come in
 *   through imports, as in vue-tsc.
 *
 * The union program still answers every TS/JS file; this program contributes `.vue` sites, `.vue`
 * declarations, and TS sites the union program missed (deduplicated by position).
 *
 * **Version gate.** Volar's code generation and mapping change across majors. The target repo's
 * `@vue/language-core` / `vue-tsc` version is read (its `node_modules`, then its lockfile; read
 * only); on a MAJOR mismatch with our pin the lane is not built and every `.vue` mentioning the
 * name stays a named gap. An unreadable version is not a mismatch.
 *
 * **Gap detection.** The UNPROXIED LanguageService is queried and each hit mapped with
 * `toSourceRanges(…, isReferencesEnabled)` — Volar's proxy would silently drop an unmapped hit. An
 * unmapped hit is usually a code-generation duplicate (a `v-if` condition repeated inside an event
 * handler); it becomes a named gap only when its file has a mention of the name that no mapped site
 * accounts for. Volar's `getServiceScript` / `toSourceRanges` live under `lib/node/` and are not in
 * the package's public index: that is why both packages are pinned exactly.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import ts from "typescript";

import type { AnswerBudget } from "./caps.js";

type VueLanguageCore = typeof import("@vue/language-core");
type VolarTypescript = typeof import("@volar/typescript");
type VolarUtils = typeof import("@volar/typescript/lib/node/utils.js");
type VolarTransform = typeof import("@volar/typescript/lib/node/transform.js");
type VueLanguage = import("@vue/language-core").Language<string>;

export type VolarApi = {
  vue: VueLanguageCore;
  volar: VolarTypescript;
  getServiceScript: VolarUtils["getServiceScript"];
  toSourceRanges: VolarTransform["toSourceRanges"];
  /** Our pinned `@vue/language-core` version. */
  version: string;
};

let volarCache: { api: VolarApi } | { error: string } | null = null;

/** Volar, loaded on first use (pure JS; only repos with `.vue` files pay for it). */
export function loadVolar(): { api: VolarApi } | { error: string } {
  if (volarCache) return volarCache;
  try {
    const require = createRequire(import.meta.url);
    const vue = require("@vue/language-core") as VueLanguageCore;
    const volar = require("@volar/typescript") as VolarTypescript;
    const utils = require("@volar/typescript/lib/node/utils") as VolarUtils;
    const transform = require("@volar/typescript/lib/node/transform") as VolarTransform;
    const version = (require("@vue/language-core/package.json") as { version: string }).version;
    if (typeof utils.getServiceScript !== "function" || typeof transform.toSourceRanges !== "function") {
      volarCache = { error: "Volar internals getServiceScript/toSourceRanges not found" };
    } else {
      volarCache = { api: { vue, volar, getServiceScript: utils.getServiceScript, toSourceRanges: transform.toSourceRanges, version } };
    }
  } catch (error) {
    volarCache = { error: `Vue language plugin unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  return volarCache;
}

const major = (v: string): number | null => {
  const m = /^\D*(\d+)\./.exec(v);
  return m ? Number(m[1]) : null;
};

/**
 * The target repo's Vue language-core version: `@vue/language-core`, else `vue-tsc` (released in
 * lockstep), from `node_modules` under the given directories, then the repo's lockfile. Read only.
 */
export function detectRepoVueVersion(repoPath: string, dirs: readonly string[] = []): { version: string; source: string } | null {
  const readVersion = (file: string): string | null => {
    try {
      const v = (JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown }).version;
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  };
  for (const dir of [...dirs, repoPath]) {
    for (const pkg of ["@vue/language-core", "vue-tsc"]) {
      const file = path.join(dir, "node_modules", pkg, "package.json");
      const v = readVersion(file);
      if (v) return { version: v, source: path.relative(repoPath, file).replace(/\\/g, "/") };
    }
  }
  const lock = (name: string): string | null => {
    try {
      return fs.readFileSync(path.join(repoPath, name), "utf8");
    } catch {
      return null;
    }
  };
  const pnpm = lock("pnpm-lock.yaml");
  if (pnpm) {
    const m = /(?:^|[\s/'"])(?:@vue\/language-core|vue-tsc)@(\d+\.\d+\.\d+[\w.-]*)/m.exec(pnpm);
    if (m) return { version: m[1]!, source: "pnpm-lock.yaml" };
  }
  const npmLock = lock("package-lock.json");
  if (npmLock) {
    try {
      const packages = (JSON.parse(npmLock) as { packages?: Record<string, { version?: string }> }).packages ?? {};
      for (const key of ["node_modules/@vue/language-core", "node_modules/vue-tsc"]) {
        const v = packages[key]?.version;
        if (v) return { version: v, source: "package-lock.json" };
      }
    } catch {
      // unreadable lockfile: no version
    }
  }
  const yarn = lock("yarn.lock");
  if (yarn) {
    const m = /^"?(?:@vue\/language-core|vue-tsc)@[^\n]*\n\s+version:?\s+"?(\d+\.\d+\.\d+[\w.-]*)/m.exec(yarn);
    if (m) return { version: m[1]!, source: "yarn.lock" };
  }
  return null;
}

/** Reason the lane cannot run for this repo version, or null. */
export function versionMismatch(ours: string, repo: string | null): string | null {
  if (!repo) return null;
  const a = major(ours);
  const b = major(repo);
  return a !== null && b !== null && a !== b ? `vue language-core major mismatch (ours ${ours}, repo ${repo})` : null;
}

/** The nearest `tsconfig.json` above a repo-relative file, inside the repo; null when none. */
function nearestTsconfig(repoPath: string, rel: string): string | null {
  let dir = path.dirname(path.join(repoPath, rel));
  const root = path.resolve(repoPath);
  for (;;) {
    const candidate = path.join(dir, "tsconfig.json");
    if (fs.existsSync(candidate)) return candidate;
    if (path.resolve(dir) === root) return null;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export type VuePlan = {
  vueFiles: string[];
  /** The tsconfig whose options the program uses (absolute), or null for defaults. */
  tsconfig: string | null;
  /** Every tsconfig owning at least one `.vue` file (absolute). */
  ownerConfigs: string[];
  /** Directories of the owning configs — TS/JS roots under them join the program. */
  configDirs: string[];
};

/** Which tsconfig the Vue program follows, and which directories its TS roots come from. */
export function planVueProgram(repoPath: string, vueRelFiles: readonly string[], baseTsconfig: string | null): VuePlan {
  const owners = new Map<string, number>();
  for (const rel of vueRelFiles) {
    const owner = nearestTsconfig(repoPath, rel) ?? baseTsconfig ?? "";
    owners.set(owner, (owners.get(owner) ?? 0) + 1);
  }
  const ranked = [...owners.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const ownerConfigs = ranked.map(([c]) => c).filter((c) => c !== "");
  const configDirs = owners.has("") ? [path.resolve(repoPath)] : ownerConfigs.map((c) => path.dirname(c));
  return { vueFiles: [...vueRelFiles], tsconfig: ownerConfigs[0] ?? null, ownerConfigs, configDirs };
}

type Snapshot = { mtimeMs: number; version: number; snapshot: ts.IScriptSnapshot | undefined };

export type VueSourceSite = { fileName: string; offset: number; length: number; block: "template" | "script" };

/** The Vue program: a LanguageService whose `.vue` roots are Volar virtual code. */
export class VueProgram {
  readonly ls: ts.LanguageService;
  readonly options: ts.CompilerOptions;
  readonly tsconfig: string | null;
  readonly configDiagnostics: string[] = [];
  readonly language: VueLanguage;
  rootFiles: string[];
  vueRootCount: number;
  coldMs: number | null = null;
  /**
   * Where `vue` resolves from the options' directory, or null. Without Vue's own types every
   * template expression is typed through `any` and its references vanish silently — so the lane
   * refuses to run rather than report an empty `.vue` list as exact.
   */
  readonly vueTypes: string | null;
  private projectVersion = 1;
  private readonly snapshots = new Map<string, Snapshot>();

  constructor(
    private readonly api: VolarApi,
    readonly repoPath: string,
    readonly plan: VuePlan,
    tsRootFiles: readonly string[],
    private readonly cancelled: () => boolean
  ) {
    const { vue } = api;
    this.tsconfig = plan.tsconfig;
    let parsedOptions: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, jsx: ts.JsxEmit.Preserve, lib: ["lib.es2023.d.ts", "lib.dom.d.ts"] };
    let vueOptions = vue.getDefaultCompilerOptions();
    if (plan.tsconfig) {
      const parsed = vue.createParsedCommandLine(ts, ts.sys, plan.tsconfig.replace(/\\/g, "/"));
      parsedOptions = parsed.options;
      vueOptions = parsed.vueOptions;
    }
    const merged: ts.CompilerOptions = { ...parsedOptions, allowNonTsExtensions: true, allowJs: true, checkJs: false, noEmit: true, composite: false, declaration: false, declarationMap: false, incremental: false, skipLibCheck: true };
    delete merged.rootDir;
    delete merged.outDir;
    delete merged.tsBuildInfoFile;
    delete merged.emitDeclarationOnly;
    this.options = merged;
    this.rootFiles = [];
    this.vueRootCount = 0;
    this.setRoots(plan.vueFiles, tsRootFiles);

    const cwd = plan.tsconfig ? path.dirname(plan.tsconfig).replace(/\\/g, "/") : repoPath.replace(/\\/g, "/");
    this.vueTypes = ts.resolveModuleName("vue", `${cwd}/__vue_probe__.ts`, merged, ts.sys).resolvedModule?.resolvedFileName ?? null;
    const host = this.createHost(cwd);
    const rawSnapshot = (f: string): ts.IScriptSnapshot | undefined => this.readSnapshot(f).snapshot;
    const plugin = vue.createVueLanguagePlugin<string>(ts, merged, vueOptions, (id) => id);
    const language: VueLanguage = vue.createLanguage<string>(
      [plugin, { getLanguageId: (f: string) => api.volar.resolveFileLanguageId(f) }],
      new vue.FileMap(ts.sys.useCaseSensitiveFileNames),
      (fileName) => {
        const snap = rawSnapshot(fileName);
        if (snap) language.scripts.set(fileName, snap);
        else language.scripts.delete(fileName);
      }
    );
    this.language = language;
    api.volar.decorateLanguageServiceHost(ts, language, host);
    this.ls = ts.createLanguageService(host, ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames, cwd));
  }

  get isBuilt(): boolean {
    return this.coldMs !== null;
  }

  private setRoots(vueRel: readonly string[], tsRootFiles: readonly string[]): void {
    const root = this.repoPath.replace(/\\/g, "/").replace(/\/$/, "");
    const dirs = this.plan.configDirs.map((d) => `${d.replace(/\\/g, "/").replace(/\/$/, "")}/`.toLowerCase());
    const vueAbs = vueRel.map((r) => `${root}/${r.replace(/\\/g, "/")}`);
    const tsUnder = tsRootFiles.filter((f) => dirs.some((d) => f.toLowerCase().startsWith(d)));
    this.rootFiles = [...vueAbs, ...tsUnder];
    this.vueRootCount = vueAbs.length;
  }

  /** New run: new roots, changed snapshots re-read (Volar regenerates only those SFCs). */
  refresh(vueRel: readonly string[], tsRootFiles: readonly string[]): void {
    this.setRoots(vueRel, tsRootFiles);
    for (const [file, snap] of this.snapshots) {
      if (statMtime(file) !== snap.mtimeMs) this.snapshots.delete(file);
    }
    this.projectVersion++;
  }

  program(budget: AnswerBudget): ts.Program {
    const started = performance.now();
    const wasBuilt = this.isBuilt;
    const program = this.ls.getProgram();
    if (!program) throw new Error("Vue LanguageService returned no program");
    if (!wasBuilt) this.coldMs = Math.round(performance.now() - started);
    budget.check("vue program build");
    return program;
  }

  /**
   * A reference in a `.vue` file's virtual code, mapped to the real `.vue` offset(s). Empty when the
   * generated position has no reference-enabled mapping.
   */
  toSource(fileName: string, start: number, length: number): VueSourceSite[] {
    const [serviceScript, , sourceScript] = this.api.getServiceScript(this.language, fileName);
    if (!serviceScript || !sourceScript) return [];
    const out: VueSourceSite[] = [];
    const tpl = templateRange(sourceScript.generated?.root);
    for (const [file, s, e] of this.api.toSourceRanges(sourceScript, this.language, serviceScript, start, start + length, true, this.api.vue.isReferencesEnabled)) {
      out.push({ fileName: file, offset: s, length: e - s, block: tpl && s >= tpl.start && s < tpl.end ? "template" : "script" });
    }
    return out;
  }

  /** The real text of a `.vue` file, as the program saw it. */
  sourceText(fileName: string): string | undefined {
    const snap = this.readSnapshot(fileName).snapshot;
    return snap ? snap.getText(0, snap.getLength()) : undefined;
  }

  dispose(): void {
    this.ls.dispose();
    this.snapshots.clear();
  }

  private readSnapshot(fileName: string): Snapshot {
    const cached = this.snapshots.get(fileName);
    if (cached) return cached;
    const text = ts.sys.readFile(fileName);
    const snap: Snapshot = { mtimeMs: statMtime(fileName), version: this.projectVersion, snapshot: text === undefined ? undefined : ts.ScriptSnapshot.fromString(text) };
    this.snapshots.set(fileName, snap);
    return snap;
  }

  private createHost(cwd: string): ts.LanguageServiceHost {
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
      realpath: (p) => (ts.sys.realpath ? ts.sys.realpath(p) : p),
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      getCancellationToken: () => ({ isCancellationRequested: () => this.cancelled() }),
      // Volar swaps in the virtual code only for a Deferred script kind.
      getScriptKind: (f) => (f.endsWith(".vue") ? ts.ScriptKind.Deferred : /\.[mc]?js$/.test(f) ? ts.ScriptKind.JS : f.endsWith(".jsx") ? ts.ScriptKind.JSX : f.endsWith(".tsx") ? ts.ScriptKind.TSX : f.endsWith(".json") ? ts.ScriptKind.JSON : ts.ScriptKind.TS)
    };
    host.getModuleResolutionCache = () => moduleCache;
    // Present so Volar can wrap it and resolve `./X.vue` imports.
    host.resolveModuleNameLiterals = (literals, containingFile, redirected, opts, containingSourceFile) =>
      literals.map((lit) =>
        ts.resolveModuleName(lit.text, containingFile, opts, host as ts.ModuleResolutionHost, moduleCache, redirected, ts.getModeForUsageLocation(containingSourceFile, lit, opts))
      );
    return host;
  }
}

function templateRange(root: unknown): { start: number; end: number } | null {
  const ir = (root as { ir?: { template?: { startTagEnd?: number; endTagStart?: number } } } | undefined)?.ir;
  const t = ir?.template;
  return t && typeof t.startTagEnd === "number" && typeof t.endTagStart === "number" ? { start: t.startTagEnd, end: t.endTagStart } : null;
}

function statMtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}
