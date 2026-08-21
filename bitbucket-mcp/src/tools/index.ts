/**
 * The bitbucket-mcp tool table.
 *
 * Separated from `index.ts` so the tools can be built against a stub client and
 * exercised without starting a server — `index.ts` is the entry point and has
 * start-up side effects (config load, transport connect) by design.
 */

import { isPlatformError, ok } from "@mcp/core";
import type { PlatformError, Result } from "@mcp/core";
import { annotations, defineTool, registerTool, schema } from "@mcp/sdk";
import type { AnyToolDefinition, JsonSchemaNode } from "@mcp/sdk";
import { z } from "zod";

import type { BitbucketClient, CreatePullRequestBody } from "../services/bitbucketClient.js";
import { describeConfig, type BitbucketConfig } from "../config/index.js";
import { mapError, PolicyViolationError } from "../middleware/errors.js";
import { buildPipelineTools } from "./pipelines.js";
import { UUID_RE, bool, get, num, pageInfo, resolveRepo, str } from "./shared.js";
import {
  pageArg, pagelenArg, profileArg, qArg, repoSlugArg, sortArg,
  pageProp, pagelenProp, profileProp, repoSlugProp
} from "./shared.js";

/**
 * Render any failure in this server's `{ code, message, detail? }` envelope.
 *
 * `mapError` handles everything this server itself throws. What it does not know
 * is `PlatformError`, which the shared dispatch layer raises for failures that
 * happen before a handler runs — an unknown tool being the main one. Those would
 * otherwise collapse to `internal_error`, hiding a perfectly good code, so they
 * are unwrapped to their own code and message here.
 */
export function toWireError(error: unknown): { code: string; message: string; detail?: string } {
  if (isPlatformError(error)) {
    return { code: error.code, message: error.message };
  }
  return mapError(error);
}

