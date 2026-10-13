/**
 * Pure helpers for the commit, compare and source tool groups: input
 * validation, path encoding, cursors, the compare spec, ref → SHA resolution
 * and the normalizers. Every validator throws before any HTTP call, so a bad
 * argument never costs an upstream request.
 */

import { encodePathSegment as enc } from "@mcp/shared";

import { BitbucketHttpError, PolicyViolationError } from "../middleware/errors.js";
import type { BitbucketClient, Cursor } from "../services/bitbucketClient.js";
import { get, str } from "./shared.js";

export const SHA_RE = /^[0-9a-f]{7,40}$/i;
export const REF_MAX = 256;
export const PATH_MAX = 1024;

// --- validation -------------------------------------------------------------

export function validateSha(raw: string): string {
  const sha = raw.trim();
  if (!SHA_RE.test(sha)) {
    throw new PolicyViolationError("invalid_sha", `"${raw}" is not a commit SHA (7–40 hex characters).`);
  }
  return sha.toLowerCase();
}

/**
 * A subset of `git check-ref-format`, enough to keep a ref safe to put in a URL
 * path and a compare spec: `..` especially, because the spec is `x..y`.
 */
export function validateRef(raw: string): string {
  const ref = raw.trim();
  const bad =
    ref.length === 0 ||
    ref.length > REF_MAX ||
    // eslint-disable-next-line no-control-regex
    /[\u0000- \u007f~^:?*[\\]/.test(ref) ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.includes("@{") ||
    ref.startsWith("-") ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.endsWith(".lock");
  if (bad) {
    throw new PolicyViolationError(
      "invalid_ref",
      `"${raw}" is not a valid branch, tag or SHA. Pass a name as list_branches shows it, or a commit SHA.`
    );
  }
  return ref;
}

/** A repo-relative path. `""` is the repository root. Returns it without slashes at either end. */
export function validateRepoPath(raw: string): string {
  const path = raw.trim().replace(/\/+$/, "");
  const segments = path === "" ? [] : path.split("/");
  const bad =
    path.length > PATH_MAX ||
    path.startsWith("/") ||
    path.includes("\\") ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(path) ||
    segments.some((s) => s === "" || s === "." || s === "..");
  if (bad) {
    throw new PolicyViolationError(
      "invalid_path",
      `"${raw}" is not a repository path. Use forward slashes, relative to the repo root, with no "." or ".." segments.`
    );
  }
  return path;
}

/** Encode each segment on its own: one `enc` over the whole path would turn `/` into `%2F`. */
export function encodeRepoPath(path: string): string {
  return path === "" ? "" : path.split("/").map(enc).join("/");
}

export function parseSince(raw: string): number {
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new PolicyViolationError("invalid_since", `"${raw}" is not a date. Use ISO 8601, e.g. 2026-10-01 or 2026-10-01T09:00:00Z.`);
  }
  return ms;
}

// --- cursors ----------------------------------------------------------------

/** Render the resume point of a `next` URL as an opaque cursor; null when there is no next page. */
export function cursorFromNext(next: unknown): string | null {
  if (typeof next !== "string" || next === "") {
    return null;
  }
  let params: URLSearchParams;
  try {
    params = new URL(next).searchParams;
  } catch {
    return null;
  }
  const page = params.get("page");
  if (!page) {
    return null;
  }
  const ctx = params.get("ctx");
  return formatCursor(ctx ? { page, ctx } : { page });
}

export function formatCursor(cursor: Cursor): string {
  const out = new URLSearchParams({ page: cursor.page });
  if (cursor.ctx) {
    out.set("ctx", cursor.ctx);
  }
  if (cursor.skip) {
    out.set("skip", String(cursor.skip));
  }
  return out.toString();
}

export function parseCursor(raw: string): Cursor {
  const params = new URLSearchParams(raw);
  const page = params.get("page");
  const ctx = params.get("ctx");
  const skipRaw = params.get("skip");
  const skip = skipRaw === null ? 0 : Number(skipRaw);
  const keysOk = [...params.keys()].every((k) => k === "page" || k === "ctx" || k === "skip");
  const bad =
    !keysOk ||
    !page ||
    page.length > 256 ||
    (ctx !== null && (ctx === "" || ctx.length > 256)) ||
    !Number.isInteger(skip) ||
    skip < 0 ||
    skip > 100;
  if (bad) {
    throw new PolicyViolationError(
      "invalid_cursor",
      "Not a cursor this server issued. Pass `nextCursor` from the previous response unchanged."
    );
  }
  return { page, ...(ctx ? { ctx } : {}), ...(skip ? { skip } : {}) };
}

