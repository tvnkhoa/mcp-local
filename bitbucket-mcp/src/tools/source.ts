/**
 * The source tool group — read-only: a file or directory as it was at a ref,
 * the commits that changed a file, and workspace code search. These let an
 * agent read another repository (e.g. a knowledge base) without cloning it.
 */

import { ok } from "@mcp/core";
import type { PlatformError, Result } from "@mcp/core";
import { annotations, defineTool, schema } from "@mcp/sdk";
import type { AnyToolDefinition } from "@mcp/sdk";
import { z } from "zod";

import type { BitbucketConfig } from "../config/index.js";
import { BitbucketHttpError, PolicyViolationError } from "../middleware/errors.js";
import type { BitbucketClient } from "../services/bitbucketClient.js";
import { cursorFromNext, encodeRepoPath, parseCursor, resolveToSha, subject, validateRepoPath } from "./refs.js";
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

export const FILE_DEFAULT_BYTES = 262_144;
export const FILE_MAX_BYTES = 1_048_576;
export const FILE_HISTORY_MAX_PAGELEN = 50;
/** Matching lines kept per search hit; a hit on a minified file can carry hundreds. */
export const SEARCH_LINES_PER_FILE = 20;
const SLUG_RE = /^[A-Za-z0-9._-]{1,128}$/;
/** Bytes sniffed for a NUL when the metadata does not already say "binary". */
const BINARY_SNIFF_BYTES = 8192;

const refArg = z.string().min(1).max(256).optional();
const refProp = schema.string("Branch, tag or commit SHA (default: the repository's main branch)");
const cursorArg = z.string().min(1).max(600).optional();
const cursorProp = schema.string("nextCursor from the previous response, passed back unchanged");

