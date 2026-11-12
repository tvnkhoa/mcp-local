/**
 * Resolve a JavaScript/TypeScript module specifier to the repo file it names.
 *
 * One implementation, two consumers: `edgeResolverImports` (turning an `import:<specifier>` token
 * into the target module's symbol) and `edgeResolverCalls` (scoping candidates for `callee:<name>`
 * to the files the calling file actually imports). Keeping them on one resolver is the point —
 * they disagreed before, and the import lane's own copy had a routing bug that this replaces.
 */

import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

/** Forward slashes everywhere, matching the response convention the rest of the server holds to. */
export function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

/** `@/db/pool` → `src/db/pool`, from tsconfig `compilerOptions.paths`. */
export type PathAliases = {
  /** Longest-prefix-first, so `@/components/*` wins over `@/*`. */
  entries: { prefix: string; suffix: string; targets: string[] }[];
  /**
   * Repo-relative baseUrl, or null when the tsconfig declares none.
   *
   * `""` is a real value — it is what `"baseUrl": "."` at the repo root resolves to, and that is the
   * common configuration. Using the empty string to mean "absent" made the baseUrl branch below
   * falsy in exactly the case it was written for.
   */
  baseUrl: string | null;
};

export const EMPTY_ALIASES: PathAliases = { entries: [], baseUrl: null };

/**
 * A specifier is *relative* when it starts with `.`; anything else is either a package or a path
 * alias. The distinction matters because the two are resolved completely differently, and because
 * the import resolver used to route any non-relative specifier containing a dot into its C#
 * namespace branch — which swallowed `@/db/pool.js`, the ordinary ESM-plus-alias form.
 */
export function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith(".");
}

/** True for a specifier that looks like a path (alias or scoped path), not a C# namespace. */
export function looksLikeModulePath(specifier: string): boolean {
  return specifier.includes("/") || specifier.startsWith("@") || specifier.startsWith("~");
}

/**
 * Read `compilerOptions.baseUrl` + `paths` from the repo's tsconfig, following a single `extends`
 * hop. Returns empty aliases for any repo without one, which is the common case and not an error.
 *
 * JSON with comments and trailing commas is normal in a tsconfig, so the text is stripped before
 * parsing rather than handed to `JSON.parse` raw.
 */
export function readTsconfigAliases(repoPath: string): PathAliases {
  const seen = new Set<string>();
  let configPath = path.join(repoPath, "tsconfig.json");
  let compilerOptions: Record<string, unknown> | null = null;
  let configDir = repoPath;

  for (let hop = 0; hop < 2; hop += 1) {
    if (seen.has(configPath) || !fs.existsSync(configPath)) break;
    seen.add(configPath);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stripJsonComments(fs.readFileSync(configPath, "utf8"))) as Record<string, unknown>;
    } catch {
      break;
    }

    const options = parsed.compilerOptions as Record<string, unknown> | undefined;
    if (options && (options.paths ?? options.baseUrl)) {
      compilerOptions = options;
      configDir = path.dirname(configPath);
      break;
    }

    const extendsValue = parsed.extends;
    if (typeof extendsValue !== "string" || !extendsValue.startsWith(".")) break;
    configDir = path.dirname(configPath);
    configPath = path.resolve(configDir, extendsValue.endsWith(".json") ? extendsValue : `${extendsValue}.json`);
  }

  if (!compilerOptions) return EMPTY_ALIASES;

  const hasBaseUrl = typeof compilerOptions.baseUrl === "string";
  const baseUrlRaw = hasBaseUrl ? (compilerOptions.baseUrl as string) : ".";
  // `paths` targets are always resolved against baseUrl (defaulting to the config dir), but the
  // bare-specifier lookup below only applies when baseUrl was actually declared.
  const resolvedBase = toRepoRelative(repoPath, path.resolve(configDir, baseUrlRaw));
  const baseUrl = hasBaseUrl ? resolvedBase : null;

  const pathsValue = compilerOptions.paths;
  const entries: PathAliases["entries"] = [];
  if (pathsValue && typeof pathsValue === "object") {
    for (const [pattern, rawTargets] of Object.entries(pathsValue as Record<string, unknown>)) {
      if (!Array.isArray(rawTargets)) continue;
      const star = pattern.indexOf("*");
      const prefix = star === -1 ? pattern : pattern.slice(0, star);
      const suffix = star === -1 ? "" : pattern.slice(star + 1);
      const targets = rawTargets
        .filter((t): t is string => typeof t === "string")
        .map((t) => joinRepoPath(resolvedBase, t));
      if (targets.length > 0) entries.push({ prefix, suffix, targets });
    }
  }

  // Longest prefix first so a specific alias is never shadowed by a catch-all `@/*`.
  entries.sort((a, b) => b.prefix.length - a.prefix.length);
  return { entries, baseUrl };
}

