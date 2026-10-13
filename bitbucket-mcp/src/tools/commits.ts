/**
 * The commit tool group — read-only: list commits (by range, path, date,
 * author), one commit with its per-file changes, and the build statuses
 * reported against a commit.
 *
 * Built for agents that work from a SHA-keyed history but have no clone, or
 * whose clone is a shared worktree they must not disturb. When the repo is
 * checked out locally, local git is cheaper and exact; these tools say what
 * the remote has.
 */

import { ok } from "@mcp/core";
import { annotations, defineTool, schema } from "@mcp/sdk";
import type { AnyToolDefinition } from "@mcp/sdk";
import { z } from "zod";

import type { BitbucketConfig } from "../config/index.js";
import type { BitbucketClient, Cursor, Paginated } from "../services/bitbucketClient.js";
import {
  COMMIT_FIELDS,
  normalizeCommit,
  normalizeDiffstat,
  parseCursor,
  parseSince,
  cursorFromNext,
  formatCursor,
  validateRef,
  validateRepoPath,
  validateSha
} from "./refs.js";
import {
  get,
  num,
  pageArg,
  pageInfo,
  pageProp,
  pagelenArg,
  pagelenProp,
  profileArg,
  profileProp,
  repoSlugArg,
  repoSlugProp,
  resolveRepo,
  str
} from "./shared.js";

/** Commits examined per call when `since`/`author` filter client-side (10 upstream pages). */
export const COMMITS_SCAN_MAX = 1000;
export const COMMITS_DEFAULT_PAGELEN = 30;
/** Per-file rows a single commit or compare returns. */
export const DIFFSTAT_DEFAULT_FILES = 200;
export const DIFFSTAT_MAX_FILES = 500;
export const REFS_MAX_ITEMS = 10;

const refArray = z.array(z.string().min(1).max(256)).min(1).max(REFS_MAX_ITEMS).optional();
const cursorArg = z.string().min(1).max(600).optional();
const cursorProp = schema.string("nextCursor from the previous response, passed back unchanged");

