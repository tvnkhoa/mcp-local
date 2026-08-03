import { execFileSync } from "node:child_process";

import type { GraphStore } from "../repositories/graphStore.js";

export function runGit(repoPath: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoPath, encoding: "utf8" }).trim();
}

export function runGitLines(repoPath: string, args: string[]): string[] {
  try {
    const text = runGit(repoPath, args);
    if (!text) {
      return [];
    }
    return text.split(/\r?\n/).map((x) => x.trim()).filter((x) => x.length > 0);
  } catch {
    return [];
  }
}

export function resolveHeadCommitSha(repoPath: string): string | null {
  try {
    return runGit(repoPath, ["rev-parse", "HEAD"]).trim();
  } catch {
    return null;
  }
}

export function resolveCurrentBranch(repoPath: string): string | null {
  try {
    const name = runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    // "HEAD" means detached HEAD — no branch name available
    return name === "HEAD" ? null : name;
  } catch {
    return null;
  }
}

export function runGitStatusPorcelain(repoPath: string): string[] | null {
  try {
    const text = runGit(repoPath, ["status", "--porcelain"]);
    if (!text) {
      return [];
    }
    return text.split(/\r?\n/).map((x) => x.trim()).filter((x) => x.length > 0);
  } catch {
    return null;
  }
}

export function parseGitBlamePorcelain(text: string): {
  commit: string;
  author: string | null;
  authorMail: string | null;
  authorTime: number | null;
  summary: string | null;
} {
  const lines = text.split(/\r?\n/);
  const first = lines[0]?.trim() ?? "";
  const commit = first.split(" ")[0] ?? "";

  let author: string | null = null;
  let authorMail: string | null = null;
  let authorTime: number | null = null;
  let summary: string | null = null;

  for (const line of lines) {
    if (line.startsWith("author ")) {
      author = line.slice("author ".length).trim() || null;
      continue;
    }
    if (line.startsWith("author-mail ")) {
      authorMail = line.slice("author-mail ".length).trim().replace(/^<|>$/g, "") || null;
      continue;
    }
    if (line.startsWith("author-time ")) {
      const value = Number(line.slice("author-time ".length).trim());
      authorTime = Number.isFinite(value) ? value : null;
      continue;
    }
    if (line.startsWith("summary ")) {
      summary = line.slice("summary ".length).trim() || null;
    }
  }

  return {
    commit,
    author,
    authorMail,
    authorTime,
    summary
  };
}

export function redactEmail(email: string | null): string | null {
  if (!email) {
    return null;
  }
  const [localPart, domain] = email.split("@");
  if (!domain || !localPart) {
    return "***";
  }
  const safeLocal = localPart.length <= 2 ? "**" : `${localPart.slice(0, 1)}***${localPart.slice(-1)}`;
  return `${safeLocal}@${domain}`;
}

export function getRepoWorkingTreeState(repoPath: string): {
  isDirty: boolean | null;
  hasTrackedChanges: boolean | null;
  hasUntrackedChanges: boolean | null;
  changedEntries: number;
  note: string;
} {
  const lines = runGitStatusPorcelain(repoPath);
  if (!lines) {
    return {
      isDirty: null,
      hasTrackedChanges: null,
      hasUntrackedChanges: null,
      changedEntries: 0,
      note: "non-git repo or unable to read working tree status"
    };
  }

  let hasTrackedChanges = false;
  let hasUntrackedChanges = false;
  for (const line of lines) {
    if (line.startsWith("??")) {
      hasUntrackedChanges = true;
      continue;
    }
    if (!line.startsWith("!!")) {
      hasTrackedChanges = true;
    }
  }

  const isDirty = hasTrackedChanges || hasUntrackedChanges;
  return {
    isDirty,
    hasTrackedChanges,
    hasUntrackedChanges,
    changedEntries: lines.length,
    note: isDirty ? "working tree has pending changes" : "working tree is clean"
  };
}

export function hasWorkingTreeChanges(repoPath: string): boolean | null {
  try {
    const lines = runGitLines(repoPath, ["status", "--porcelain", "--untracked-files=all"]);
    return lines.length > 0;
  } catch {
    return null;
  }
}

export function collectGitChangedFiles(repoPath: string): Set<string> {
  const files = runGitLines(repoPath, ["diff", "--name-only", "HEAD"])
    .map((x) => x.replace(/\\/g, "/"));
  return new Set(files);
}

/**
 * Full working-tree delta as repo-relative POSIX paths: unstaged + staged + untracked.
 * Unlike `collectGitChangedFiles` (unstaged-vs-HEAD only) this is the complete set of
 * files `index_repository(mode="dirty")` must re-index. Returns an empty set on a
 * non-git repo or clean tree.
 */