/**
 * Strip comments and trailing commas from a tsconfig, scanning rather than pattern-matching.
 *
 * A regex cannot do this, and the failure is silent and total. `"@/*": ["src/*"]` contains `/*`, and
 * `"include": ["src/**\/*.ts"]` contains `*\/`, so a `\/\*[\s\S]*?\*\/` pass treats everything
 * between them as one block comment and deletes it — leaving JSON that will not parse, so
 * `readTsconfigAliases` returns no aliases at all. A tsconfig with both `paths` and a `**` glob is
 * the ordinary case, which means the alias support would have been dead in almost every real repo
 * while appearing to work in a test that omitted `include`.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let index = 0;

  while (index < text.length) {
    const ch = text[index];

    if (inString) {
      out += ch;
      if (ch === "\\") {
        // Copy the escaped character whole so an escaped quote cannot end the string.
        out += text[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (ch === '"') inString = false;
      index += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      index += 1;
      continue;
    }

    if (ch === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }

    if (ch === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }

    out += ch;
    index += 1;
  }

  // Trailing commas are legal in a tsconfig and illegal in JSON. Safe as a regex now that every
  // string literal has been copied through verbatim above.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function toRepoRelative(repoPath: string, absolute: string): string {
  return path.relative(repoPath, absolute).split(path.sep).join("/");
}

function joinRepoPath(base: string, rest: string): string {
  const combined = base ? `${base}/${rest}` : rest;
  return normalizeSegments(combined);
}

function normalizeSegments(input: string): string {
  const out: string[] = [];
  for (const part of input.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/**
 * Every file path a specifier could mean, in preference order.
 *
 * ESM under `"type": "module"` requires the `.js` extension on a relative import even when the
 * source is `.ts`, so the `.js → .ts` rewrite is the normal case here, not a fallback.
 */
function candidatePaths(base: string): string[] {
  const withoutJsExt = base.replace(/\.(js|mjs|cjs)$/, "");
  const bases = withoutJsExt === base ? [base] : [withoutJsExt, base];
  const out: string[] = [];
  for (const candidate of bases) {
    out.push(
      candidate,
      `${candidate}.ts`,
      `${candidate}.tsx`,
      `${candidate}.mts`,
      `${candidate}.cts`,
      `${candidate}.js`,
      `${candidate}.jsx`,
      `${candidate}.mjs`,
      `${candidate}.cjs`,
      `${candidate}/index.ts`,
      `${candidate}/index.tsx`,
      `${candidate}/index.mts`,
      `${candidate}/index.js`,
      `${candidate}/index.mjs`
    );
  }
  return out;
}

/**
 * The repo file a specifier names, or null when it names something outside the repo (a package, a
 * builtin) or nothing that was indexed.
 */