export function buildTools(config: BitbucketConfig, client: BitbucketClient): readonly AnyToolDefinition[] {
  // The fragments every tool group shares now live in `./shared.js` — the
  // pipeline group needs them too, and a closure cannot be imported.
  const branchArg = z.string().min(1).max(512);
  const prIdProp: JsonSchemaNode = schema.integer("Pull request id", { minimum: 1 });

  // --- tools -----------------------------------------------------------------

  const healthCheckTool = defineTool({
    name: "health_check",
    description:
      "Verify connectivity + auth to Bitbucket and echo the (non-secret) server config. Probes the default repo if set, else lists one repository.",
    input: z.object({ profile: profileArg }).strict(),
    inputSchema: schema.object({ profile: profileProp }),
    annotations: annotations.readRemote(),
    handler: async () => {
      let check: Record<string, unknown>;
      try {
        if (config.defaultRepo) {
          const repo = await client.getRepository(config.defaultRepo);
          check = { ok: true, probe: "get_repository", repo: normalizeRepo(repo) };
        } else {
          const repos = await client.listRepositories({ pagelen: 1 });
          check = { ok: true, probe: "list_repositories", count: (repos.values ?? []).length };
        }
      } catch (error) {
        // A failed probe is a health *result*, not a tool failure.
        check = { ok: false, error: mapError(error) };
      }
      return ok({ config: describeConfig(config), check });
    }
  });

  const listRepositoriesTool = defineTool({
    name: "list_repositories",
    description:
      "List repositories in the configured workspace. Optional role filter (owner/admin/contributor/member), free-text `q` (BBQL), and `sort`.",
    input: z
      .object({
        role: z.enum(["owner", "admin", "contributor", "member"]).optional(),
        q: qArg,
        sort: sortArg,
        page: pageArg,
        pagelen: pagelenArg,
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object({
      role: schema.enumOf(["owner", "admin", "contributor", "member"]),
      q: schema.string('Bitbucket query, e.g. name ~ "api"'),
      sort: schema.string("e.g. -updated_on"),
      page: pageProp,
      pagelen: pagelenProp,
      profile: profileProp
    }),
    annotations: annotations.readRemote(),
    handler: async (args) => {
      const res = await client.listRepositories(args);
      return ok({
        workspace: config.workspace,
        ...pageInfo(res),
        repositories: (res.values ?? []).map(normalizeRepo)
      });
    }
  });

  const getRepositoryTool = defineTool({
    name: "get_repository",
    description: "Get metadata for one repository (name, main branch, visibility, language, links).",
    input: z.object({ repoSlug: repoSlugArg, profile: profileArg }).strict(),
    inputSchema: schema.object({ repoSlug: repoSlugProp, profile: profileProp }),
    annotations: annotations.readRemote(),
    handler: async (args) => {
      const repoSlug = resolveRepo(config, args.repoSlug);
      const repo = await client.getRepository(repoSlug);
      return ok({ workspace: config.workspace, repository: normalizeRepo(repo) });
    }
  });

  const listBranchesTool = defineTool({
    name: "list_branches",
    description:
      "List branches of a repository (useful for picking a source/destination branch before creating a PR).",
    input: z
      .object({
        repoSlug: repoSlugArg,
        q: qArg,
        sort: sortArg,
        page: pageArg,
        pagelen: pagelenArg,
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object({
      repoSlug: repoSlugProp,
      q: schema.string('e.g. name ~ "feature"'),
      sort: schema.string(),
      page: pageProp,
      pagelen: pagelenProp,
      profile: profileProp
    }),
    annotations: annotations.readRemote(),
    handler: async (args) => {
      const repoSlug = resolveRepo(config, args.repoSlug);
      const res = await client.listBranches(repoSlug, args);
      return ok({
        workspace: config.workspace,
        repoSlug,
        ...pageInfo(res),
        branches: (res.values ?? []).map(normalizeBranch)
      });
    }
  });

  const listPullRequestsTool = defineTool({
    name: "list_pull_requests",
    description:
      "List pull requests of a repository. Defaults to OPEN; pass state to filter (OPEN/MERGED/DECLINED/SUPERSEDED).",
    input: z
      .object({
        repoSlug: repoSlugArg,
        state: z.enum(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]).optional(),
        q: qArg,
        sort: sortArg,
        page: pageArg,
        pagelen: pagelenArg,
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object({
      repoSlug: repoSlugProp,
      state: schema.enumOf(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]),
      q: schema.string(),
      sort: schema.string("e.g. -updated_on"),
      page: pageProp,
      pagelen: pagelenProp,
      profile: profileProp
    }),
    annotations: annotations.readRemote(),
    handler: async (args) => {
      const repoSlug = resolveRepo(config, args.repoSlug);
      const res = await client.listPullRequests(repoSlug, args);
      return ok({
        workspace: config.workspace,
        repoSlug,
        state: args.state ?? "OPEN",
        ...pageInfo(res),
        pullRequests: (res.values ?? []).map(normalizePr)
      });
    }
  });

  const getPullRequestTool = defineTool({
    name: "get_pull_request",
    description:
      "Get a single pull request by id (title, state, branches, author, reviewers, links, counts).",
    input: z
      .object({ repoSlug: repoSlugArg, id: z.number().int().positive(), profile: profileArg })
      .strict(),
    inputSchema: schema.object(
      { repoSlug: repoSlugProp, id: prIdProp, profile: profileProp },
      { required: ["id"] }
    ),
    annotations: annotations.readRemote(),
    handler: async (args) => {
      const repoSlug = resolveRepo(config, args.repoSlug);
      const pr = await client.getPullRequest(repoSlug, args.id);
      return ok({ workspace: config.workspace, repoSlug, pullRequest: normalizePr(pr) });
    }
  });

  const getPullRequestDiffTool = defineTool({
    name: "get_pull_request_diff",
    description:
      "Get the raw unified diff for a pull request as text. The full diff is always returned and may be large (see diffLength) — there is no profile-based truncation.",
    input: z
      .object({ repoSlug: repoSlugArg, id: z.number().int().positive(), profile: profileArg })
      .strict(),
    inputSchema: schema.object(
      { repoSlug: repoSlugProp, id: prIdProp, profile: profileProp },
      { required: ["id"] }
    ),
    annotations: annotations.readRemote(),
    handler: async (args) => {
      const repoSlug = resolveRepo(config, args.repoSlug);
      const diff = await client.getPullRequestDiff(repoSlug, args.id);
      return ok({
        workspace: config.workspace,
        repoSlug,
        id: args.id,
        diffLength: diff.length,
        diff
      });
    }
  });

  const createPullRequestTool = defineTool({
    name: "create_pull_request",
    description:
      "Create a pull request. Disabled unless BITBUCKET_WRITE_ENABLED=true. Pass dryRun:true to preview the request payload without calling the API.",
    input: z
      .object({
        repoSlug: repoSlugArg,
        title: z.string().min(1).max(512),
        sourceBranch: branchArg,
        destinationBranch: z.string().min(1).max(512).optional(),
        description: z.string().max(262_144).optional(),
        closeSourceBranch: z.boolean().optional(),
        reviewers: z.array(z.string().min(1).max(128)).max(100).optional(),
        dryRun: z.boolean().optional(),
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object(
      {
        repoSlug: repoSlugProp,
        title: schema.string("PR title"),
        sourceBranch: schema.string("Source branch name (the branch with your changes)"),
        destinationBranch: schema.string("Destination branch (default: repo main branch)"),
        description: schema.string("PR description (Markdown)"),
        closeSourceBranch: schema.boolean("Delete source branch on merge"),
        reviewers: schema.array(
          schema.string(),
          "Reviewer UUIDs (with or without braces) or account_ids"
        ),
        dryRun: schema.boolean("Preview the payload without creating the PR"),
        profile: profileProp
      },
      { required: ["title", "sourceBranch"] }
    ),
    annotations: annotations.create(),
    // Explicit return type: the dry-run preview and the created-PR result are
    // different shapes, so inference would lock onto whichever appears first.
    handler: async (args): Promise<Result<Record<string, unknown>, PlatformError>> => {
      const repoSlug = resolveRepo(config, args.repoSlug);

      const body: CreatePullRequestBody = {
        title: args.title,
        source: { branch: { name: args.sourceBranch } }
      };
      if (args.destinationBranch) {
        body.destination = { branch: { name: args.destinationBranch } };
      }
      if (args.description !== undefined) {
        body.description = args.description;
      }
      if (args.closeSourceBranch !== undefined) {
        body.close_source_branch = args.closeSourceBranch;
      }
      if (args.reviewers && args.reviewers.length > 0) {
        body.reviewers = args.reviewers.map(toReviewer);
      }

      const path = client.createPullRequestPath(repoSlug);

      if (args.dryRun) {
        return ok({
          dryRun: true,
          workspace: config.workspace,
          repoSlug,
          request: { method: "POST", path, body }
        });
      }

      // Write gate — refuse unless explicitly enabled. Deliberately checked HERE
      // rather than as a guard: a guard runs before the handler and would also
      // block dryRun, but a preview must work even when writes are off.
      if (!config.writeEnabled) {
        throw new PolicyViolationError(
          "WRITE_DISABLED",
          "Creating pull requests is disabled. Set BITBUCKET_WRITE_ENABLED=true to enable, or call with dryRun:true to preview the payload."
        );
      }

      const pr = await client.createPullRequest(repoSlug, body);
      return ok({
        workspace: config.workspace,
        repoSlug,
        created: true,
        pullRequest: normalizePr(pr)
      });
    }
  });

  // Registration order is the order clients see in `tools/list`. The helper
  // functions below are declarations, so they are hoisted and usable here.
  // Order is the order `tools/list` advertises. `registerTool` only flattens and
  // rejects a duplicate name; it does not reorder.
  // The pipeline group sits after the pull-request reads and before the one
  // write tool, so every read-only tool is contiguous in `tools/list`.
  return registerTool([
    healthCheckTool,
    listRepositoriesTool,
    getRepositoryTool,
    listBranchesTool,
    listPullRequestsTool,
    getPullRequestTool,
    getPullRequestDiffTool,
    ...buildPipelineTools(config, client),
    createPullRequestTool
  ]);

  // --- helpers --------------------------------------------------------------

  /**
   * Map a reviewer string to Bitbucket's shape. A UUID (with or without the
   * surrounding braces Bitbucket uses) becomes `{ uuid: "{...}" }`; anything else
   * (e.g. an account_id like "557058:...") becomes `{ account_id }`.
   */
  function toReviewer(raw: string): { uuid?: string; account_id?: string } {
    const core = raw.replace(/^\{/, "").replace(/\}$/, "");
    if (UUID_RE.test(core)) {
      return { uuid: `{${core}}` };
    }
    return { account_id: raw };
  }

  function normalizeRepo(repo: Record<string, unknown>): Record<string, unknown> {
    return {
      fullName: str(repo.full_name),
      slug: str(repo.slug) ?? str(repo.name),
      name: str(repo.name),
      isPrivate: bool(repo.is_private),
      mainBranch: str(get(repo, "mainbranch", "name")),
      language: str(repo.language),
      updatedOn: str(repo.updated_on),
      href: str(get(repo, "links", "html", "href"))
    };
  }

  function normalizeBranch(branch: Record<string, unknown>): Record<string, unknown> {
    return {
      name: str(branch.name),
      target: str(get(branch, "target", "hash"))
    };
  }

  function normalizePr(pr: Record<string, unknown>): Record<string, unknown> {
    return {
      id: num(pr.id),
      title: str(pr.title),
      state: str(pr.state),
      author: str(get(pr, "author", "display_name")),
      source: str(get(pr, "source", "branch", "name")),
      destination: str(get(pr, "destination", "branch", "name")),
      createdOn: str(pr.created_on),
      updatedOn: str(pr.updated_on),
      commentCount: num(pr.comment_count),
      taskCount: num(pr.task_count),
      closeSourceBranch: bool(pr.close_source_branch),
      href: str(get(pr, "links", "html", "href"))
    };
  }

}
