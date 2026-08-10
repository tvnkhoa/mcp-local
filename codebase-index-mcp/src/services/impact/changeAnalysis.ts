/**
 * Shared change-detection + per-file impact scoring.
 *
 * Extracted from handleDetectChanges so both `detect_changes` and the composite
 * `change_impact` (ENH-E) compute the changed-file set and per-file risk identically —
 * no drift between the two tools. Callers layer their own policy/sort/grouping (detect_changes)
 * or test-linking/residual-risk (change_impact) on top of this common core.
 */
import type { GraphStore } from "../../repositories/graphStore.js";
import { resolveHeadCommitSha, runGitLines } from "../git/gitHelpers.js";
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
};

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
  note: string;
  impacts: ChangedFileImpact[];
};

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

  let trackedChanged: string[];
  let note: string;
  if (isWorkingTreeMode) {
    const unstaged = runGitLines(args.repoPath, ["diff", "--name-only", "HEAD"]);
    const staged = runGitLines(args.repoPath, ["diff", "--cached", "--name-only"]);
    trackedChanged = [...new Set([...unstaged, ...staged])];
    note = baseRef
      ? "using working-tree diff (no new commits since last index; showing staged + unstaged changes)"
      : "baseRef unavailable; using working-tree diff against HEAD";
  } else {
    trackedChanged = runGitLines(args.repoPath, ["diff", "--name-only", `${baseRef}..${headRef}`]);
    note = "using git range diff";
  }

  const untracked = args.includeUntracked
    ? runGitLines(args.repoPath, ["ls-files", "--others", "--exclude-standard"])
    : [];

  const changedFiles = [
    ...new Set(
      [...trackedChanged, ...untracked]
        .map((x) => x.replace(/\\/g, "/").trim())
        .filter((x) => x.length > 0)
    )
  ].slice(0, args.maxFiles);

  const impacts: ChangedFileImpact[] = changedFiles.map((filePath) =>
    scoreFileImpact(store, args.repoId, filePath, args.impactLimit)
  );

  return { baseRef: baseRef ?? null, headRef, indexedCommitSha: args.indexedCommitSha, changedFiles, note, impacts };
}