export function resolveModuleSpecifier(
  fromFile: string,
  specifier: string,
  knownFiles: ReadonlySet<string>,
  aliases: PathAliases = EMPTY_ALIASES
): string | null {
  // PY-2: a Python file's tokens are dotted module paths with the relative level as leading dots, not
  // file paths — `.models` is a sibling module, not a dot-file.
  if (isPythonFile(fromFile)) return resolvePythonModuleSpecifier(fromFile, specifier, knownFiles);
  const bases: string[] = [];
  // A bundler query or fragment is not part of the file name: `./icon.svg?raw`, `./sprite.svg#home`
  // (MCP-ISSUE-077 — the svg asset nodes are what these reach).
  specifier = specifier.replace(/[?#].*$/, "");
  if (!specifier) return null;

  if (isRelativeSpecifier(specifier)) {
    const fromDir = fromFile.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
    bases.push(normalizeSegments(`${fromDir}/${specifier}`));
  } else {
    for (const entry of aliases.entries) {
      if (!specifier.startsWith(entry.prefix)) continue;
      const rest = specifier.slice(entry.prefix.length);
      if (entry.suffix && !rest.endsWith(entry.suffix)) continue;
      const stem = entry.suffix ? rest.slice(0, rest.length - entry.suffix.length) : rest;
      for (const target of entry.targets) {
        bases.push(normalizeSegments(target.includes("*") ? target.replace("*", stem) : `${target}/${stem}`));
      }
    }
    // `baseUrl`-relative imports without an alias (`import x from "db/pool.js"`).
    if (aliases.baseUrl !== null && looksLikeModulePath(specifier)) {
      bases.push(joinRepoPath(aliases.baseUrl, specifier));
    }
  }

  for (const base of bases) {
    for (const candidate of candidatePaths(base)) {
      if (knownFiles.has(candidate)) return candidate;
    }
  }
  return null;
}

// ── Python (PY-2) ───────────────────────────────────────────────────────────────────────────

/** `.py` / `.pyi` — the files whose import tokens are Python module specs. */
export function isPythonFile(filePath: string): boolean {
  return /\.pyi?$/i.test(filePath);
}

const pythonRootsCache = new WeakMap<ReadonlySet<string>, string[]>();

/**
 * The directories an absolute Python import is resolved against, most specific first.
 *
 * A package is a directory holding `__init__.py`; the parent of a TOP-level package (one whose own
 * parent is not a package) is a root — that is what puts `src/` on the path in a src layout without
 * reading pyproject.toml. `src` and the repo root are always roots, for namespace packages (no
 * `__init__.py`) and plain scripts. Cached per known-file set: one resolver pass asks thousands of times.
 */
export function pythonPackageRoots(knownFiles: ReadonlySet<string>): string[] {
  const cached = pythonRootsCache.get(knownFiles);
  if (cached) return cached;
  const packageDirs = new Set<string>();
  for (const file of knownFiles) {
    const match = /^(?:(.*)\/)?__init__\.pyi?$/.exec(file);
    if (match) packageDirs.add(match[1] ?? "");
  }
  const roots = new Set<string>();
  for (const dir of packageDirs) {
    if (dir === "") continue;
    let top = dir;
    for (;;) {
      const slash = top.lastIndexOf("/");
      const parent = slash === -1 ? "" : top.slice(0, slash);
      if (parent === "" || !packageDirs.has(parent)) break;
      top = parent;
    }
    const slash = top.lastIndexOf("/");
    roots.add(slash === -1 ? "" : top.slice(0, slash));
  }
  const ordered = [...roots].filter((r) => r !== "" && r !== "src").sort();
  ordered.push("src", "");
  pythonRootsCache.set(knownFiles, ordered);
  return ordered;
}

function pythonModuleFile(dir: string, parts: readonly string[], knownFiles: ReadonlySet<string>): string | null {
  const stem = [dir, ...parts].filter((p) => p.length > 0).join("/");
  const candidates = stem
    // A package directory shadows a same-named module file on import, as in CPython's finder.
    ? [`${stem}/__init__.py`, `${stem}.py`, `${stem}/__init__.pyi`, `${stem}.pyi`]
    : ["__init__.py", "__init__.pyi"];
  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) return candidate;
  }
  return null;
}

/**
 * The repo file a Python import token names, or null for the standard library, a third-party
 * package, or anything not indexed.
 *
 * Tokens come from `pythonExtractor`: `a.b` (absolute), `..c.r` (relative — one dot is the importing
 * file's own package). A `from m import n` token is `m.n`: `n` may be a submodule (`from pkg import
 * mod`) or a name defined in `m`, so the full path is tried first and the module without its last
 * part second. Only one part is ever dropped — dropping more would bind `import a.missing.x` to `a`.
 */
export function resolvePythonModuleSpecifier(
  fromFile: string,
  specifier: string,
  knownFiles: ReadonlySet<string>
): string | null {
  const spec = specifier.trim();
  if (!spec) return null;
  const level = /^\.*/.exec(spec)?.[0].length ?? 0;
  const parts = spec.slice(level).split(".").filter((p) => p.length > 0);
  const variants = parts.length > 0 ? [parts, parts.slice(0, -1)] : [parts];

  if (level > 0) {
    const dirParts = normalizeFilePath(fromFile).split("/").slice(0, -1);
    if (level - 1 > dirParts.length) return null;
    const base = dirParts.slice(0, dirParts.length - (level - 1)).join("/");
    for (const variant of variants) {
      // `from . import x` falling back to `.` is the package's own `__init__`.
      const hit = pythonModuleFile(base, variant, knownFiles);
      if (hit) return hit;
    }
    return null;
  }

  for (const variant of variants) {
    if (variant.length === 0) continue;
    for (const root of pythonPackageRoots(knownFiles)) {
      const hit = pythonModuleFile(root, variant, knownFiles);
      if (hit) return hit;
    }
  }
  return null;
}