// --- compare spec -----------------------------------------------------------

/**
 * Bitbucket's `x..y` is NOT git's. In git, `a..b` is "what b has that a does
 * not"; Bitbucket's diffstat/diff/merge-base `x..y` is "what x has since its
 * merge base with y" — the new side comes FIRST. Verified live on 2026-10-13 in
 * wec.aria: `diffstat/<develop>..<master>` listed develop's added files and
 * `diffstat/<master>..<develop>` was empty. Every compare goes through here.
 */
export function buildCompareSpec(headSha: string, baseSha: string): string {
  return `${headSha}..${baseSha}`;
}

// --- ref resolution ---------------------------------------------------------

export type ResolvedRef = { ref: string; sha: string; kind: "sha" | "branch" | "tag" | "main" };

/**
 * Resolve a branch, tag or SHA to a full commit SHA before any path endpoint.
 * A branch name may contain `/`, which a path endpoint cannot tell apart from the
 * file path, and the bare `/src/{branch}/…` form answers 403 for API tokens.
 * Omitting `ref` means the repository's main branch.
 */
export async function resolveToSha(
  client: BitbucketClient,
  repoSlug: string,
  rawRef: string | undefined
): Promise<ResolvedRef> {
  if (rawRef === undefined) {
    const repo = await client.getRepository(repoSlug);
    const main = str(get(repo, "mainbranch", "name"));
    if (!main) {
      throw new PolicyViolationError("ref_not_found", `${repoSlug} has no main branch; pass \`ref\`.`);
    }
    const branch = await client.getBranch(repoSlug, main);
    return { ref: main, sha: requireHash(get(branch, "target", "hash"), main), kind: "main" };
  }
  const ref = validateRef(rawRef);
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    return { ref, sha: ref.toLowerCase(), kind: "sha" };
  }
  const branch = await orNotFound(client.getBranch(repoSlug, ref));
  if (branch) {
    return { ref, sha: requireHash(get(branch, "target", "hash"), ref), kind: "branch" };
  }
  const tag = await orNotFound(client.getTag(repoSlug, ref));
  if (tag) {
    return { ref, sha: requireHash(get(tag, "target", "hash"), ref), kind: "tag" };
  }
  if (SHA_RE.test(ref)) {
    // An abbreviated SHA: the commit endpoint expands it.
    const commit = await orNotFound(client.getCommit(repoSlug, ref, "hash"));
    if (commit) {
      return { ref, sha: requireHash(commit.hash, ref), kind: "sha" };
    }
  }
  throw new PolicyViolationError(
    "ref_not_found",
    `"${ref}" is not a branch, tag or commit in ${repoSlug}. list_branches shows the branch names.`
  );
}

async function orNotFound<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (error) {
    if (error instanceof BitbucketHttpError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

function requireHash(v: unknown, ref: string): string {
  const hash = str(v);
  if (!hash) {
    throw new PolicyViolationError("ref_not_found", `"${ref}" did not resolve to a commit.`);
  }
  return hash;
}

// --- normalizers ------------------------------------------------------------

/** First line of a commit message. */
export function subject(message: unknown): string | null {
  const m = str(message);
  return m === null ? null : (m.split("\n", 1)[0] ?? "").trim();
}

export function normalizeCommit(c: Record<string, unknown>): Record<string, unknown> {
  const sha = str(c.hash);
  const parents = Array.isArray(c.parents) ? c.parents.map((p) => str(get(p, "hash"))) : [];
  return {
    sha,
    shortSha: sha ? sha.slice(0, 12) : null,
    parents,
    author: str(get(c, "author", "raw")),
    authorName: str(get(c, "author", "user", "display_name")),
    date: str(c.date),
    subject: subject(c.message)
  };
}

export function normalizeDiffstat(d: Record<string, unknown>): Record<string, unknown> {
  const newPath = str(get(d, "new", "path"));
  const oldPath = str(get(d, "old", "path"));
  return {
    path: newPath ?? oldPath,
    oldPath: oldPath !== null && oldPath !== newPath ? oldPath : null,
    status: str(d.status),
    linesAdded: typeof d.lines_added === "number" ? d.lines_added : null,
    linesRemoved: typeof d.lines_removed === "number" ? d.lines_removed : null
  };
}

/** Commit fields every commit listing asks for — trims a ~2 KB-per-commit payload to ~300 B. */
export const COMMIT_FIELDS =
  "values.hash,values.date,values.message,values.author.raw,values.author.user.display_name,values.parents.hash,next,pagelen";
