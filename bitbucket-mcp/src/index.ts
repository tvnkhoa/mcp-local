import process from "node:process";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  type CallToolResult
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { loadConfig, describeConfig, type BitbucketConfig } from "./config.js";
import { mapError, PolicyViolationError } from "./errors.js";
import { BitbucketClient, type CreatePullRequestBody } from "./bitbucketClient.js";
import {
  asText as asTextProfiled,
  asError as asErrorProfiled,
  responseProfileSchema
} from "./response/responseFormatter.js";

const config: BitbucketConfig = loadConfig();
const client = new BitbucketClient(config);

// --- shared zod fragments -------------------------------------------------
const profileArg = responseProfileSchema.optional();
const repoSlugArg = z.string().min(1).max(256).optional();
const qArg = z.string().min(1).max(512).optional();
const sortArg = z.string().min(1).max(128).optional();
const pageArg = z.number().int().positive().optional();
const pagelenArg = z.number().int().positive().max(100).optional();
const branchArg = z.string().min(1).max(512);

// --- per-tool schemas -----------------------------------------------------
const healthCheckSchema = z.object({
  profile: profileArg
}).strict();

const listReposSchema = z.object({
  role: z.enum(["owner", "admin", "contributor", "member"]).optional(),
  q: qArg,
  sort: sortArg,
  page: pageArg,
  pagelen: pagelenArg,
  profile: profileArg
}).strict();

const getRepoSchema = z.object({
  repoSlug: repoSlugArg,
  profile: profileArg
}).strict();

const listBranchesSchema = z.object({
  repoSlug: repoSlugArg,
  q: qArg,
  sort: sortArg,
  page: pageArg,
  pagelen: pagelenArg,
  profile: profileArg
}).strict();

const listPullRequestsSchema = z.object({
  repoSlug: repoSlugArg,
  state: z.enum(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]).optional(),
  q: qArg,
  sort: sortArg,
  page: pageArg,
  pagelen: pagelenArg,
  profile: profileArg
}).strict();

const getPullRequestSchema = z.object({
  repoSlug: repoSlugArg,
  id: z.number().int().positive(),
  profile: profileArg
}).strict();

const getPullRequestDiffSchema = z.object({
  repoSlug: repoSlugArg,
  id: z.number().int().positive(),
  profile: profileArg
}).strict();

const createPullRequestSchema = z.object({
  repoSlug: repoSlugArg,
  title: z.string().min(1).max(512),
  sourceBranch: branchArg,
  destinationBranch: z.string().min(1).max(512).optional(),
  description: z.string().max(262_144).optional(),
  closeSourceBranch: z.boolean().optional(),
  reviewers: z.array(z.string().min(1).max(128)).max(100).optional(),
  dryRun: z.boolean().optional(),
  profile: profileArg
}).strict();

