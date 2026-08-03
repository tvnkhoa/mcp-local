/**
 * Shared change-detection + per-file impact scoring.
 *
 * Extracted from handleDetectChanges so both `detect_changes` and the composite
 * `change_impact` (ENH-E) compute the changed-file set and per-file risk identically —
 * no drift between the two tools. Callers layer their own policy/sort/grouping (detect_changes)
 * or test-linking/residual-risk (change_impact) on top of this common core.
 */
import type { GraphStore } from "../../repositories/graphStore.js";
import { resolveHeadCommitSha, runGitLines } from "../gitHelpers.js";
import { scoreChangeRisk } from "../analysis/policyResolver.js";
import type { ReliabilitySummary } from "../../types/index.js";

export type ChangedFileImpact = {
  filePath: string;
  impactedFilesCount: number;
  reliabilitySummary: ReliabilitySummary;
  riskScore: number;
  riskLevel: "high" | "medium" | "low";
  riskSignals: { impactBreadth: number; unresolvedPenalty: number; confidencePenalty: number; lowConfidencePenalty: number };
  topImpactedFiles: { filePath: string; reason: string; confidence: number; symbolsAffected: string[] }[];
};

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

  const impacts: ChangedFileImpact[] = changedFiles.map((filePath) => {
    const impact = store.getImpactFiles(args.repoId, filePath, args.impactLimit);
    const risk = scoreChangeRisk(impact.impactedFiles.length, impact.reliabilitySummary, args.impactLimit);
    return {
      filePath,
      impactedFilesCount: impact.impactedFiles.length,
      reliabilitySummary: impact.reliabilitySummary,
      riskScore: risk.riskScore,
      riskLevel: risk.riskLevel,
      riskSignals: risk.signals,
      topImpactedFiles: impact.impactedFiles.slice(0, 5)
    };
  });

  return { baseRef: baseRef ?? null, headRef, indexedCommitSha: args.indexedCommitSha, changedFiles, note, impacts };
}
