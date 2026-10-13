/**
 * `compare_refs` — what a head ref has that a base ref does not: merge base,
 * ahead/behind counts, per-file changes and optionally the diff. Read-only.
 *
 * Every spec is built by `buildCompareSpec`, because Bitbucket's `x..y` puts
 * the new side first — the reverse of git (see its comment).
 */

import { ok } from "@mcp/core";
import { annotations, defineTool, schema } from "@mcp/sdk";
import type { AnyToolDefinition } from "@mcp/sdk";
import { z } from "zod";

import type { BitbucketConfig } from "../config/index.js";
import type { BitbucketClient } from "../services/bitbucketClient.js";
import { BitbucketHttpError, PolicyViolationError } from "../middleware/errors.js";
import { DIFFSTAT_DEFAULT_FILES, DIFFSTAT_MAX_FILES, DIFFSTAT_SCAN_MAX, collectDiffstat, type DiffstatFilter } from "./commits.js";
import { buildCompareSpec, cursorFromNext, encodeRepoPath, parseCursor, resolveToSha, validateRepoPath } from "./refs.js";
import { profileArg, profileProp, repoSlugArg, repoSlugProp, resolveRepo, str } from "./shared.js";

/** Commits counted per direction before ahead/behind is reported as "≥N". */
export const AHEAD_BEHIND_CAP = 500;
export const DIFF_DEFAULT_BYTES = 262_144;
export const DIFF_MAX_BYTES = 1_048_576;
/**
 * Budget for the `path=` parameters of a directory-filtered diff. Bitbucket
 * rejects a request line over 4094 bytes (400, verified 2026-10-13 with 81
 * paths), and the URL already carries two SHAs; files past the budget are left
 * out and the diff is reported truncated.
 */
export const DIFF_PATHS_MAX_CHARS = 3000;