export function buildCommitTools(config: BitbucketConfig, client: BitbucketClient): readonly AnyToolDefinition[] {
  const listCommitsTool = defineTool({
    name: "list_commits",
    description:
      "List commits on the remote, newest first: reachable from `include` (default: every branch) and not from `exclude`, optionally only those touching `path`. Like `git log exclude..include -- path`. `since` and `author` are filtered client-side over at most " +
      `${String(COMMITS_SCAN_MAX)} commits per call (see scanned/scanCapReached; continue with nextCursor); \`since\` compares the author date and is approximate across merges. Pages by cursor, not page number. Prefer local git when the repo is checked out.`,
    input: z
      .object({
        repoSlug: repoSlugArg,
        include: refArray,
        exclude: refArray,
        path: z.string().min(1).max(1024).optional(),
        since: z.string().min(1).max(64).optional(),
        author: z.string().min(1).max(256).optional(),
        cursor: cursorArg,
        pagelen: pagelenArg,
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object({
      repoSlug: repoSlugProp,
      include: schema.array(schema.string(), "Branches, tags or SHAs to start from (max 10)", { minItems: 1, maxItems: REFS_MAX_ITEMS }),
      exclude: schema.array(schema.string(), "Branches, tags or SHAs whose history is excluded (max 10)", { minItems: 1, maxItems: REFS_MAX_ITEMS }),
      path: schema.string("Only commits touching this repo-relative file or directory"),
      since: schema.string("Only commits with an author date at or after this ISO date/time"),
      author: schema.string("Case-insensitive substring of the author name or email"),
      cursor: cursorProp,
      pagelen: schema.integer(`Commits to return (default ${String(COMMITS_DEFAULT_PAGELEN)}, max 100)`, { minimum: 1, maximum: 100 }),
      profile: profileProp
    }),
    annotations: annotations.readRemote(),
    handler: async (args) => {
      const repoSlug = resolveRepo(config, args.repoSlug);
      const include = args.include?.map(validateRef);
      const exclude = args.exclude?.map(validateRef);
      const path = args.path === undefined ? undefined : validateRepoPath(args.path);
      const sinceMs = args.since === undefined ? undefined : parseSince(args.since);
      const author = args.author?.toLowerCase();
      let cursor = args.cursor === undefined ? undefined : parseCursor(args.cursor);
      const want = args.pagelen ?? COMMITS_DEFAULT_PAGELEN;

      const filters: Record<string, unknown> = {};
      for (const [k, v] of Object.entries({ include, exclude, path, since: args.since, author: args.author })) {
        if (v !== undefined) {
          filters[k] = v;
        }
      }

      // No client-side filter: one upstream page, returned as is.
      if (sinceMs === undefined && author === undefined) {
        const res = await client.listCommits(repoSlug, { include, exclude, path, cursor, pagelen: want, fields: COMMIT_FIELDS });
        return ok({
          workspace: config.workspace,
          repoSlug,
          filters: Object.keys(filters).length ? filters : undefined,
          commits: (res.values ?? []).map(normalizeCommit),
          nextCursor: cursorFromNext(res.next)
        });
      }

      // Client-side filter: scan 100-commit pages until `want` matches, the
      // history passes `since`, or the scan cap. Stop on a page that is
      // *entirely* older than `since`, not on the first older commit — merged
      // branches interleave author dates. When `want` is reached mid-page the
      // cursor resumes on that same page with `skip`, so nothing is dropped.
      let current: Cursor = cursor ?? { page: "1" };
      const matches: Record<string, unknown>[] = [];
      let scanned = 0;
      let nextCursor: string | null = null;
      let scanCapReached = false;
      for (;;) {
        const res: Paginated = await client.listCommits(repoSlug, {
          include, exclude, path, cursor: current, pagelen: 100, fields: COMMIT_FIELDS
        });
        const page = res.values ?? [];
        let newestOnPage = -Infinity;
        let stoppedAt = -1;
        for (let i = current.skip ?? 0; i < page.length; i++) {
          const c = page[i] ?? {};
          scanned += 1;
          const t = Date.parse(str(c.date) ?? "");
          newestOnPage = Math.max(newestOnPage, Number.isNaN(t) ? -Infinity : t);
          if (sinceMs !== undefined && !(t >= sinceMs)) {
            continue;
          }
          if (author !== undefined && !authorMatches(c, author)) {
            continue;
          }
          matches.push(normalizeCommit(c));
          if (matches.length >= want) {
            stoppedAt = i;
            break;
          }
        }
        const upstreamNext = cursorFromNext(res.next);
        if (stoppedAt >= 0) {
          nextCursor =
            stoppedAt + 1 < page.length
              ? formatCursor({ page: current.page, ctx: current.ctx, skip: stoppedAt + 1 })
              : upstreamNext;
          break;
        }
        if (!upstreamNext || page.length === 0 || (sinceMs !== undefined && newestOnPage < sinceMs)) {
          break;
        }
        if (scanned >= COMMITS_SCAN_MAX) {
          nextCursor = upstreamNext;
          scanCapReached = true;
          break;
        }
        current = parseCursor(upstreamNext);
      }

      return ok({
        workspace: config.workspace,
        repoSlug,
        filters,
        commits: matches,
        scanned,
        scanCap: COMMITS_SCAN_MAX,
        scanCapReached,
        nextCursor
      });
    }
  });

  const getCommitTool = defineTool({
    name: "get_commit",
    description:
      "One commit: full message, parents, author, date, and its per-file changes against its first parent (path, status, lines added/removed), like `git show --stat`. Files are capped by maxFiles (default " +
      `${String(DIFFSTAT_DEFAULT_FILES)}, max ${String(DIFFSTAT_MAX_FILES)}); filesTotal and filesTruncated say when that cut.`,
    input: z
      .object({
        repoSlug: repoSlugArg,
        sha: z.string().min(7).max(40),
        maxFiles: z.number().int().positive().max(DIFFSTAT_MAX_FILES).optional(),
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object(
      {
        repoSlug: repoSlugProp,
        sha: schema.string("Commit SHA (7–40 hex)"),
        maxFiles: schema.integer(`File rows to return (default ${String(DIFFSTAT_DEFAULT_FILES)}, max ${String(DIFFSTAT_MAX_FILES)})`, { minimum: 1, maximum: DIFFSTAT_MAX_FILES }),
        profile: profileProp
      },
      { required: ["sha"] }
    ),
    annotations: annotations.readRemote(),
    handler: async (args) => {
      const repoSlug = resolveRepo(config, args.repoSlug);
      const sha = validateSha(args.sha);
      const commit = await client.getCommit(repoSlug, sha, "hash,date,message,author.raw,author.user.display_name,parents.hash");
      const fullSha = str(commit.hash) ?? sha;
      const stat = await collectDiffstat(client, repoSlug, fullSha, args.maxFiles ?? DIFFSTAT_DEFAULT_FILES);
      const base = normalizeCommit(commit);
      return ok({
        workspace: config.workspace,
        repoSlug,
        commit: { ...base, subject: undefined, message: str(commit.message) },
        ...stat
      });
    }
  });

  const getCommitStatusesTool = defineTool({
    name: "get_commit_statuses",
    description:
      "Build statuses reported against one commit by any CI (Bitbucket Pipelines, Azure DevOps, …): key, name, state (SUCCESSFUL/FAILED/INPROGRESS/STOPPED), url. Answers \"is this exact SHA green?\" before a push or merge.",
    input: z
      .object({ repoSlug: repoSlugArg, sha: z.string().min(7).max(40), page: pageArg, pagelen: pagelenArg, profile: profileArg })
      .strict(),
    inputSchema: schema.object(
      { repoSlug: repoSlugProp, sha: schema.string("Commit SHA (7–40 hex)"), page: pageProp, pagelen: pagelenProp, profile: profileProp },
      { required: ["sha"] }
    ),
    annotations: annotations.readRemote(),
    handler: async (args) => {
      const repoSlug = resolveRepo(config, args.repoSlug);
      const sha = validateSha(args.sha);
      const res = await client.listCommitStatuses(repoSlug, sha, { page: args.page, pagelen: args.pagelen });
      return ok({
        workspace: config.workspace,
        repoSlug,
        sha,
        ...pageInfo(res),
        statuses: (res.values ?? []).map((s) => ({
          key: str(s.key),
          name: str(s.name),
          state: str(s.state),
          url: str(s.url),
          description: str(s.description),
          refname: str(s.refname),
          createdOn: str(s.created_on),
          updatedOn: str(s.updated_on)
        }))
      });
    }
  });

  return [listCommitsTool, getCommitTool, getCommitStatusesTool];
}

function authorMatches(c: Record<string, unknown>, needle: string): boolean {
  return [get(c, "author", "raw"), get(c, "author", "user", "display_name")].some(
    (v) => typeof v === "string" && v.toLowerCase().includes(needle)
  );
}

/**
 * Page a diffstat (`spec` = one SHA, or a compare spec) up to `maxFiles` rows.
 * Totals cover the returned rows; `filesTotal` is upstream's count of all files.
 */
export async function collectDiffstat(
  client: BitbucketClient,
  repoSlug: string,
  spec: string,
  maxFiles: number
): Promise<Record<string, unknown>> {
  const files: Record<string, unknown>[] = [];
  let filesTotal: number | null = null;
  let page = 1;
  for (;;) {
    const res = await client.getDiffstat(repoSlug, spec, { page, pagelen: 100 });
    filesTotal ??= num(res.size);
    for (const d of res.values ?? []) {
      if (files.length < maxFiles) {
        files.push(normalizeDiffstat(d));
      }
    }
    if (!res.next || files.length >= maxFiles || (res.values ?? []).length === 0) {
      break;
    }
    page += 1;
  }
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += typeof f.linesAdded === "number" ? f.linesAdded : 0;
    removed += typeof f.linesRemoved === "number" ? f.linesRemoved : 0;
  }
  const total = filesTotal ?? files.length;
  return {
    files,
    totals: { files: files.length, linesAdded: added, linesRemoved: removed },
    filesTotal: total,
    filesTruncated: total > files.length
  };
}
