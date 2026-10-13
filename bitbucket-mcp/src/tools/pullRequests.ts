/**
 * Pull-request conversation and merge: list comments (read), add a comment
 * (gated by BITBUCKET_WRITE_ENABLED, like create_pull_request) and merge
 * (gated by its own BITBUCKET_MERGE_ENABLED).
 *
 * Merge is **merge commit only**, by design and without an override. A squash
 * or fast-forward rewrites or skips the SHAs that downstream tooling keys on,
 * and the repositories this serves have no server-side branch restriction, so
 * this tool is the only layer that holds that rule.
 */

import { ok } from "@mcp/core";
import type { PlatformError, Result } from "@mcp/core";
import { annotations, defineTool, schema } from "@mcp/sdk";
import type { AnyToolDefinition, JsonSchemaNode } from "@mcp/sdk";
import { z } from "zod";

import type { BitbucketConfig } from "../config/index.js";
import { PolicyViolationError } from "../middleware/errors.js";
import type { BitbucketClient } from "../services/bitbucketClient.js";
import { validateRepoPath } from "./refs.js";
import {
  bool,
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

export const MERGE_STRATEGY = "merge_commit";
export const COMMENT_MAX_CHARS = 32_768;

const NO_PROTECTION_NOTE =
  "The repository has no server-side branch restriction; this tool's merge-commit-only rule is the only guard.";

export type PullRequestTools = { reads: readonly AnyToolDefinition[]; writes: readonly AnyToolDefinition[] };

export function buildPullRequestTools(config: BitbucketConfig, client: BitbucketClient): PullRequestTools {
  const prIdArg = z.number().int().positive();
  const prIdProp: JsonSchemaNode = schema.integer("Pull request id", { minimum: 1 });

  const listCommentsTool = defineTool({
    name: "list_pull_request_comments",
    description:
      "List a pull request's comments, oldest first: author, text, inline position (path + line) when the comment is on the diff, and parentId for replies. Deleted comments are flagged, not hidden.",
    input: z.object({ repoSlug: repoSlugArg, id: prIdArg, page: pageArg, pagelen: pagelenArg, profile: profileArg }).strict(),
    inputSchema: schema.object(
      { repoSlug: repoSlugProp, id: prIdProp, page: pageProp, pagelen: pagelenProp, profile: profileProp },
      { required: ["id"] }
    ),
    annotations: annotations.readRemote(),
    handler: async (args) => {
      const repoSlug = resolveRepo(config, args.repoSlug);
      const res = await client.listPullRequestComments(repoSlug, args.id, { page: args.page, pagelen: args.pagelen });
      return ok({
        workspace: config.workspace,
        repoSlug,
        id: args.id,
        ...pageInfo(res),
        comments: (res.values ?? []).map(normalizeComment)
      });
    }
  });

  const addCommentTool = defineTool({
    name: "add_pull_request_comment",
    description:
      "Add a comment to a pull request: general, inline on the diff (path + line on the new side, or oldLine on the removed side), or a reply (parentId). Disabled unless BITBUCKET_WRITE_ENABLED=true; dryRun:true previews the request without calling the API. A comment is visible to everyone on the PR — confirm the text with the user first.",
    input: z
      .object({
        repoSlug: repoSlugArg,
        id: prIdArg,
        body: z.string().min(1).max(COMMENT_MAX_CHARS),
        path: z.string().min(1).max(1024).optional(),
        line: z.number().int().positive().optional(),
        oldLine: z.number().int().positive().optional(),
        parentId: z.number().int().positive().optional(),
        dryRun: z.boolean().optional(),
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object(
      {
        repoSlug: repoSlugProp,
        id: prIdProp,
        body: schema.string("Comment text (Markdown)"),
        path: schema.string("File path for an inline comment"),
        line: schema.integer("Line in the NEW version of `path` (inline comment)", { minimum: 1 }),
        oldLine: schema.integer("Line in the OLD version of `path`, for a removed line", { minimum: 1 }),
        parentId: schema.integer("Reply to this comment id", { minimum: 1 }),
        dryRun: schema.boolean("Preview the request without posting"),
        profile: profileProp
      },
      { required: ["id", "body"] }
    ),
    annotations: annotations.create(),
    handler: async (args): Promise<Result<Record<string, unknown>, PlatformError>> => {
      const repoSlug = resolveRepo(config, args.repoSlug);
      const body: Record<string, unknown> = { content: { raw: args.body } };
      if (args.path !== undefined) {
        const path = validateRepoPath(args.path);
        if (args.line === undefined && args.oldLine === undefined) {
          throw new PolicyViolationError("invalid_inline", "An inline comment needs `line` (new side) or `oldLine` (removed side) with `path`.");
        }
        body.inline = {
          path,
          ...(args.line !== undefined ? { to: args.line } : {}),
          ...(args.oldLine !== undefined ? { from: args.oldLine } : {})
        };
      } else if (args.line !== undefined || args.oldLine !== undefined) {
        throw new PolicyViolationError("invalid_inline", "`line` / `oldLine` need `path`.");
      }
      if (args.parentId !== undefined) {
        body.parent = { id: args.parentId };
      }
      const path = client.pullRequestCommentsPath(repoSlug, args.id);

      if (args.dryRun) {
        return ok({ dryRun: true, workspace: config.workspace, repoSlug, request: { method: "POST", path, body } });
      }
      // Inline gate, as in create_pull_request: a guard would also block dryRun.
      if (!config.writeEnabled) {
        throw new PolicyViolationError(
          "WRITE_DISABLED",
          "Commenting is disabled. Set BITBUCKET_WRITE_ENABLED=true to enable, or call with dryRun:true to preview."
        );
      }
      const created = await client.addPullRequestComment(repoSlug, args.id, body);
      return ok({ workspace: config.workspace, repoSlug, created: true, comment: normalizeComment(created) });
    }
  });

  const mergeTool = defineTool({
    name: "merge_pull_request",
    description:
      "Merge a pull request with a MERGE COMMIT — never squash or fast-forward, and there is no option to change that: both rewrite or skip the SHAs history is keyed on. " +
      NO_PROTECTION_NOTE +
      " dryRun defaults to TRUE: the preview checks the PR is open and returns its source commit. To merge, call again with dryRun:false and expectedSourceCommit set to that commit; the merge is refused if the PR moved since. Disabled unless BITBUCKET_MERGE_ENABLED=true.",
    input: z
      .object({
        repoSlug: repoSlugArg,
        id: prIdArg,
        message: z.string().min(1).max(COMMENT_MAX_CHARS).optional(),
        closeSourceBranch: z.boolean().optional(),
        expectedSourceCommit: z.string().regex(/^[0-9a-f]{7,40}$/i).optional(),
        dryRun: z.boolean().optional(),
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object(
      {
        repoSlug: repoSlugProp,
        id: prIdProp,
        message: schema.string("Merge commit message (default: Bitbucket's)"),
        closeSourceBranch: schema.boolean("Delete the source branch after merging"),
        expectedSourceCommit: schema.string("Required with dryRun:false: sourceCommit from the preview"),
        dryRun: schema.boolean("Default true. false merges"),
        profile: profileProp
      },
      { required: ["id"] }
    ),
    // Not read-only, not idempotent, and destructive: it moves a shared branch
    // for good and can delete the source branch.
    annotations: { readOnly: false, idempotent: false, destructive: true, openWorld: true },
    handler: async (args): Promise<Result<Record<string, unknown>, PlatformError>> => {
      const repoSlug = resolveRepo(config, args.repoSlug);
      // Everything a merge needs that the caller controls is checked before any
      // upstream call: a refused merge must not depend on the PR's state.
      if (args.dryRun === false) {
        if (!config.mergeEnabled) {
          throw new PolicyViolationError(
            "MERGE_DISABLED",
            "Merging is disabled. Set BITBUCKET_MERGE_ENABLED=true to enable; dryRun still previews."
          );
        }
        if (!args.expectedSourceCommit) {
          throw new PolicyViolationError(
            "expected_source_commit_required",
            "dryRun:false needs expectedSourceCommit — the sourceCommit a preview returned — so what merges is what was reviewed."
          );
        }
      }
      const pr = await client.getPullRequest(repoSlug, args.id);
      const state = str(pr.state);
      const sourceCommit = str(get(pr, "source", "commit", "hash"));
      const summary = {
        id: args.id,
        title: str(pr.title),
        state,
        source: str(get(pr, "source", "branch", "name")),
        destination: str(get(pr, "destination", "branch", "name")),
        sourceCommit
      };
      if (state !== "OPEN") {
        throw new PolicyViolationError("pr_not_open", `Pull request #${String(args.id)} is ${state ?? "in an unknown state"}; only an OPEN pull request can be merged.`);
      }
      const body: Record<string, unknown> = { type: "pullrequest", merge_strategy: MERGE_STRATEGY };
      if (args.message !== undefined) {
        body.message = args.message;
      }
      if (args.closeSourceBranch !== undefined) {
        body.close_source_branch = args.closeSourceBranch;
      }
      const request = { method: "POST", path: client.mergePullRequestPath(repoSlug, args.id), body };

      if (args.dryRun !== false) {
        return ok({
          dryRun: true,
          workspace: config.workspace,
          repoSlug,
          pullRequest: summary,
          strategy: MERGE_STRATEGY,
          request,
          next: "To merge, call again with dryRun:false and expectedSourceCommit set to pullRequest.sourceCommit.",
          note: NO_PROTECTION_NOTE
        });
      }
      if (!sourceCommit || !args.expectedSourceCommit || !sameCommit(sourceCommit, args.expectedSourceCommit)) {
        throw new PolicyViolationError(
          "source_moved",
          `Pull request #${String(args.id)} now points at ${sourceCommit ?? "an unknown commit"}, not ${args.expectedSourceCommit}. Preview again and review what changed.`
        );
      }

      const merged = await client.mergePullRequest(repoSlug, args.id, body);
      const mergedState = str(merged.state);
      return ok({
        workspace: config.workspace,
        repoSlug,
        merged: mergedState === "MERGED",
        // Bitbucket may accept a slow merge asynchronously (202, no PR body).
        pending: mergedState === null ? true : undefined,
        state: mergedState,
        strategy: MERGE_STRATEGY,
        mergeCommit: str(get(merged, "merge_commit", "hash")),
        // The summary was taken before the merge: carry the new state, not "OPEN".
        pullRequest: { ...summary, state: mergedState ?? summary.state }
      });
    }
  });

  return { reads: [listCommentsTool], writes: [addCommentTool, mergeTool] };
}

/** Bitbucket abbreviates PR commit hashes to 12 characters: compare by prefix. */
function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

function normalizeComment(c: Record<string, unknown>): Record<string, unknown> {
  const inline = get(c, "inline");
  return {
    id: num(c.id),
    author: str(get(c, "user", "display_name")),
    createdOn: str(c.created_on),
    updatedOn: str(c.updated_on),
    body: str(get(c, "content", "raw")),
    path: inline ? str(get(inline, "path")) : null,
    line: inline ? num(get(inline, "to")) : null,
    oldLine: inline ? num(get(inline, "from")) : null,
    parentId: num(get(c, "parent", "id")),
    deleted: bool(c.deleted) === true ? true : undefined,
    href: str(get(c, "links", "html", "href"))
  };
}
