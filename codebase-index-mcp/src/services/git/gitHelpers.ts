import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { GraphStore } from "../../repositories/graphStore.js";

/**
 * MCP-ISSUE-060: bounded, because this is the only unbounded synchronous wait on the read path.
 *
 * `execFileSync` blocks the event loop for as long as the child runs, and every read tool that takes
 * a `repoId` reaches here — `search_symbols` costs one spawn, `find_impact_files` up to five. With no
 * `timeout`, a hung `git` hangs the whole server, and there is no in-process way to interrupt it.
 *
 * `maxBuffer` is a correctness fix, not a tuning knob. Node's default is 1 MB; `git status --porcelain`
 * on a large dirty repo exceeds it and throws ENOBUFS, which the callers below swallow — so
 * `health_check` reported "non-git repo or unable to read working tree status" for a repo that was
 * merely dirty.
 */
/**
 * `timeoutMs` overrides the 5s default for the rare call that legitimately walks history. A whole-log
 * walk on this workspace already takes ~3.4s, which is close enough to the default that adding
 * `execFileSync` overhead tipped `lastCommitTimeByFile` into a silent timeout — it returned an empty
 * map that read as "this repo has no history". Any caller that raises it owes the user a note saying
 * what an empty result means.
 */
export function runGit(repoPath: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): string {
  return execFileSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    windowsHide: true
  }).trim();
}

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

function splitGitLines(text: string): string[] {
  if (!text) return [];
  return text.split(/\r?\n/).map((x) => x.trim()).filter((x) => x.length > 0);
}

/**
 * `[]` on failure. Correct for callers that cannot distinguish, and wrong for callers that must —
 * see `runGitLinesOrNull`.
 */
export function runGitLines(repoPath: string, args: string[]): string[] {
  try {
    return splitGitLines(runGit(repoPath, args));
  } catch {
    return [];
  }
}

/**
 * MCP-ISSUE-060: `null` when git itself failed, `[]` when it ran and reported nothing.
 *
 * `runGitLines` conflates the two, and `detect_changes` is built on it: a typo'd or unfetched
 * `baseRef` made `git diff base..HEAD` fail, the catch returned `[]`, and the release-gate tool
 * answered `changedFileCount: 0, highRiskCount: 0` with `note: "using git range diff"` — asserting
 * that the diff had succeeded and found nothing.
 *
 * The `[]`-on-failure behaviour is kept where it is genuinely right (a non-git directory, an unborn
 * HEAD on a fresh repo), so this is a second function rather than a change to the first.
 */
export function runGitLinesOrNull(repoPath: string, args: string[]): string[] | null {
  try {
    return splitGitLines(runGit(repoPath, args));
  } catch {
    return null;
  }
}

export function resolveHeadCommitSha(repoPath: string): string | null {
  const fromFiles = readHeadShaFromFiles(repoPath);
  if (fromFiles) return fromFiles;
  try {
    return runGit(repoPath, ["rev-parse", "HEAD"]).trim();
  } catch {
    return null;
  }
}

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * HEAD's commit read from the git directory's files, with no process spawn (release I1b), or null
 * when that is not certain — the caller then asks `git rev-parse HEAD` as before.
 *
 * Why: every read tool checks staleness, and `execFileSync("git", …)` holds the event loop for the
 * whole spawn. With the R1 refresh's parse workers busy, one `rev-parse` held the server thread for
 * up to 1.9 s (CPU profile of test:freshness-worker). A file read is microseconds.
 *
 * Handles a `.git` directory or a `.git` file (`gitdir:` — worktrees, submodules) found at or above
 * `repoPath`, a detached HEAD, a symbolic HEAD resolved through a loose ref (in the git dir, then its
 * `commondir`) or `packed-refs`. Anything else — a ref that is itself symbolic, reftable storage, an
 * unborn branch — returns null.
 */
