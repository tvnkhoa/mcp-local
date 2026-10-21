/**
 * R11: the reverse file graph `link_tests_to_source(forWorkingTreeDiff: true)` walks from the dirty
 * files to the tests that reach them.
 *
 * Three kinds of file → file edge, all read from the index:
 *   - `IMPORTS`        a resolved import (relative, tsconfig alias, `.vue` SFC import);
 *   - `USES_COMPONENT` a template renders a component (Vue lane, MCP-ISSUE-074);
 *   - `workspace`      a bare import of a package of THIS repo (`@aria/core/audit`). The import
 *                      resolver leaves those as `import:` tokens — a package name is not a path —
 *                      so they are mapped here through the target package's `package.json`
 *                      `exports` (or its directory when there is no `exports`). The package set is
 *                      the one `resolveWorkspacePackageEdges` (MCP-ISSUE-076) builds its DEPENDS_ON
 *                      edges from: module symbols with `signature = npm:<name>`.
 *
 * A bare import whose subpath no `exports` entry names is mapped to the whole package
 * (`packageLevel`), and the caller says so — over-reporting a test is the safe direction here.
 */

import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { resolveModuleSpecifier } from "../graph/moduleResolution.js";

export type ReverseEdgeKind = "import" | "component" | "workspace";
export type ReverseEdge = { importer: string; kind: ReverseEdgeKind; specifier?: string; packageLevel?: boolean };

export type WorkspacePackage = { name: string; dir: string };

export type ReverseFileGraph = {
  /** target file → the files that reach it in one hop. */
  reverse: Map<string, ReverseEdge[]>;
  /** Package-level workspace edges: target package dir → importers (any file in it counts). */
  packageImporters: Map<string, ReverseEdge[]>;
  packages: WorkspacePackage[];
  indexedFiles: Set<string>;
  /** Unresolved non-package import tokens, kept to name gaps against the changed files. */
  unresolvedSpecifiers: { importer: string; specifier: string }[];
  edgeRowsCapped: boolean;
};

const MAX_EDGE_ROWS = 400_000;

const norm = (p: string) => p.replace(/\\/g, "/");
const dirOf = (p: string) => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
};

/** `@scope/name/sub/path` → { name: "@scope/name", subpath: "sub/path" }. */
export function splitPackageSpecifier(spec: string): { name: string; subpath: string } | null {
  if (spec.startsWith(".") || spec.startsWith("/") || /^[a-z]+:/i.test(spec)) return null;
  const parts = spec.split("/");
  if (spec.startsWith("@")) {
    if (parts.length < 2 || !parts[1]) return null;
    return { name: `${parts[0]}/${parts[1]}`, subpath: parts.slice(2).join("/") };
  }
  return { name: parts[0]!, subpath: parts.slice(1).join("/") };
}

type ExportsValue = string | null | ExportsValue[] | { [k: string]: ExportsValue };

/** Every string target an `exports` value can resolve to, in condition order (default/import first). */
function exportTargets(v: ExportsValue | undefined): string[] {
  if (v === undefined || v === null) return [];
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(exportTargets);
  const preferred = ["default", "import", "source", "types", "node", "require"];
  const keys = [...preferred.filter((k) => k in v), ...Object.keys(v).filter((k) => !preferred.includes(k))];
  return keys.flatMap((k) => exportTargets(v[k]));
}

/**
 * The repo files `<pkg>/<subpath>` names through `exports`, or null when `exports` has no entry for it
 * (or the package has no `exports`). Pure apart from the inputs; unit-tested.
 */
export function resolveExportsSubpath(
  exportsField: unknown,
  pkgDir: string,
  subpath: string,
  knownFiles: ReadonlySet<string>
): string | null {
  if (exportsField === undefined || exportsField === null) return null;
  const key = subpath ? `./${subpath}` : ".";
  let map: Record<string, ExportsValue>;
  if (typeof exportsField === "string" || Array.isArray(exportsField)) map = { ".": exportsField as ExportsValue };
  else if (typeof exportsField === "object") {
    const obj = exportsField as Record<string, ExportsValue>;
    map = Object.keys(obj).some((k) => k.startsWith(".")) ? obj : { ".": obj };
  } else return null;

  let targets: string[] = [];
  if (key in map) targets = exportTargets(map[key]);
  else {
    // Pattern keys: "./*" or "./features/*.js" — the longest matching prefix wins, as in Node.
    let best: { prefix: string; stem: string; value: ExportsValue } | null = null;
    for (const [k, value] of Object.entries(map)) {
      const star = k.indexOf("*");
      if (star < 0) continue;
      const prefix = k.slice(0, star);
      const suffix = k.slice(star + 1);
      if (key.startsWith(prefix) && key.endsWith(suffix) && key.length >= prefix.length + suffix.length) {
        if (!best || prefix.length > best.prefix.length) best = { prefix, stem: key.slice(prefix.length, key.length - suffix.length), value };
      }
    }
    if (best) targets = exportTargets(best.value).map((t) => t.replace(/\*/g, best!.stem));
  }
  const from = pkgDir ? `${pkgDir}/package.json` : "package.json";
  for (const t of targets) {
    if (!t.startsWith("./")) continue;
    const hit = resolveModuleSpecifier(from, t, knownFiles);
    if (hit) return hit;
  }
  return null;
}

