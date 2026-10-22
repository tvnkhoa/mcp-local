/**
 * Shared change-detection + per-file impact scoring.
 *
 * Extracted from handleDetectChanges so both `detect_changes` and the composite
 * `change_impact` (ENH-E) compute the changed-file set and per-file risk identically —
 * no drift between the two tools. Callers layer their own policy/sort/grouping (detect_changes)
 * or test-linking/residual-risk (change_impact) on top of this common core.
 */
import type { GraphStore } from "../../repositories/graphStore.js";
import { parseNameStatusZ, parseStatusPorcelainV2Entries, resolveHeadCommitSha, runGit, runGitLines } from "../git/gitHelpers.js";
import { scoreChangeRisk } from "../analysis/policyResolver.js";
import type { ReliabilitySummary } from "../../types/index.js";

export type ChangedFileImpact = {
  filePath: string;
  /**
   * The TRUE number of dependent files — never capped by `impactLimit` (MCP-ISSUE-054 re-open).
   * It used to be `min(trueDependents, impactLimit)`, which is why the same file on the same diff
   * scored `medium` at the default page size and `high` at a wider one.
   */
  impactedFilesCount: number;
  reliabilitySummary: ReliabilitySummary;
  riskScore: number;
  riskLevel: "high" | "medium" | "low";
  riskSignals: { impactBreadth: number; unresolvedPenalty: number; confidencePenalty: number; lowConfidencePenalty: number; capHit: boolean };
  /**
   * MCP-ISSUE-054: `topImpactedFiles` is a page — more dependents exist than were listed. It no
   * longer means "the score is a floor": the score is now computed from the untruncated count.
   * Named after `search_regex`'s existing vocabulary rather than a new word.
   */
  truncated: boolean;
  truncationReason: "impact_limit_reached" | null;
  topImpactedFiles: { filePath: string; reason: string; confidence: number; symbolsAffected: string[] }[];
  /** MCP-ISSUE-087 (release K2): what happened to the path. */
  change?: ChangeKind;
  /** The new path is `added` with the old one here; the old path is `deleted` with the new one in `renamedTo`. */
  renamedFrom?: string;
  renamedTo?: string;
  /**
   * Why a removed path's dependents are what they are. The index no longer holds it, so they come from
   * import tokens that still resolve to it — and "none left" is said, not left as an empty list.
   */
  dependentsNote?: string;
};

export type ChangeKind = "added" | "modified" | "deleted";

/** One changed path, with the other side of a rename when git paired one. */
export type ChangedPath = { path: string; change: ChangeKind; renamedFrom?: string; renamedTo?: string };

/**
 * Score one changed file's blast radius. Exported so the invariance MCP-ISSUE-054 is about can be
 * asserted THROUGH the store call — the unit test that pinned `scoreChangeRisk` alone passed
 * happily while the truncation sat in this caller, one layer up. A correct test of the wrong seam.
 */
export function scoreFileImpact(
  store: GraphStore,
  repoId: string,
  filePath: string,
  impactLimit: number
): ChangedFileImpact {
  const impact = store.getImpactFiles(repoId, filePath, impactLimit);
  // `totalImpactedCount`, NOT `impactedFiles.length`: the latter is the page.
  const risk = scoreChangeRisk(impact.totalImpactedCount, impact.reliabilitySummary, impactLimit);
  return {
    filePath,
    impactedFilesCount: impact.totalImpactedCount,
    reliabilitySummary: impact.reliabilitySummary,
    riskScore: risk.riskScore,
    riskLevel: risk.riskLevel,
    riskSignals: risk.signals,
    truncated: impact.truncated,
    truncationReason: impact.truncated ? "impact_limit_reached" : null,
    topImpactedFiles: impact.impactedFiles.slice(0, 5)
  };
}

export type ChangedFileImpactsResult = {
  baseRef: string | null;
  headRef: string;
  indexedCommitSha: string | null;
  changedFiles: string[];
  /**
   * MCP-ISSUE-060: changed files BEFORE `maxFiles`. `changedFiles.length` is the page; this is the
   * truth. The old code computed this number one expression earlier and threw it away, so a 300-file
   * diff reported `changedFileCount: 100` with no signal — and because the cap slices an
   * alphabetically ordered set, a whole server's worth of files past the cut never appeared at all.
   */
  totalChangedFileCount: number;
  note: string;
  impacts: ChangedFileImpact[];
};

