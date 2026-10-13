/**
 * create_branch / delete_branch — scratch and PR branches without a local push,
 * so nothing has to happen in a worktree other sessions share.
 *
 * Same allowlist as commit_files (BITBUCKET_COMMIT_BRANCHES), plus three hard
 * refusals no configuration lifts: a shared branch, the repo's main branch,
 * and master/main/develop by name. The repositories this serves have no
 * server-side branch restriction, so these checks are the only guard. Both
 * tools preview by default; a delete is bound to the head that was previewed
 * and refused while any open pull request uses the branch.
 */

import { ok } from "@mcp/core";
import type { PlatformError, Result } from "@mcp/core";
import { annotations, defineTool, schema } from "@mcp/sdk";
import type { AnyToolDefinition } from "@mcp/sdk";
import { z } from "zod";

import type { BitbucketConfig } from "../config/index.js";
import { BitbucketHttpError, PolicyViolationError } from "../middleware/errors.js";
import type { BitbucketClient } from "../services/bitbucketClient.js";
import { classifyBranch } from "./commitPlan.js";
import { resolveToSha, validateRef } from "./refs.js";
import { get, num, profileArg, profileProp, repoSlugArg, repoSlugProp, resolveRepo, str } from "./shared.js";

/** Never created or deleted here, whatever the allowlist says. */
export const PROTECTED_BRANCHES = ["master", "main", "develop"] as const;

const NO_PROTECTION_NOTE =
  "The repository has no server-side branch restriction; this tool's allowlist and refusals are the only guard.";

