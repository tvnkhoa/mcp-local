import { execFileSync } from "node:child_process";

import type { GraphStore } from "./graphStore.js";

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