export function buildCompareTools(config: BitbucketConfig, client: BitbucketClient): readonly AnyToolDefinition[] {
  const compareRefsTool = defineTool({
    name: "compare_refs",
    description:
      "Compare two refs (branch, tag or SHA) like `git diff base...head` plus `git rev-list --left-right --count`: merge base, how many commits head is ahead of / behind base (capped at " +
      `${String(AHEAD_BEHIND_CAP)}, shown as "≥${String(AHEAD_BEHIND_CAP)}"), and the files head changed since the merge base. statOnly:false adds the unified diff, cut at maxDiffBytes (default 256 KiB, max 1 MiB; see diffTruncated). ` +
      `\`path\` (a file or a directory) limits files, totals and the diff to it, like \`git diff base...head -- path\`; ahead/behind stay branch-wide. A directory is filtered over at most ${String(DIFFSTAT_SCAN_MAX)} changed files.`,
    input: z
      .object({
        repoSlug: repoSlugArg,
        base: z.string().min(1).max(256),
        head: z.string().min(1).max(256),
        statOnly: z.boolean().optional(),
        path: z.string().min(1).max(1024).optional(),
        maxFiles: z.number().int().positive().max(DIFFSTAT_MAX_FILES).optional(),
        maxDiffBytes: z.number().int().positive().max(DIFF_MAX_BYTES).optional(),
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object(
      {
        repoSlug: repoSlugProp,
        base: schema.string("The ref compared against, e.g. master or origin's develop"),
        head: schema.string("The ref whose changes are listed, e.g. a feature branch"),
        statOnly: schema.boolean("Default true: files and counts only, no diff text"),
        path: schema.string("Only this file or directory (repo-relative)"),
        maxFiles: schema.integer(`File rows to return (default ${String(DIFFSTAT_DEFAULT_FILES)}, max ${String(DIFFSTAT_MAX_FILES)})`, { minimum: 1, maximum: DIFFSTAT_MAX_FILES }),
        maxDiffBytes: schema.integer("Diff bytes to return when statOnly is false (default 262144, max 1048576)", { minimum: 1, maximum: DIFF_MAX_BYTES }),
        profile: profileProp
      },
      { required: ["base", "head"] }
    ),
    annotations: annotations.readRemote(),
    handler: async (args) => {
      const repoSlug = resolveRepo(config, args.repoSlug);
      const [base, head] = await Promise.all([
        resolveToSha(client, repoSlug, args.base),
        resolveToSha(client, repoSlug, args.head)
      ]);
      const spec = buildCompareSpec(head.sha, base.sha);
      const filter = args.path === undefined ? {} : await pathFilter(client, repoSlug, args.path, head.sha, base.sha);

      const [mergeBase, stat, ahead, behind] = await Promise.all([
        client.getMergeBase(repoSlug, spec),
        collectDiffstat(client, repoSlug, spec, args.maxFiles ?? DIFFSTAT_DEFAULT_FILES, filter),
        countCapped(client, repoSlug, head.sha, base.sha),
        countCapped(client, repoSlug, base.sha, head.sha)
      ]);

      let diff: Record<string, unknown> = {};
      if (args.statOnly === false) {
        const maxBytes = args.maxDiffBytes ?? DIFF_DEFAULT_BYTES;
        // A directory filter names its matched files; with none matched there is no diff.
        const files = (stat.files as { path: string | null }[]).map((f) => f.path).filter((x): x is string => x !== null);
        const paths = filter.file ? [filter.file] : filter.dir ? withinBudget(files) : undefined;
        const d =
          paths && paths.length === 0
            ? { text: "", truncated: false, bytesRead: 0 }
            : await client.getDiffBounded(repoSlug, spec, maxBytes, paths);
        const partialDir = filter.dir !== undefined && ((paths?.length ?? 0) < files.length || stat.filesTruncated === true);
        diff = { diff: d.text, diffTruncated: d.truncated || partialDir, diffBytes: d.bytesRead };
      }

      return ok({
        workspace: config.workspace,
        repoSlug,
        base: { ref: base.ref, sha: base.sha },
        head: { ref: head.ref, sha: head.sha },
        semantics: "three-dot: changes on head since its merge base with base",
        path: filter.file ?? filter.dir,
        pathKind: filter.file ? "file" : filter.dir ? "directory" : undefined,
        mergeBase: str(mergeBase.hash),
        ahead,
        behind,
        ...stat,
        ...diff
      });
    }
  });

  return [compareRefsTool];
}

/**
 * Whether `path` is a file or a directory, from its metadata at head (or at
 * base, for a path head deleted). Upstream filters files exactly and matches
 * directories against nothing, so the two take different routes.
 */
async function pathFilter(
  client: BitbucketClient,
  repoSlug: string,
  raw: string,
  headSha: string,
  baseSha: string
): Promise<DiffstatFilter> {
  const path = validateRepoPath(raw);
  if (path === "") {
    throw new PolicyViolationError("invalid_path", "Omit `path` to compare the whole repository.");
  }
  for (const sha of [headSha, baseSha]) {
    try {
      const meta = await client.getSrcMeta(repoSlug, sha, encodeRepoPath(path));
      return str(meta.type) === "commit_directory" ? { dir: path } : { file: path };
    } catch (error) {
      if (!(error instanceof BitbucketHttpError && error.status === 404)) {
        throw error;
      }
    }
  }
  throw new PolicyViolationError("path_not_found", `"${path}" exists at neither side of the comparison.`);
}

/** The leading paths whose encoded `&path=…` parameters fit DIFF_PATHS_MAX_CHARS. */
function withinBudget(paths: readonly string[]): string[] {
  const out: string[] = [];
  let used = 0;
  for (const p of paths) {
    used += new URLSearchParams({ path: p }).toString().length + 1;
    if (used > DIFF_PATHS_MAX_CHARS) {
      break;
    }
    out.push(p);
  }
  return out;
}

/** Count commits reachable from `include` but not `exclude`, stopping at AHEAD_BEHIND_CAP. */
export async function countCapped(
  client: BitbucketClient,
  repoSlug: string,
  include: string,
  exclude: string
): Promise<{ count: number; capped: boolean; display: string }> {
  let count = 0;
  let cursor;
  for (;;) {
    const res = await client.listCommits(repoSlug, {
      include: [include],
      exclude: [exclude],
      cursor,
      pagelen: 100,
      fields: "values.hash,next"
    });
    count += (res.values ?? []).length;
    const next = cursorFromNext(res.next);
    if (count >= AHEAD_BEHIND_CAP && next) {
      return { count: AHEAD_BEHIND_CAP, capped: true, display: `≥${String(AHEAD_BEHIND_CAP)}` };
    }
    if (!next || (res.values ?? []).length === 0) {
      return { count, capped: false, display: String(count) };
    }
    cursor = parseCursor(next);
  }
}