/**
 * MCP-ISSUE-060: git ran and failed, as opposed to git ran and found nothing.
 *
 * Mapped to `InvalidParams` by the handlers, because the only way to reach it is an input the caller
 * chose: a ref that does not resolve in this repo.
 */
export class ChangeAnalysisError extends Error {
  constructor(
    readonly code: "UNRESOLVED_REF",
    message: string
  ) {
    super(message);
    this.name = "ChangeAnalysisError";
  }
}

/**
 * Resolve the changed-file set (git range diff or working-tree diff) and score the static
 * blast radius of each changed file. Pure read: no writes, no index mutation.
 */
export function computeChangedFileImpacts(
  store: GraphStore,
  args: {
    repoId: string;
    repoPath: string;
    baseRef?: string;
    headRef: string;
    includeUntracked: boolean;
    maxFiles: number;
    impactLimit: number;
    indexedCommitSha: string | null;
  }
): ChangedFileImpactsResult {
  const headRef = args.headRef;
  const baseRef = args.baseRef ?? args.indexedCommitSha;
  const headCommitSha = resolveHeadCommitSha(args.repoPath);
  const isWorkingTreeMode = !baseRef || (headCommitSha != null && baseRef === headCommitSha);

  // MCP-ISSUE-087 (release K2): status-carrying reads, so a rename reports BOTH paths. `--name-only`
  // printed only the new side, and the old path's importers — the files a move breaks — never appeared.
  let changed: ChangedPath[];
  let note: string;
  if (isWorkingTreeMode) {
    // The freshness gate's own read: staged, unstaged and (here, on request) untracked paths, both
    // sides of a staged rename. A plain `mv` is a deleted path plus an untracked one: git pairs nothing.
    let out = "";
    try {
      out = runGit(args.repoPath, ["-c", "core.quotePath=false", "status", "--porcelain=v2", "-z", "--untracked-files=all"]);
    } catch {
      out = ""; // not a git repo, or an unborn HEAD: nothing changed, as before
    }
    changed = changedPathsFromStatus(out, args.includeUntracked);
    note = baseRef
      ? "using working-tree diff (no new commits since last index; showing staged + unstaged changes)"
      : "baseRef unavailable; using working-tree diff against HEAD";
  } else {
    // MCP-ISSUE-060: the one case with no legitimate reading of `[]`. A ref the caller typed either
    // resolves or it does not; answering "0 files changed, 0 high risk" for a ref that does not exist
    // is the worst possible output from a release gate.
    let out: string;
    try {
      out = runGit(args.repoPath, ["-c", "core.quotePath=false", "diff", "--name-status", "-z", "-M", `${baseRef}..${headRef}`]);
    } catch {
      throw new ChangeAnalysisError(
        "UNRESOLVED_REF",
        `git could not diff '${String(baseRef)}..${headRef}' in this repository. Check that both refs exist locally (git fetch may be needed) and are spelled correctly.`
      );
    }
    changed = changedPathsFromNameStatus(out);
    if (args.includeUntracked) {
      for (const p of runGitLines(args.repoPath, ["ls-files", "--others", "--exclude-standard"])) changed.push({ path: p, change: "added" });
    }
    note = "using git range diff";
  }

  const byPath = new Map<string, ChangedPath>();
  for (const c of changed) {
    const p = c.path.replace(/\\/g, "/").trim();
    if (p.length > 0 && !byPath.has(p)) byPath.set(p, { ...c, path: p });
  }
  const allChanged = [...byPath.values()];
  const totalChangedFileCount = allChanged.length;
  const page = allChanged.slice(0, args.maxFiles);
  const changedFiles = page.map((c) => c.path);

  const impacts: ChangedFileImpact[] = page.map((c) => {
    const base =
      c.change === "deleted" && store.getFileHash(args.repoId, c.path) === null
        ? scoreRemovedPathImpact(store, args.repoId, c.path, args.impactLimit)
        : scoreFileImpact(store, args.repoId, c.path, args.impactLimit);
    return {
      ...base,
      change: c.change,
      ...(c.renamedFrom !== undefined && { renamedFrom: c.renamedFrom }),
      ...(c.renamedTo !== undefined && { renamedTo: c.renamedTo })
    };
  });

  return { baseRef: baseRef ?? null, headRef, indexedCommitSha: args.indexedCommitSha, changedFiles, totalChangedFileCount, note, impacts };
}