export function readHeadShaFromFiles(repoPath: string): string | null {
  try {
    let dir = path.resolve(repoPath);
    let gitDir: string | null = null;
    for (;;) {
      const dotGit = path.join(dir, ".git");
      const st = fs.statSync(dotGit, { throwIfNoEntry: false });
      if (st?.isDirectory()) {
        gitDir = dotGit;
        break;
      }
      if (st?.isFile()) {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, "utf8"));
        if (!m) return null;
        gitDir = path.resolve(dir, m[1]);
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (SHA_RE.test(head)) return head;
    const ref = /^ref:\s*(refs\/\S+)$/.exec(head)?.[1];
    if (!ref) return null;
    let commonDir = gitDir;
    try {
      commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
    } catch {
      // Not a linked worktree: refs live in the git dir itself.
    }
    for (const base of commonDir === gitDir ? [gitDir] : [gitDir, commonDir]) {
      const loose = path.join(base, ...ref.split("/"));
      if (!fs.existsSync(loose)) continue;
      const value = fs.readFileSync(loose, "utf8").trim();
      return SHA_RE.test(value) ? value : null; // a symbolic ref chain: let git resolve it
    }
    const packed = fs.readFileSync(path.join(commonDir, "packed-refs"), "utf8");
    for (const line of packed.split(/\r?\n/)) {
      if (line.startsWith("#") || line.startsWith("^")) continue;
      const space = line.indexOf(" ");
      if (space > 0 && line.slice(space + 1) === ref) {
        const sha = line.slice(0, space);
        return SHA_RE.test(sha) ? sha : null;
      }
    }
    return null;
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

function runGitStatusPorcelain(repoPath: string): string[] | null {
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
 * Parse `git status --porcelain=v2 --branch -z --untracked-files=all`: HEAD's sha plus every staged,
 * unstaged, unmerged and untracked path (both sides of a rename). Pure, so it is unit-tested.
 */
export function parseStatusPorcelainV2(out: string): { head: string | null; dirty: string[] } {
  let head: string | null = null;
  const dirty: string[] = [];
  const entries = out.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] ?? "";
    if (e.startsWith("# branch.oid ")) {
      const oid = e.slice("# branch.oid ".length).trim();
      head = /^[0-9a-f]{7,64}$/.test(oid) ? oid : null; // "(initial)" before the first commit
      continue;
    }
    // Fields before the path: 1 → 8, 2 → 9 (+ orig path as the next entry), u → 10, ? → 1.
    const before = e[0] === "1" ? 8 : e[0] === "2" ? 9 : e[0] === "u" ? 10 : e[0] === "?" ? 1 : -1;
    if (before < 0) continue;
    const parts = e.split(" ");
    const p = parts.slice(before).join(" ");
    if (p) dirty.push(p.replace(/\\/g, "/"));
    if (e[0] === "2") {
      const orig = entries[++i];
      if (orig) dirty.push(orig.replace(/\\/g, "/"));
    }
  }
  return { head, dirty: [...new Set(dirty)] };
}

/**
 * HEAD plus the working-tree delta in ONE git spawn. The R1 freshness gate runs this before every
 * read query; the four-spawn version (rev-parse + collectDirtyFiles) cost ~330 ms on wec.aria on
 * Windows, this ~110 ms.
 */
const WORKING_TREE_STATUS_ARGS = ["-c", "core.quotePath=false", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"];

export function readWorkingTreeState(repoPath: string): { head: string | null; dirty: string[] } {
  return parseStatusPorcelainV2(runGit(repoPath, WORKING_TREE_STATUS_ARGS));
}

/**
 * The same read without blocking the event loop (release I1b). The gate runs it before every read
 * query, and `git status` on wec.be takes ~300 ms: synchronously, that was a 300 ms stall of every
 * other call in flight, on every query. Same bounds as {@link runGit}; rejects where it throws.
 */
export function readWorkingTreeStateAsync(repoPath: string): Promise<{ head: string | null; dirty: string[] }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      WORKING_TREE_STATUS_ARGS,
      { cwd: repoPath, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER_BYTES, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(parseStatusPorcelainV2(stdout.trim()));
      }
    );
  });
}

/**
 * Every file git would show for this directory — tracked, plus untracked that no .gitignore excludes —
 * as POSIX paths relative to `repoPath` (which may be a subdirectory of the repo). `null` outside git,
 * so the caller falls back to the plain walk.
 */
export function listGitVisibleFiles(repoPath: string): Set<string> | null {
  try {
    const out = execFileSync("git", ["-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: repoPath,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true
    });
    return new Set(out.split("\0").filter(Boolean).map((p) => p.replace(/\\/g, "/")));
  } catch {
    return null;
  }
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