// --- server ---------------------------------------------------------------
const server = new Server(
  { name: "bitbucket-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "health_check",
      description:
        "Verify connectivity + auth to Bitbucket and echo the (non-secret) server config. Probes the default repo if set, else lists one repository.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
        }
      }
    },
    {
      name: "list_repositories",
      description:
        "List repositories in the configured workspace. Optional role filter (owner/admin/contributor/member), free-text `q` (BBQL), and `sort`.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          role: { type: "string", enum: ["owner", "admin", "contributor", "member"] },
          q: { type: "string", description: 'Bitbucket query, e.g. name ~ "api"' },
          sort: { type: "string", description: "e.g. -updated_on" },
          page: { type: "integer", minimum: 1 },
          pagelen: { type: "integer", minimum: 1, maximum: 100, description: "Page size (default 25, max 100)" },
          profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
        }
      }
    },
    {
      name: "get_repository",
      description: "Get metadata for one repository (name, main branch, visibility, language, links).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          repoSlug: { type: "string", description: "Repo slug (default: BITBUCKET_DEFAULT_REPO)" },
          profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
        }
      }
    },
    {
      name: "list_branches",
      description: "List branches of a repository (useful for picking a source/destination branch before creating a PR).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          repoSlug: { type: "string", description: "Repo slug (default: BITBUCKET_DEFAULT_REPO)" },
          q: { type: "string", description: 'e.g. name ~ "feature"' },
          sort: { type: "string" },
          page: { type: "integer", minimum: 1 },
          pagelen: { type: "integer", minimum: 1, maximum: 100, description: "Page size (default 25, max 100)" },
          profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
        }
      }
    },
    {
      name: "list_pull_requests",
      description: "List pull requests of a repository. Defaults to OPEN; pass state to filter (OPEN/MERGED/DECLINED/SUPERSEDED).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          repoSlug: { type: "string", description: "Repo slug (default: BITBUCKET_DEFAULT_REPO)" },
          state: { type: "string", enum: ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"] },
          q: { type: "string" },
          sort: { type: "string", description: "e.g. -updated_on" },
          page: { type: "integer", minimum: 1 },
          pagelen: { type: "integer", minimum: 1, maximum: 100, description: "Page size (default 25, max 100)" },
          profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
        }
      }
    },
    {
      name: "get_pull_request",
      description: "Get a single pull request by id (title, state, branches, author, reviewers, links, counts).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          repoSlug: { type: "string", description: "Repo slug (default: BITBUCKET_DEFAULT_REPO)" },
          id: { type: "integer", minimum: 1, description: "Pull request id" },
          profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
        }
      }
    },
    {
      name: "get_pull_request_diff",
      description: "Get the raw unified diff for a pull request as text. The full diff is always returned and may be large (see diffLength) — there is no profile-based truncation.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          repoSlug: { type: "string", description: "Repo slug (default: BITBUCKET_DEFAULT_REPO)" },
          id: { type: "integer", minimum: 1, description: "Pull request id" },
          profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
        }
      }
    },
    {
      name: "create_pull_request",
      description:
        "Create a pull request. Disabled unless BITBUCKET_WRITE_ENABLED=true. Pass dryRun:true to preview the request payload without calling the API.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["title", "sourceBranch"],
        properties: {
          repoSlug: { type: "string", description: "Repo slug (default: BITBUCKET_DEFAULT_REPO)" },
          title: { type: "string", description: "PR title" },
          sourceBranch: { type: "string", description: "Source branch name (the branch with your changes)" },
          destinationBranch: { type: "string", description: "Destination branch (default: repo main branch)" },
          description: { type: "string", description: "PR description (Markdown)" },
          closeSourceBranch: { type: "boolean", description: "Delete source branch on merge" },
          reviewers: {
            type: "array",
            items: { type: "string" },
            description: "Reviewer UUIDs (with or without braces) or account_ids"
          },
          dryRun: { type: "boolean", description: "Preview the payload without creating the PR" },
          profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
        }
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  try {
    switch (request.params.name) {
      case "health_check": {
        const args = healthCheckSchema.parse(request.params.arguments ?? {});
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
          check = { ok: false, error: mapError(error) };
        }
        return asTextProfiled({ config: describeConfig(config), check }, args.profile);
      }

      case "list_repositories": {
        const args = listReposSchema.parse(request.params.arguments ?? {});
        const res = await client.listRepositories(args);
        return asTextProfiled(
          {
            workspace: config.workspace,
            ...pageInfo(res),
            repositories: (res.values ?? []).map(normalizeRepo)
          },
          args.profile
        );
      }

      case "get_repository": {
        const args = getRepoSchema.parse(request.params.arguments ?? {});
        const repoSlug = resolveRepo(args.repoSlug);
        const repo = await client.getRepository(repoSlug);
        return asTextProfiled({ workspace: config.workspace, repository: normalizeRepo(repo) }, args.profile);
      }

      case "list_branches": {
        const args = listBranchesSchema.parse(request.params.arguments ?? {});
        const repoSlug = resolveRepo(args.repoSlug);
        const res = await client.listBranches(repoSlug, args);
        return asTextProfiled(
          {
            workspace: config.workspace,
            repoSlug,
            ...pageInfo(res),
            branches: (res.values ?? []).map(normalizeBranch)
          },
          args.profile
        );
      }

      case "list_pull_requests": {
        const args = listPullRequestsSchema.parse(request.params.arguments ?? {});
        const repoSlug = resolveRepo(args.repoSlug);
        const res = await client.listPullRequests(repoSlug, args);
        return asTextProfiled(
          {
            workspace: config.workspace,
            repoSlug,
            state: args.state ?? "OPEN",
            ...pageInfo(res),
            pullRequests: (res.values ?? []).map(normalizePr)
          },
          args.profile
        );
      }

      case "get_pull_request": {
        const args = getPullRequestSchema.parse(request.params.arguments ?? {});
        const repoSlug = resolveRepo(args.repoSlug);
        const pr = await client.getPullRequest(repoSlug, args.id);
        return asTextProfiled({ workspace: config.workspace, repoSlug, pullRequest: normalizePr(pr) }, args.profile);
      }

      case "get_pull_request_diff": {
        const args = getPullRequestDiffSchema.parse(request.params.arguments ?? {});
        const repoSlug = resolveRepo(args.repoSlug);
        const diff = await client.getPullRequestDiff(repoSlug, args.id);
        return asTextProfiled(
          { workspace: config.workspace, repoSlug, id: args.id, diffLength: diff.length, diff },
          args.profile
        );
      }

      case "create_pull_request": {
        const args = createPullRequestSchema.parse(request.params.arguments ?? {});
        const repoSlug = resolveRepo(args.repoSlug);

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
          return asTextProfiled(
            {
              dryRun: true,
              workspace: config.workspace,
              repoSlug,
              request: { method: "POST", path, body }
            },
            args.profile
          );
        }

        // Write gate — refuse unless explicitly enabled. Checked only on the real
        // API path so a dryRun preview always works, even when writes are off.
        if (!config.writeEnabled) {
          throw new PolicyViolationError(
            "WRITE_DISABLED",
            "Creating pull requests is disabled. Set BITBUCKET_WRITE_ENABLED=true to enable, or call with dryRun:true to preview the payload."
          );
        }

        const pr = await client.createPullRequest(repoSlug, body);
        return asTextProfiled(
          { workspace: config.workspace, repoSlug, created: true, pullRequest: normalizePr(pr) },
          args.profile
        );
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    return asErrorProfiled(mapError(error), "verbose");
  }
});

