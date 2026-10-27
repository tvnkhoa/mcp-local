/**
 * The scan phase of an index run: what is on disk, and what the C# extractors need to know
 * about it before any file is parsed.
 *
 * Extracted from `indexPipeline.ts` in S-41. Separable because it reads the filesystem and
 * returns a value — it touches none of the run counters, which is what makes the rest of that
 * function hard to break apart.
 *
 * The `.csproj` pre-scan has to happen here rather than per file: `knownPackageNames` widens
 * namespace→nuget contract mapping for *every* C# file (ISSUE-006), so it must be complete
 * before the first extraction, not accumulated as the batches go by.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { glob } from "glob";

import { INDEX_IGNORE_GLOBS, hasOnlyGitDeferredSegments, isBinaryAssetPath, isExcludedByPath, isIgnoredByIndexWalk } from "./fileFilter.js";
import { tallySkip, type SkipTally } from "./skipReport.js";
import { listGitVisibleFiles } from "../git/gitHelpers.js";
import { indexLog } from "./indexProgress.js";

export interface FileScanInput {
  readonly repoId: string;
  readonly repoPath: string;
  readonly mode: string;
  /** Dirty mode (ENH-A): repo-relative POSIX paths to restrict the scan to. */
  readonly onlyRelativePaths?: Set<string>;
  /** The run's directory cache for `existsWithExactCase`, shared with the pipeline's prune. */
  readonly dirListings?: DirListings;
  /** Skip files .gitignore excludes (default true; no effect outside git). Env: CODEBASE_INDEX_RESPECT_GITIGNORE. */
  readonly respectGitignore?: boolean;
  /**
   * Release J: the repo-relative `.csproj` paths already indexed. A dirty run sees only its changed
   * files, but C# extraction reads every project's PackageReference names, so it pre-scans these too —
   * otherwise a dirty run extracted a `.cs` file differently from a full run.
   */
  readonly indexedCsprojPaths?: readonly string[];
}

export interface FileScanResult {
  /** Absolute paths, already restricted by the dirty set when one was given. */
  readonly files: string[];
  /** NuGet package ids declared by any `.csproj` in the scan. */
  readonly knownPackageNames: Set<string>;
  /** Files the walk dropped for an excluded path segment (`assets/`, `public/`…), by extension. */
  readonly droppedByPath: SkipTally;
  /** Git decided visibility, so build-named segments deferred to it (MCP-ISSUE-078). */
  readonly gitAware: boolean;
}

/**
 * Glob the repo, drop excluded path segments and apply the dirty-file restriction, then pre-scan
 * `.csproj` package references.
 *
 * `maxFiles` is used only for the log line here; the cap itself is applied by the caller, which
 * needs the *unclamped* `files.length` to decide whether pruning is safe.
 */