export function collectDirtyFiles(repoPath: string): Set<string> {
  // `-c core.quotePath=false` so non-ASCII paths come back verbatim (not C-quoted/octal-escaped);
  // otherwise dirty-mode's onlyRelativePaths filter never matches them and the edited file is
  // silently skipped from re-index.
  const noQuote = ["-c", "core.quotePath=false"];
  const unstaged = runGitLines(repoPath, [...noQuote, "diff", "--name-only", "HEAD"]);
  const staged = runGitLines(repoPath, [...noQuote, "diff", "--cached", "--name-only"]);
  const untracked = runGitLines(repoPath, [...noQuote, "ls-files", "--others", "--exclude-standard"]);
  return new Set([...unstaged, ...staged, ...untracked].map((x) => x.replace(/\\/g, "/")));
}

/**
 * Number of commits HEAD is ahead of the indexed commit (`indexedSha..HEAD`).
 * Best-effort: returns null on a non-git repo, detached/unknown sha, or git error.
 */
export function countCommitsBehind(repoPath: string, indexedSha: string | null): number | null {
  if (!indexedSha) {
    return null;
  }
  try {
    const out = runGit(repoPath, ["rev-list", "--count", `${indexedSha}..HEAD`]).trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function getRepoStaleness(
  repoId: string,
  store: GraphStore
): {
  repoId: string;
  indexedCommitSha: string | null;
  headCommitSha: string | null;
  isStale: boolean | null;
  note: string;
} {
  const repo = store.getRepository(repoId);
  const latestRun = store.getLatestRun(repoId);

  if (!repo) {
    return {
      repoId,
      indexedCommitSha: latestRun?.commitSha ?? null,
      headCommitSha: null,
      isStale: null,
      note: "repository not found"
    };
  }

  if (!latestRun) {
    return {
      repoId,
      indexedCommitSha: null,
      headCommitSha: resolveHeadCommitSha(repo.repoPath),
      isStale: null,
      note: "no indexed run yet"
    };
  }

  const headCommitSha = resolveHeadCommitSha(repo.repoPath);
  if (!headCommitSha) {
    return {
      repoId,
      indexedCommitSha: latestRun.commitSha,
      headCommitSha,
      isStale: null,
      note: "non-git repo or unable to resolve HEAD"
    };
  }

  if (!latestRun.commitSha) {
    return {
      repoId,
      indexedCommitSha: latestRun.commitSha,
      headCommitSha,
      isStale: null,
      note: "indexed commit unavailable"
    };
  }

  const isStale = latestRun.commitSha !== headCommitSha;
  return {
    repoId,
    indexedCommitSha: latestRun.commitSha,
    headCommitSha,
    isStale,
    note: isStale ? "index commit differs from repo HEAD" : "index is up-to-date"
  };
}

/** Actionable staleness signal — lets a caller size the drift instead of just being told it exists (ISSUE-026). */
export type StaleWarning = {
  note: string;
  hint: string;
  /** Indexed commit (short sha) the line numbers/symbol ranges were built against. */
  lastIndexedCommit: string | null;
  /** Current repo HEAD (short sha). */
  headCommit: string | null;
  /** Commits HEAD is ahead of the indexed commit, or null when not computable. */
  commitsBehind: number | null;
  /** Working-tree files changed since the indexed commit (staged + unstaged + untracked). */
  dirtyCount: number;
};

function shortSha(sha: string | null): string | null {
  return sha ? sha.slice(0, 12) : null;
}

/**
 * Non-fatal staleness warning for read tools that degrade gracefully on a stale index.
 * Returns an actionable {@link StaleWarning} when the index is stale (or null otherwise /
 * when staleness can't be determined). `hint` is caller-specific guidance on what the
 * staleness affects. The extra git lookups (commits-behind, dirty count) run at most once
 * per response (only on the stale path), never per match.
 */
export function buildStaleWarning(
  repoId: string,
  store: GraphStore,
  hint: string
): StaleWarning | null {
  try {
    const staleness = getRepoStaleness(repoId, store);
    if (!staleness.isStale) {
      return null;
    }
    const repo = store.getRepository(repoId);
    let commitsBehind: number | null = null;
    let dirtyCount = 0;
    if (repo) {
      commitsBehind = countCommitsBehind(repo.repoPath, staleness.indexedCommitSha);
      try {
        dirtyCount = collectDirtyFiles(repo.repoPath).size;
      } catch {
        // non-git repo / git error — leave dirtyCount at 0
      }
    }
    return {
      note: `index is stale: ${staleness.note}`,
      hint,
      lastIndexedCommit: shortSha(staleness.indexedCommitSha),
      headCommit: shortSha(staleness.headCommitSha),
      commitsBehind,
      dirtyCount
    };
  } catch {
    // Can't determine staleness (e.g. non-git repo) — no warning.
  }
  return null;
}
