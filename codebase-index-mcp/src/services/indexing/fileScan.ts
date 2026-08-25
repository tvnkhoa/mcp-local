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

import { readFile } from "node:fs/promises";
import path from "node:path";

import { glob } from "glob";

import { INDEX_IGNORE_GLOBS } from "./fileFilter.js";
import { indexLog } from "./indexProgress.js";

export interface FileScanInput {
  readonly repoId: string;
  readonly repoPath: string;
  readonly mode: string;
  /** Dirty mode (ENH-A): repo-relative POSIX paths to restrict the scan to. */
  readonly onlyRelativePaths?: Set<string>;
}

export interface FileScanResult {
  /** Absolute paths, already restricted by the dirty set when one was given. */
  readonly files: string[];
  /** NuGet package ids declared by any `.csproj` in the scan. */
  readonly knownPackageNames: Set<string>;
}

/**
 * Glob the repo, apply the dirty-file restriction, and pre-scan `.csproj` package references.
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
  // explanation. `.git/**` is excluded by INDEX_IGNORE_GLOBS; `.vs`/`.idea` by EXCLUDED_PATH_SEGMENTS
  // downstream. Takes effect on the next index run for each repo.
  const globbed = (
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
  const files = input.onlyRelativePaths
    ? globbed.filter((abs) =>
        input.onlyRelativePaths!.has(path.relative(input.repoPath, abs).replace(/\\/g, "/"))
      )
    : globbed;

  indexLog(`[index-scan-complete] found ${String(files.length)} files${input.onlyRelativePaths ? ` (restricted from ${String(globbed.length)} by dirty file set)` : ""}, will process up to ${String(maxFiles)}`);

  // Pre-scan: collect all PackageReference names from .csproj files so C# extractors
  // can widen namespace→nuget contract mapping beyond the hardcoded set. (ISSUE-006)
  const knownPackageNames = new Set<string>();
  const csprojFiles = files.filter((f) => f.endsWith(".csproj"));
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

  return { files, knownPackageNames };
}