export async function scanRepoFiles(
  input: FileScanInput,
  maxFiles: number,
  includeDocs: boolean
): Promise<FileScanResult> {
  indexLog(`[index-start] repoId=${input.repoId} mode=${input.mode} scanning files...`);

  // MCP-ISSUE-060: `dot: true` here too, and deliberately in the same change as `regexSearch.ts`.
  // Fixing only one desynchronises search scope from index scope — `search_regex` would report hits
  // in files the graph has never seen, and every `enclosingSymbol` on them would be null with no
  // explanation. `.git/**`, `.vs/**` and `.idea/**` are excluded by INDEX_IGNORE_GLOBS; `.vscode` and the other segment-only names by
  // the filter below, still before the `maxFiles` cap. Takes effect on the next index run.
  // Release J: a dirty run knows its paths; walking the whole tree to keep a handful of them cost ~1 s
  // per refresh on wec.aria. `isIgnoredByIndexWalk` gives the walk's answer for one path.
  const isFile = (abs: string): boolean => {
    try {
      return statSync(abs).isFile();
    } catch {
      return false;
    }
  };
  const globbed = input.onlyRelativePaths
    ? [...input.onlyRelativePaths]
        .filter((rel) => !isIgnoredByIndexWalk(rel) && existsWithExactCase(input.repoPath, rel, input.dirListings))
        .map((rel) => path.join(input.repoPath, rel))
        .filter(isFile)
        .sort()
    : (
        await glob("**/*", {
          cwd: input.repoPath,
          nodir: true,
          dot: true,
          absolute: true,
          windowsPathsNoEscape: true,
          ignore: INDEX_IGNORE_GLOBS
        })
      ).sort();
  // `glob` returns directory-order results, which differ between calls on the same unchanged tree —
  // verified over three consecutive calls, first divergence at index 11. Processing order then
  // decided which cross-file C# type references were already resolvable, so two identical runs
  // produced edge counts differing by ~1.4% (PROPERTY_REF moved by 502). That made a before/after
  // edge count useless as evidence, which is how MCP-ISSUE-032 was found.
  //
  // Plain `.sort()`, deliberately not `localeCompare`: the default UTF-16 code-unit order is
  // identical on every platform and locale, which is the property being bought here. A
  // locale-sensitive comparison would reintroduce the same class of bug across machines.
  //
  // This makes runs reproducible. It does NOT make resolution order-independent — see
  // MCP-ISSUE-033, which records the measurement showing that a different fixed order still yields
  // different edge counts.

  // Dirty mode (ENH-A): restrict the scan to an explicit set of repo-relative POSIX
  // paths (the git working-tree delta). When set, pruning is suppressed by the caller so the
  // restricted set is never mistaken for "all files on disk".
  //
  // Excluded path segments are dropped HERE, before the caller applies `maxFiles` (MCP-ISSUE-066
  // structural fix). The glob ignore list covers vendor and IDE-state trees, but segment-only
  // exclusions (`wwwroot`, `public`, `static`, `assets`, `logs`, `.vscode`) used to survive the walk,
  // and a large one could fill the whole budget before `shouldIndexFile` discarded it. Tested on the
  // repo-relative path, so a repo that itself lives under e.g. `D:/assets/` is not emptied.
  const droppedByPath: SkipTally = new Map();
  // Release B.1 (wec.aria acceptance): gitignored build output was indexed — `packages/core/dist-runtime`
  // put every core symbol in the graph twice (gate.ts:260 and dist-runtime/tools/gate.js:250). Git's
  // own answer decides; a non-git repo keeps the plain walk.
  const visible = input.respectGitignore === false || input.onlyRelativePaths ? null : listGitVisibleFiles(input.repoPath);
  // MCP-ISSUE-078: whether build-named segments (`bin/`, `obj/`, …) defer to git. A dirty run's set
  // comes from git itself (`collectDirtyFiles`: tracked changes plus untracked-not-ignored), so it is
  // git-cleared by construction.
  const gitAware = input.respectGitignore !== false && (visible !== null || input.onlyRelativePaths !== undefined);
  const files = globbed.filter((abs) => {
    const relative = toPosixRelative(input.repoPath, abs);
    if (isExcludedByPath(relative)) {
      // A dirty-mode run walks only its delta; counting the rest of the tree here would misreport it.
      if (!input.onlyRelativePaths) tallySkip(droppedByPath, isBinaryAssetPath(relative) ? "binary_asset" : "excluded_path", relative);
      return false;
    }
    if (visible && !visible.has(relative)) {
      tallySkip(droppedByPath, "gitignored", relative);
      return false;
    }
    return input.onlyRelativePaths ? input.onlyRelativePaths.has(relative) : true;
  });

  // The glob never walks `bin/`/`obj/`/`build/`/`out/`/`target/` (a .NET `obj/` holds tens of thousands
  // of files). In a git repo the source files git reports under them are added back from git's own
  // list instead — tracked or untracked-not-ignored, present on disk, a source language, and no other
  // excluded segment (`node_modules`, `dist` and `.git` stay out whatever git says).
  if (gitAware) {
    const gitListed = visible ?? input.onlyRelativePaths ?? new Set<string>();
    const added: string[] = [];
    for (const relative of gitListed) {
      if (!hasOnlyGitDeferredSegments(relative)) continue;
      if (isExcludedByPath(relative, { gitCleared: true })) {
        if (!input.onlyRelativePaths) tallySkip(droppedByPath, isBinaryAssetPath(relative) ? "binary_asset" : "excluded_path", relative);
        continue;
      }
      const absolute = path.join(input.repoPath, relative);
      if (!existsSync(absolute)) continue;
      added.push(absolute);
    }
    if (added.length > 0) {
      files.push(...added);
      // Same code-unit order as the glob result (see the sort comment above), so processing order —
      // and with it every order-sensitive count — stays a property of the tree.
      files.sort();
    }
  }

  indexLog(`[index-scan-complete] found ${String(files.length)} files (${String(globbed.length - files.length)} dropped by excluded path or dirty set), will process up to ${String(maxFiles)}`);

  // Pre-scan: collect all PackageReference names from .csproj files so C# extractors
  // can widen namespace→nuget contract mapping beyond the hardcoded set. (ISSUE-006)
  const knownPackageNames = new Set<string>();
  const csprojFiles = [
    ...new Set([
      ...files.filter((f) => f.endsWith(".csproj")),
      ...(input.onlyRelativePaths ? (input.indexedCsprojPaths ?? []).map((rel) => path.join(input.repoPath, rel)).filter(isFile) : [])
    ])
  ];
  if (csprojFiles.length > 0) {
    const pkgRefRe = /<PackageReference\s+Include="([^"]+)"/gi;
    for (const csprojPath of csprojFiles) {
      try {
        const src = await readFile(csprojPath, "utf8");
        let m: RegExpExecArray | null;
        pkgRefRe.lastIndex = 0;
        while ((m = pkgRefRe.exec(src)) !== null) {
          if (m[1]) knownPackageNames.add(m[1].trim());
        }
      } catch {
        // Non-critical — skip unreadable csproj
      }
    }
    if (knownPackageNames.size > 0) {
      indexLog(`[index-nuget-bridge] collected ${String(knownPackageNames.size)} package names from ${String(csprojFiles.length)} .csproj files`);
    }
  }

  if (includeDocs) {
    // Count markdown files for user feedback
    const markdownFiles = files.filter((f) => f.endsWith(".md") || f.endsWith(".mdx"));
    if (markdownFiles.length > 0) {
      indexLog(`[index-scan] found ${String(markdownFiles.length)} markdown files for doc indexing`);
    }
  } else {
    indexLog("[index-scan] docs lane disabled for this run (markdown/docs indexing skipped)");
  }

  return { files, knownPackageNames, droppedByPath, gitAware };
}