export function buildBranchTools(config: BitbucketConfig, client: BitbucketClient): readonly AnyToolDefinition[] {
  const createTool = defineTool({
    name: "create_branch",
    description:
      "Create a branch at a ref (branch, tag or SHA) on the remote, without a local checkout or push. Only names on BITBUCKET_COMMIT_BRANCHES; never a shared branch, the main branch, or master/main/develop. dryRun defaults to TRUE. Disabled unless BITBUCKET_BRANCH_ENABLED=true. " +
      NO_PROTECTION_NOTE,
    input: z
      .object({ repoSlug: repoSlugArg, name: z.string().min(1).max(256), fromRef: z.string().min(1).max(256), dryRun: z.boolean().optional(), profile: profileArg })
      .strict(),
    inputSchema: schema.object(
      {
        repoSlug: repoSlugProp,
        name: schema.string("New branch name, e.g. sandbox/my-test"),
        fromRef: schema.string("Branch, tag or SHA the new branch points at"),
        dryRun: schema.boolean("Default true. false creates"),
        profile: profileProp
      },
      { required: ["name", "fromRef"] }
    ),
    annotations: annotations.create(),
    handler: async (args): Promise<Result<Record<string, unknown>, PlatformError>> => {
      const repoSlug = resolveRepo(config, args.repoSlug);
      const name = await assertWritableName(config, client, repoSlug, args.name);
      if (args.dryRun === false && !config.branchEnabled) {
        throw disabled();
      }
      const from = await resolveToSha(client, repoSlug, args.fromRef);
      if ((await headOf(client, repoSlug, name)) !== null) {
        throw new PolicyViolationError("branch_exists", `${name} already exists in ${repoSlug}.`);
      }
      const request = { method: "POST", path: client.branchesPath(repoSlug), body: { name, target: { hash: from.sha } } };
      if (args.dryRun !== false) {
        return ok({ dryRun: true, workspace: config.workspace, repoSlug, name, fromRef: from.ref, target: from.sha, request });
      }
      const created = await client.createBranch(repoSlug, name, from.sha);
      return ok({
        workspace: config.workspace,
        repoSlug,
        created: true,
        name: str(created.name) ?? name,
        target: str(get(created, "target", "hash")) ?? from.sha
      });
    }
  });

  const deleteTool = defineTool({
    name: "delete_branch",
    description:
      "Delete a branch on the remote. Only names on BITBUCKET_COMMIT_BRANCHES; never a shared branch, the main branch, or master/main/develop. Refused while an OPEN pull request has the branch as source or destination. dryRun defaults to TRUE and returns the current head; dryRun:false needs expectedHead set to it, so a branch that moved is never deleted. Disabled unless BITBUCKET_BRANCH_ENABLED=true. " +
      NO_PROTECTION_NOTE,
    input: z
      .object({
        repoSlug: repoSlugArg,
        name: z.string().min(1).max(256),
        expectedHead: z.string().regex(/^[0-9a-f]{7,40}$/i).optional(),
        dryRun: z.boolean().optional(),
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object(
      {
        repoSlug: repoSlugProp,
        name: schema.string("Branch to delete"),
        expectedHead: schema.string("Required with dryRun:false: head from the preview"),
        dryRun: schema.boolean("Default true. false deletes"),
        profile: profileProp
      },
      { required: ["name"] }
    ),
    annotations: { readOnly: false, idempotent: false, destructive: true, openWorld: true },
    handler: async (args): Promise<Result<Record<string, unknown>, PlatformError>> => {
      const repoSlug = resolveRepo(config, args.repoSlug);
      const name = await assertWritableName(config, client, repoSlug, args.name);
      if (args.dryRun === false) {
        if (!config.branchEnabled) {
          throw disabled();
        }
        if (!args.expectedHead) {
          throw new PolicyViolationError(
            "expected_head_required",
            "dryRun:false needs expectedHead — the head a preview returned — so a branch that moved is not deleted."
          );
        }
      }
      const head = await headOf(client, repoSlug, name);
      if (head === null) {
        throw new PolicyViolationError("branch_not_found", `${name} does not exist in ${repoSlug}.`);
      }
      const openPrs = await openPullRequestsUsing(client, repoSlug, name);
      if (openPrs.length > 0) {
        throw new PolicyViolationError(
          "branch_has_open_pr",
          `${name} is used by open pull request(s) ${openPrs.map((id) => `#${String(id)}`).join(", ")}. Merge or decline them first.`
        );
      }
      if (args.dryRun !== false) {
        return ok({
          dryRun: true,
          workspace: config.workspace,
          repoSlug,
          name,
          head,
          request: { method: "DELETE", path: `${client.branchesPath(repoSlug)}/${encodeURIComponent(name)}` },
          next: "To delete, call again with dryRun:false and expectedHead set to head."
        });
      }
      const expected = (args.expectedHead ?? "").toLowerCase();
      if (!head.toLowerCase().startsWith(expected)) {
        throw new PolicyViolationError("head_moved", `${name} is now at ${head}, not ${args.expectedHead ?? ""}. Preview again.`);
      }
      await client.deleteBranch(repoSlug, name);
      return ok({ workspace: config.workspace, repoSlug, deleted: true, name, head });
    }
  });

  return [createTool, deleteTool];
}

/**
 * The name is valid, allowlisted as a non-shared branch, and none of the
 * protected names nor the repo's main branch. Checked before anything else.
 */
async function assertWritableName(config: BitbucketConfig, client: BitbucketClient, repoSlug: string, raw: string): Promise<string> {
  const name = validateRef(raw);
  if (name.includes('"')) {
    throw new PolicyViolationError("invalid_ref", "A branch name with a double quote is not supported here.");
  }
  if ((PROTECTED_BRANCHES as readonly string[]).includes(name)) {
    throw protectedBranch(name);
  }
  if (classifyBranch(config, repoSlug, name) === "shared") {
    throw new PolicyViolationError("branch_not_allowed", `${name} is a shared branch (BITBUCKET_COMMIT_SHARED_BRANCHES); it is never created or deleted here.`);
  }
  const main = str(get(await client.getRepository(repoSlug), "mainbranch", "name"));
  if (main === name) {
    throw protectedBranch(name);
  }
  return name;
}

function protectedBranch(name: string): PolicyViolationError {
  return new PolicyViolationError("branch_protected", `${name} is protected: create_branch and delete_branch never touch master, main, develop or the main branch.`);
}

function disabled(): PolicyViolationError {
  return new PolicyViolationError(
    "BRANCH_DISABLED",
    "Creating and deleting branches is disabled. Set BITBUCKET_BRANCH_ENABLED=true to enable; dryRun still previews."
  );
}

async function headOf(client: BitbucketClient, repoSlug: string, name: string): Promise<string | null> {
  try {
    return str(get(await client.getBranch(repoSlug, name), "target", "hash"));
  } catch (error) {
    if (error instanceof BitbucketHttpError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

async function openPullRequestsUsing(client: BitbucketClient, repoSlug: string, name: string): Promise<number[]> {
  const res = await client.listPullRequests(repoSlug, {
    state: "OPEN",
    q: `source.branch.name="${name}" OR destination.branch.name="${name}"`,
    pagelen: 50
  });
  return (res.values ?? [])
    .filter((pr) => str(get(pr, "source", "branch", "name")) === name || str(get(pr, "destination", "branch", "name")) === name)
    .map((pr) => num(pr.id))
    .filter((id): id is number => id !== null);
}