/** Repo-relative paths of every indexed file, normalized to forward slashes. */
export function loadIndexedFilePaths(db: Database.Database, repoId: string): Set<string> {
  const rows = db
    .prepare(`select path from files where repo_id = ?`)
    .all(repoId) as { path: string }[];
  return new Set(rows.map((row) => row.path.replace(/\\/g, "/")));
}

export function loadRepoPath(db: Database.Database, repoId: string): string | null {
  const row = db
    .prepare(`select repo_path as repoPath from repositories where repo_id = ?`)
    .get(repoId) as { repoPath: string } | undefined;
  return row?.repoPath ?? null;
}

/**
 * For each file, the set of repo files it imports.
 *
 * Built from the raw `import:<specifier>` tokens rather than from resolved IMPORTS edges, because
 * call resolution runs *before* import resolution in the post-index phase — reading resolved edges
 * here would silently see an empty map on a full index.
 */
export function buildImportedFilesByFile(
  db: Database.Database,
  repoId: string
): Map<string, Set<string>> {
  const knownFiles = loadIndexedFilePaths(db, repoId);
  const repoPath = loadRepoPath(db, repoId);
  const aliases = repoPath ? readTsconfigAliases(repoPath) : EMPTY_ALIASES;

  const rows = db
    .prepare(
      `select sf.file_path as fromFile, e.to_id as toId
       from edges e
       join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
       where e.repo_id = ? and e.type = 'IMPORTS' and e.to_id like 'import:%'`
    )
    .all(repoId) as { fromFile: string; toId: string }[];

  const byFile = new Map<string, Set<string>>();
  const cache = new Map<string, string | null>();

  for (const row of rows) {
    const specifier = row.toId.slice("import:".length);
    const python = isPythonFile(row.fromFile);
    if (!python && !isRelativeSpecifier(specifier) && !looksLikeModulePath(specifier)) continue;

    const fromFile = row.fromFile.replace(/\\/g, "/");
    const cacheKey = `${fromFile}\u0000${specifier}`;
    let target = cache.get(cacheKey);
    if (target === undefined) {
      target = resolveModuleSpecifier(fromFile, specifier, knownFiles, aliases);
      cache.set(cacheKey, target);
    }
    if (!target) continue;

    let set = byFile.get(fromFile);
    if (!set) {
      set = new Set<string>();
      byFile.set(fromFile, set);
    }
    set.add(target);
  }

  // PY-2: a Python file a scoped run did not re-extract holds RESOLVED imports, not `import:` tokens. Reading
  // only the tokens would give it an empty import scope on an incremental run and a full one on a full run,
  // so anything scoped by that file's imports (a base class picked for the MRO walk, a re-export hop) would
  // differ between the two. Its resolved module→module IMPORTS are the same set its tokens resolve to.
  const resolvedPythonImports = db
    .prepare(
      `select sf.file_path as fromFile, st.file_path as toFile
       from edges e
       join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
       join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
       where e.repo_id = ? and e.type = 'IMPORTS' and st.kind = 'module'
         and (sf.file_path like '%.py' or sf.file_path like '%.pyi')`
    )
    .all(repoId) as { fromFile: string; toFile: string }[];
  for (const row of resolvedPythonImports) {
    const fromFile = normalizeFilePath(row.fromFile);
    let set = byFile.get(fromFile);
    if (!set) {
      set = new Set<string>();
      byFile.set(fromFile, set);
    }
    set.add(normalizeFilePath(row.toFile));
  }

  // PY-2: `from pkg import f` lands on `pkg/__init__.py`, which re-exports `f` from a sibling module. One
  // hop through an imported `__init__` puts the re-exporting module's own imports in scope as well, so the
  // call resolver can prefer the `f` the package actually exports.
  // Read from a snapshot, so the result is exactly one hop whatever order the rows came in.
  const direct = new Map([...byFile].map(([file, set]) => [file, new Set(set)] as const));
  for (const [fromFile, targets] of byFile) {
    if (!isPythonFile(fromFile)) continue;
    for (const target of [...targets]) {
      if (!/(^|\/)__init__\.pyi?$/.test(target)) continue;
      for (const reExported of direct.get(target) ?? []) {
        if (reExported !== fromFile) targets.add(reExported);
      }
    }
  }

  return byFile;
}