export function buildSourceTools(config: BitbucketConfig, client: BitbucketClient): readonly AnyToolDefinition[] {
  const getFileAtRefTool = defineTool({
    name: "get_file_at_ref",
    description:
      "Read a file, or list a directory, as it was at a branch, tag or SHA — like `git show <ref>:<path>` — in any repository of the workspace, without a clone. Text is cut at maxBytes (default 256 KiB, max 1 MiB; see truncated). Binary files and submodules return metadata only. path \"\" lists the repo root. The ref is resolved to a SHA first and echoed as resolvedSha.",
    input: z
      .object({
        repoSlug: repoSlugArg,
        ref: refArg,
        path: z.string().max(1024),
        maxBytes: z.number().int().positive().max(FILE_MAX_BYTES).optional(),
        cursor: cursorArg,
        pagelen: pagelenArg,
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object(
      {
        repoSlug: repoSlugProp,
        ref: refProp,
        path: schema.string("Repo-relative path with forward slashes; \"\" for the root"),
        maxBytes: schema.integer("File bytes to return (default 262144, max 1048576)", { minimum: 1, maximum: FILE_MAX_BYTES }),
        cursor: cursorProp,
        pagelen: pagelenProp,
        profile: profileProp
      },
      { required: ["path"] }
    ),
    annotations: annotations.readRemote(),
    // Explicit return type: a directory and a file are different shapes.
    handler: async (args): Promise<Result<Record<string, unknown>, PlatformError>> => {
      const repoSlug = resolveRepo(config, args.repoSlug);
      const path = validateRepoPath(args.path);
      const cursor = args.cursor === undefined ? undefined : parseCursor(args.cursor);
      const ref = await resolveToSha(client, repoSlug, args.ref);
      const encoded = encodeRepoPath(path);
      const head = { workspace: config.workspace, repoSlug, ref: ref.ref, resolvedSha: ref.sha, path };

      const meta = await pathOrNotFound(client.getSrcMeta(repoSlug, ref.sha, encoded), path, ref.ref);
      if (str(meta.type) === "commit_directory") {
        const res = await client.listSrcDir(repoSlug, ref.sha, encoded, { cursor, pagelen: args.pagelen });
        return ok({
          ...head,
          kind: "directory",
          entries: (res.values ?? []).map((e) => ({
            path: str(e.path),
            type: str(e.type) === "commit_directory" ? "directory" : "file",
            size: num(e.size)
          })),
          nextCursor: cursorFromNext(res.next)
        });
      }

      const attributes = Array.isArray(meta.attributes) ? meta.attributes.filter((a): a is string => typeof a === "string") : [];
      const size = num(meta.size);
      const file = { ...head, kind: "file", size, mimetype: str(meta.mimetype), attributes };
      if (attributes.includes("subrepository")) {
        return ok({ ...file, content: null, note: "A submodule: it has no file content at this ref." });
      }
      if (attributes.includes("binary")) {
        return ok({ ...file, binary: true, content: null });
      }

      const maxBytes = args.maxBytes ?? FILE_DEFAULT_BYTES;
      const body = await client.getSrcBounded(repoSlug, ref.sha, encoded, maxBytes);
      if (body.text.slice(0, BINARY_SNIFF_BYTES).includes("\u0000")) {
        return ok({ ...file, binary: true, content: null });
      }
      return ok({
        ...file,
        note: attributes.includes("lfs") ? "Stored in Git LFS: the content is the LFS pointer, not the file." : undefined,
        truncated: body.truncated,
        returnedBytes: body.bytesRead,
        content: body.text
      });
    }
  });

  const getFileHistoryTool = defineTool({
    name: "get_file_history",
    description:
      "Commits that changed one file, newest first, following renames — like `git log --follow -- <path>`. Bitbucket Cloud has no blame endpoint; this answers \"who changed this file, and when\". Line-level blame needs a local clone.",
    input: z
      .object({
        repoSlug: repoSlugArg,
        ref: refArg,
        path: z.string().min(1).max(1024),
        cursor: cursorArg,
        pagelen: z.number().int().positive().max(FILE_HISTORY_MAX_PAGELEN).optional(),
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object(
      {
        repoSlug: repoSlugProp,
        ref: refProp,
        path: schema.string("Repo-relative file path"),
        cursor: cursorProp,
        pagelen: schema.integer(`Commits per page (default 25, max ${String(FILE_HISTORY_MAX_PAGELEN)})`, { minimum: 1, maximum: FILE_HISTORY_MAX_PAGELEN }),
        profile: profileProp
      },
      { required: ["path"] }
    ),
    annotations: annotations.readRemote(),
    handler: async (args) => {
      const repoSlug = resolveRepo(config, args.repoSlug);
      const path = validateRepoPath(args.path);
      if (path === "") {
        throw new PolicyViolationError("invalid_path", "get_file_history needs a file path, not the repository root.");
      }
      const cursor = args.cursor === undefined ? undefined : parseCursor(args.cursor);
      const ref = await resolveToSha(client, repoSlug, args.ref);
      // The default entry carries only the commit hash; the rest must be asked for.
      const res = await pathOrNotFound(client.listFileHistory(repoSlug, ref.sha, encodeRepoPath(path), {
        cursor,
        pagelen: args.pagelen,
        fields:
          "values.path,values.size,values.commit.hash,values.commit.date,values.commit.message,values.commit.author.raw,values.commit.author.user.display_name,next"
      }), path, ref.ref);
      return ok({
        workspace: config.workspace,
        repoSlug,
        ref: ref.ref,
        resolvedSha: ref.sha,
        path,
        history: (res.values ?? []).map((h) => ({
          sha: str(get(h, "commit", "hash")),
          date: str(get(h, "commit", "date")),
          author: str(get(h, "commit", "author", "raw")),
          authorName: str(get(h, "commit", "author", "user", "display_name")),
          subject: subject(get(h, "commit", "message")),
          pathAtCommit: str(h.path),
          size: num(h.size)
        })),
        nextCursor: cursorFromNext(res.next)
      });
    }
  });

  const searchCodeTool = defineTool({
    name: "search_code",
    description:
      "Search code across the workspace's repositories (Bitbucket code search), or one repo with repoSlug. Searches each repository's DEFAULT BRANCH only, as last indexed — not other branches and not unpushed work. Returns repo, path, the commit it was indexed at, and up to " +
      `${String(SEARCH_LINES_PER_FILE)} matching lines per file. Does not fall back to BITBUCKET_DEFAULT_REPO: omit repoSlug to search everything. Bitbucket query syntax applies (e.g. ext:ts, path:src, "exact phrase").`,
    input: z
      .object({ query: z.string().min(1).max(512), repoSlug: repoSlugArg, page: pageArg, pagelen: pagelenArg, profile: profileArg })
      .strict(),
    inputSchema: schema.object(
      {
        query: schema.string("Search terms, e.g. pnpm gate ext:yaml"),
        repoSlug: schema.string("Limit to one repository (no default)"),
        page: pageProp,
        pagelen: pagelenProp,
        profile: profileProp
      },
      { required: ["query"] }
    ),
    annotations: annotations.readRemote(),
    handler: async (args) => {
      const slug = args.repoSlug?.trim();
      if (slug !== undefined && !SLUG_RE.test(slug)) {
        throw new PolicyViolationError("invalid_repo_slug", `"${args.repoSlug ?? ""}" is not a repository slug.`);
      }
      const searchQuery = slug ? `repo:${slug} ${args.query}` : args.query;
      let res;
      try {
        res = await client.searchCode(searchQuery, { page: args.page, pagelen: args.pagelen });
      } catch (error) {
        if (error instanceof BitbucketHttpError && (error.status === 403 || error.status === 404)) {
          throw new PolicyViolationError(
            "code_search_unavailable",
            error.status === 404
              ? `Code search is not enabled for workspace ${config.workspace}. A workspace admin turns it on under Workspace settings → Code search. Meanwhile use get_file_at_ref / get_file_history.`
              : `Code search refused this credential (403). Check that the token can read the workspace's repositories, or use get_file_at_ref / get_file_history. Upstream: ${error.detail ?? error.message}`
          );
        }
        throw error;
      }
      const results = (res.values ?? []).map(normalizeHit);
      // Echoed up front so a caller working on another branch notices the
      // search ran against the default branch's last index, not their ref.
      const indexed = [...new Set(results.map((r) => `${String(r.repo)}@${String(r.indexedAt)}`))];
      return ok({
        workspace: config.workspace,
        query: searchQuery,
        searched: "default branch of each repository, as last indexed",
        indexedAt: indexed.length > 0 ? indexed : undefined,
        querySubstituted: res.query_substituted === true ? true : undefined,
        ...pageInfo(res),
        results
      });
    }
  });

  return [getFileAtRefTool, getFileHistoryTool, searchCodeTool];
}

/** A 404 on a path endpoint, once the ref is known to exist, means the path is missing there. */
async function pathOrNotFound<T>(p: Promise<T>, path: string, ref: string): Promise<T> {
  try {
    return await p;
  } catch (error) {
    if (error instanceof BitbucketHttpError && error.status === 404) {
      throw new PolicyViolationError("path_not_found", `"${path}" does not exist at ${ref}. List its directory with get_file_at_ref to see what does.`);
    }
    throw error;
  }
}

/** The repo and commit are only in the hit's self link: `/repositories/{ws}/{repo}/src/{sha}/{path}`. */
function normalizeHit(hit: Record<string, unknown>): Record<string, unknown> {
  const href = str(get(hit, "file", "links", "self", "href")) ?? "";
  const m = /\/repositories\/[^/]+\/([^/]+)\/src\/([0-9a-f]+)\//.exec(href);
  const matches = Array.isArray(hit.content_matches) ? hit.content_matches : [];
  const lines: Array<{ line: number | null; text: string }> = [];
  for (const cm of matches) {
    const cmLines = get(cm, "lines");
    for (const l of Array.isArray(cmLines) ? cmLines : []) {
      if (lines.length >= SEARCH_LINES_PER_FILE) {
        break;
      }
      // Bitbucket sends context lines around each hit; only lines holding a
      // matched segment are kept, so the cap is spent on matches.
      const segments = get(l, "segments");
      const segs = Array.isArray(segments) ? segments : [];
      if (!segs.some((seg) => get(seg, "match") === true)) {
        continue;
      }
      lines.push({ line: num(get(l, "line")), text: segs.map((seg) => str(get(seg, "text")) ?? "").join("") });
    }
  }
  return {
    repo: m ? decodeURIComponent(m[1] ?? "") : null,
    path: str(get(hit, "file", "path")),
    indexedAt: m ? m[2] : null,
    matchCount: num(hit.content_match_count),
    lines
  };
}