/** Without `exports`: `<pkg>/<subpath>` as a path inside the package, then the usual entry points. */
function resolveWithoutExports(pkgJson: Record<string, unknown>, pkgDir: string, subpath: string, knownFiles: ReadonlySet<string>): string | null {
  const from = pkgDir ? `${pkgDir}/package.json` : "package.json";
  const tries = subpath
    ? [`./${subpath}`, `./src/${subpath}`]
    : [typeof pkgJson["module"] === "string" ? String(pkgJson["module"]) : null, typeof pkgJson["main"] === "string" ? String(pkgJson["main"]) : null, "./index", "./src/index"].filter((x): x is string => !!x);
  for (const t of tries) {
    const hit = resolveModuleSpecifier(from, t.startsWith(".") ? t : `./${t}`, knownFiles);
    if (hit) return hit;
  }
  return null;
}

export function loadReverseFileGraph(db: Database.Database, repoId: string, repoPath: string): ReverseFileGraph {
  const reverse = new Map<string, ReverseEdge[]>();
  const packageImporters = new Map<string, ReverseEdge[]>();
  const add = (m: Map<string, ReverseEdge[]>, k: string, e: ReverseEdge) => {
    const l = m.get(k);
    if (l) l.push(e);
    else m.set(k, [e]);
  };

  const indexedFiles = new Set(
    (db.prepare(`select path from files where repo_id = ?`).all(repoId) as { path: string }[]).map((r) => norm(r.path))
  );

  const resolved = db
    .prepare(
      `select distinct sf.file_path as fromFile, st.file_path as toFile, e.type as type
       from edges e
       inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
       inner join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
       where e.repo_id = ? and e.type in ('IMPORTS', 'USES_COMPONENT')
         and sf.file_path is not null and st.file_path is not null and sf.file_path != st.file_path
       limit ${MAX_EDGE_ROWS}`
    )
    .all(repoId) as { fromFile: string; toFile: string; type: string }[];
  for (const r of resolved) {
    add(reverse, norm(r.toFile), { importer: norm(r.fromFile), kind: r.type === "USES_COMPONENT" ? "component" : "import" });
  }

  // Workspace packages, from the JSON lane's package.json module symbols.
  const pkgRows = db
    .prepare(`select signature, file_path as filePath from symbols where repo_id = ? and kind = 'module' and signature like 'npm:%' order by file_path`)
    .all(repoId) as { signature: string; filePath: string }[];
  const packages: WorkspacePackage[] = [];
  const pkgByName = new Map<string, { dir: string; json: Record<string, unknown> }>();
  for (const row of pkgRows) {
    const fp = norm(row.filePath);
    if (!fp.endsWith("package.json")) continue;
    const name = row.signature.slice(4);
    if (pkgByName.has(name)) continue;
    const dir = dirOf(fp);
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(fs.readFileSync(path.join(repoPath, fp), "utf8")) as Record<string, unknown>;
    } catch {
      // unreadable package.json: directory-level mapping only
    }
    pkgByName.set(name, { dir, json });
    packages.push({ name, dir });
  }

  const tokens = db
    .prepare(
      `select distinct sf.file_path as fromFile, substr(e.to_id, 8) as specifier
       from edges e
       inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
       where e.repo_id = ? and e.type = 'IMPORTS' and e.to_id like 'import:%'
       limit ${MAX_EDGE_ROWS}`
    )
    .all(repoId) as { fromFile: string; specifier: string }[];
  const unresolvedSpecifiers: { importer: string; specifier: string }[] = [];
  for (const t of tokens) {
    const importer = norm(t.fromFile);
    const spec = t.specifier.replace(/[?#].*$/, "");
    const split = splitPackageSpecifier(spec);
    const pkg = split ? pkgByName.get(split.name) : undefined;
    if (!split || !pkg) {
      if (spec.startsWith(".")) unresolvedSpecifiers.push({ importer, specifier: spec });
      continue;
    }
    const target =
      pkg.json["exports"] !== undefined
        ? resolveExportsSubpath(pkg.json["exports"], pkg.dir, split.subpath, indexedFiles)
        : resolveWithoutExports(pkg.json, pkg.dir, split.subpath, indexedFiles);
    if (target) add(reverse, target, { importer, kind: "workspace", specifier: spec });
    else add(packageImporters, pkg.dir, { importer, kind: "workspace", specifier: spec, packageLevel: true });
  }

  return {
    reverse,
    packageImporters,
    packages,
    indexedFiles,
    unresolvedSpecifiers,
    edgeRowsCapped: resolved.length >= MAX_EDGE_ROWS || tokens.length >= MAX_EDGE_ROWS
  };
}