/**
 * Changed paths from `git status --porcelain=v2 -z --untracked-files=all`. A staged rename gives the new
 * path (`added`, `renamedFrom`) then the old one (`deleted`, `renamedTo`); a copy adds its new path only.
 */
export function changedPathsFromStatus(out: string, includeUntracked: boolean): ChangedPath[] {
  const result: ChangedPath[] = [];
  for (const e of parseStatusPorcelainV2Entries(out).entries) {
    if (e.code === "?") {
      if (includeUntracked) result.push({ path: e.path, change: "added" });
      continue;
    }
    const xy = e.xy ?? "..";
    if (e.code === "2" && e.origPath) {
      const copy = xy.includes("C");
      result.push({ path: e.path, change: "added", ...(!copy && { renamedFrom: e.origPath }) });
      if (!copy) result.push({ path: e.origPath, change: "deleted", renamedTo: e.path });
      continue;
    }
    const change: ChangeKind = xy.includes("D") ? "deleted" : xy[0] === "A" ? "added" : "modified";
    result.push({ path: e.path, change });
  }
  return result;
}

/** Changed paths from `git diff --name-status -z -M` (git's default rename similarity, 50%). */
export function changedPathsFromNameStatus(out: string): ChangedPath[] {
  const result: ChangedPath[] = [];
  for (const e of parseNameStatusZ(out)) {
    if (e.status === "R" && e.origPath) {
      result.push({ path: e.path, change: "added", renamedFrom: e.origPath });
      result.push({ path: e.origPath, change: "deleted", renamedTo: e.path });
    } else if (e.status === "C" || e.status === "A") {
      result.push({ path: e.path, change: "added" });
    } else {
      result.push({ path: e.path, change: e.status === "D" ? "deleted" : "modified" });
    }
  }
  return result;
}

/** A resolved import edge carries 0.95 (`resolved relative import`); a token resolving to the removed path is the same evidence. */
const REMOVED_PATH_IMPORT_CONFIDENCE = 0.95;

/**
 * A path the index no longer holds — the old side of a rename, or a deleted file, once the freshness
 * gate's refresh has pruned it. Its dependents are the files whose import tokens still resolve to it
 * (MCP-ISSUE-087). Callers that reach its symbols without an import (globals, C# namespaces) are not
 * claimed: those stay unresolved callee tokens.
 */
export function scoreRemovedPathImpact(store: GraphStore, repoId: string, filePath: string, impactLimit: number): ChangedFileImpact {
  const hits = store.findImportersOfRemovedPath(repoId, filePath);
  const byFile = new Map<string, string>();
  for (const h of hits) if (!byFile.has(h.fromFile)) byFile.set(h.fromFile, h.specifier);
  const files = [...byFile.entries()];
  const reliabilitySummary: ReliabilitySummary = {
    edgeCount: hits.length,
    medianConfidence: hits.length > 0 ? REMOVED_PATH_IMPORT_CONFIDENCE : 1,
    lowConfidenceEdgeCount: 0,
    unresolvedRatio: 0,
    warning: null
  };
  const risk = scoreChangeRisk(files.length, reliabilitySummary, impactLimit);
  const truncated = files.length > impactLimit;
  return {
    filePath,
    impactedFilesCount: files.length,
    reliabilitySummary,
    riskScore: risk.riskScore,
    riskLevel: risk.riskLevel,
    riskSignals: risk.signals,
    truncated,
    truncationReason: truncated ? "impact_limit_reached" : null,
    topImpactedFiles: files.slice(0, 5).map(([fromFile, specifier]) => ({
      filePath: fromFile,
      reason: `imports '${specifier}' — ${filePath} no longer exists`,
      confidence: REMOVED_PATH_IMPORT_CONFIDENCE,
      symbolsAffected: []
    })),
    dependentsNote:
      files.length > 0
        ? `${filePath} is no longer in the index; its dependents are the files whose imports still resolve to it`
        : `no remaining importer references ${filePath}`
  };
}