/**
 * A repo-relative path with forward slashes — the ONE spelling every table stores (MCP-ISSUE-079).
 * `path.relative` gives backslashes on Windows; normalizing here, where the run's paths are born, is
 * what makes `files.path`, `symbols.file_path` and the ids minted from them agree across platforms.
 */
export function toPosixRelative(repoPath: string, absolutePath: string): string {
  return path.relative(repoPath, absolutePath).replace(/\\/g, "/");
}

/**
 * Whether `rel` exists under `root` spelled exactly so, segment by segment. On a case-insensitive filesystem
 * (Windows, macOS) `existsSync("src/caller.ts")` is true after `git mv src/caller.ts src/Caller.ts`, so a scoped
 * run (dirty, or git-scoped incremental: MCP-ISSUE-106) re-read the old spelling and never pruned it, where the walk,
 * which lists the real names, does.
 *
 * `listings` is the run's directory cache, shared by the scan's filter and the pipeline's prune, so each directory
 * is read once per run however many dirty paths sit in it (a readdir of a 3,000-entry directory is ~1 ms on
 * Windows). Names compare in NFC: macOS HFS+ returns NFD, git and the index hold NFC, and a mismatch would read
 * a non-ASCII file as deleted.
 */
export type DirListings = Map<string, Set<string> | null>;

export function existsWithExactCase(
  root: string,
  rel: string,
  listings: DirListings = new Map(),
  readdir: (dir: string) => string[] = readdirSync
): boolean {
  if (!existsSync(path.join(root, rel))) return false;
  let dir = root;
  for (const segment of rel.split("/")) {
    if (!segment) continue;
    let names = listings.get(dir);
    if (names === undefined) {
      try {
        names = new Set(readdir(dir).map((n) => n.normalize("NFC")));
      } catch {
        names = null;
      }
      listings.set(dir, names);
    }
    if (!names?.has(segment.normalize("NFC"))) return false;
    dir = path.join(dir, segment);
  }
  return true;
}