// --- helpers --------------------------------------------------------------

/** Resolve the target repo slug from an explicit arg or the configured default. */
function resolveRepo(repoSlug: string | undefined): string {
  const slug = repoSlug?.trim() || config.defaultRepo;
  if (!slug) {
    throw new PolicyViolationError(
      "repo_required",
      "No repository specified. Pass `repoSlug` or set BITBUCKET_DEFAULT_REPO."
    );
  }
  return slug;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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

/** Summarize a Bitbucket paginated response (page/size/next flag). */
function pageInfo(res: { page?: number; pagelen?: number; size?: number; next?: string }): Record<string, unknown> {
  return {
    page: res.page ?? null,
    pagelen: res.pagelen ?? null,
    size: res.size ?? null,
    hasNext: Boolean(res.next)
  };
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

// --- tiny safe accessors for untyped Bitbucket JSON -----------------------
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}
function get(root: unknown, ...keys: string[]): unknown {
  let cur: unknown = root;
  for (const key of keys) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function logInfo(event: string, detail: Record<string, unknown>): void {
  console.error(JSON.stringify({ level: "info", event, ...detail }));
}
function logError(event: string, detail: Record<string, unknown>): void {
  console.error(JSON.stringify({ level: "error", event, ...detail }));
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logInfo("server_started", { config: describeConfig(config) });
}

main().catch((error) => {
  logError("server_crashed", { error: mapError(error) });
  process.exit(1);
});
