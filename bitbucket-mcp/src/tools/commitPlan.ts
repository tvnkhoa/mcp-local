/**
 * The pure half of commit_files: input validation, branch allowlist matching,
 * the create-commit form, and the shared-worktree reconcile script. Split from
 * commitFiles.ts to keep both under the 400-line cap; nothing here does I/O.
 */

import type { BitbucketConfig } from "../config/index.js";
import { PolicyViolationError } from "../middleware/errors.js";
import { validateRepoPath } from "./refs.js";

export const COMMIT_MAX_FILES = 50;
export const COMMIT_FILE_MAX_BYTES = 524_288;
export const COMMIT_TOTAL_MAX_BYTES = 1_048_576;

export type FileChange = { path: string; content?: string; delete?: true };

/** What commitForm and reconcileScript need from a plan. */
export type PlanFields = { branch: string; parent: string; message: string; author?: string; files: FileChange[] };

// --- validation and classification ---------------------------------------------

export function validateFiles(raw: readonly { path: string; content?: string; delete?: true }[]): FileChange[] {
  const seen = new Set<string>();
  let total = 0;
  return raw.map((f) => {
    const path = validateRepoPath(f.path);
    if (path === "" || seen.has(path)) {
      throw new PolicyViolationError("invalid_path", path === "" ? "A file path cannot be the repository root." : `"${path}" appears twice.`);
    }
    seen.add(path);
    if ((f.content === undefined) === (f.delete === undefined)) {
      throw new PolicyViolationError("invalid_file", `"${path}": give exactly one of content or delete:true.`);
    }
    if (f.delete) {
      return { path, delete: true };
    }
    const content = f.content ?? "";
    if (content.includes("\u0000")) {
      throw new PolicyViolationError("binary_content", `"${path}" contains a NUL byte; commit_files writes text only.`);
    }
    const bytes = Buffer.byteLength(content, "utf8");
    total += bytes;
    if (bytes > COMMIT_FILE_MAX_BYTES || total > COMMIT_TOTAL_MAX_BYTES) {
      throw new PolicyViolationError(
        "content_too_large",
        `"${path}" takes the commit past the cap (${String(COMMIT_FILE_MAX_BYTES)} bytes per file, ${String(COMMIT_TOTAL_MAX_BYTES)} total).`
      );
    }
    return { path, content };
  });
}

/** Shared patterns first: a branch on both lists still needs its reconcile script. */
export function classifyBranch(config: BitbucketConfig, repoSlug: string, branch: string): "isolated" | "shared" {
  if (config.commitSharedBranches.some((p) => patternMatches(p, repoSlug, branch))) {
    return "shared";
  }
  if (config.commitBranches.some((p) => patternMatches(p, repoSlug, branch))) {
    return "isolated";
  }
  throw new PolicyViolationError(
    "branch_not_allowed",
    `${repoSlug}:${branch} is on neither BITBUCKET_COMMIT_BRANCHES nor BITBUCKET_COMMIT_SHARED_BRANCHES. Commits go only to allowlisted branches.`
  );
}

/** `repo:branch-glob` (or a bare `branch-glob` for every repo); `*` spans `/`, `?` is one character. */
export function patternMatches(pattern: string, repoSlug: string, branch: string): boolean {
  const i = pattern.indexOf(":");
  const [repoGlob, branchGlob] = i < 0 ? ["*", pattern] : [pattern.slice(0, i), pattern.slice(i + 1)];
  return globToRegExp(repoGlob).test(repoSlug) && globToRegExp(branchGlob).test(branch);
}

function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

/**
 * The create-commit form. Each written file is a field named by its path with
 * a leading `/`; deletions are listed in `files` with no field of their own.
 */
export function commitForm(plan: PlanFields): URLSearchParams {
  const form = new URLSearchParams();
  form.set("message", plan.message);
  form.set("branch", plan.branch);
  form.set("parents", plan.parent);
  if (plan.author) {
    form.set("author", plan.author);
  }
  for (const f of plan.files) {
    if (f.delete) {
      form.append("files", `/${f.path}`);
    } else {
      form.append(`/${f.path}`, f.content ?? "");
    }
  }
  return form;
}

// --- reconcile ------------------------------------------------------------------

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Bring a shared worktree up to the new commit without touching anyone else's
 * work. `git merge --ff-only` cannot do it: it refuses when a path it updates
 * is dirty, even when the content is already identical. So: refuse unless the
 * local branch is still the parent and every committed path matches the new
 * commit byte for byte, then move the branch ref and reset only those index
 * entries. Other staged and unstaged changes are left exactly as they were.
 */
export function reconcileScript(plan: PlanFields, newSha: string): Record<string, unknown> {
  const lines = [
    "set -e",
    `git fetch origin ${q(plan.branch)}`,
    `git cat-file -e ${newSha}^{commit}`,
    `test "$(git symbolic-ref --short HEAD)" = ${q(plan.branch)} || { echo ${q(`not on ${plan.branch}`)}; exit 1; }`,
    `test "$(git rev-parse HEAD)" = ${plan.parent} || { echo "local HEAD is not the parent: commit or pull happened locally"; exit 1; }`
  ];
  for (const f of plan.files) {
    lines.push(
      f.delete
        ? `test ! -e ${q(f.path)} || { echo ${q(`${f.path} still exists locally`)}; exit 1; }`
        : `test "$(git hash-object -- ${q(f.path)})" = "$(git rev-parse ${newSha}:${q(f.path)})" || { echo ${q(`${f.path} differs from the commit`)}; exit 1; }`
    );
  }
  lines.push(`git update-ref ${q(`refs/heads/${plan.branch}`)} ${newSha} ${plan.parent}`);
  lines.push(`git reset -q ${newSha} -- ${plan.files.map((f) => q(f.path)).join(" ")}`);
  return {
    why: "The commit is on origin; the shared worktree still has these paths dirty and its branch at the parent. Run this in that worktree (bash). It stops without changing anything if any check fails.",
    script: lines.join("\n")
  };
}
