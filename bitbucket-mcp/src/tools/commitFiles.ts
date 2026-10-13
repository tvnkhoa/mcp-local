/**
 * commit_files_preview → commit_files_apply: create ONE commit on a branch
 * from a set of text files, server-side, without a local index. For several
 * agents sharing one worktree, this is the server-side form of "commit only my
 * paths": nothing staged by anyone else can be swept in, because nothing local
 * is involved.
 *
 * Rules, each enforced here because the repositories this serves have no
 * server-side branch restriction:
 * - never force: the commit's parent is asserted to be the branch head, by us
 *   before the call and by Bitbucket during it (400 or 409);
 * - only branches on an allowlist; a branch checked out in a shared worktree
 *   is on its own list, and its result carries the local reconcile steps;
 * - text only, size-capped;
 * - apply commits exactly the previewed content: it takes previewId +
 *   approvalToken, not files, and each preview is single-use.
 */

import { createHash, randomUUID } from "node:crypto";

import { ok } from "@mcp/core";
import { annotations, defineTool, schema } from "@mcp/sdk";
import type { AnyToolDefinition } from "@mcp/sdk";
import { describePreviewTokenRejection, generateApprovalSecret, issuePreviewToken, verifyPreviewToken } from "@mcp/shared";
import { z } from "zod";

import type { BitbucketConfig } from "../config/index.js";
import { BitbucketHttpError, PolicyViolationError } from "../middleware/errors.js";
import type { BitbucketClient } from "../services/bitbucketClient.js";
import { buildBranchTools } from "./branches.js";
import { COMMIT_FILE_MAX_BYTES, COMMIT_MAX_FILES, COMMIT_TOTAL_MAX_BYTES, classifyBranch, commitForm, reconcileScript, validateFiles, type FileChange } from "./commitPlan.js";
import { encodeRepoPath, validateRef, validateSha } from "./refs.js";
import { get, profileArg, profileProp, repoSlugArg, repoSlugProp, resolveRepo, str } from "./shared.js";

export const COMMIT_PREVIEW_TTL_MS = 15 * 60_000;
const MAX_PENDING_PREVIEWS = 50;

type Plan = {
  previewId: string;
  repoSlug: string;
  branch: string;
  kind: "isolated" | "shared";
  newBranch: boolean;
  parent: string;
  message: string;
  author?: string;
  files: FileChange[];
  digest: string;
  expiresAt: string;
};

// Process-wide on purpose: a preview must be appliable from a later call, and
// a token must not survive a restart (the secret is never persisted).
const SECRET = generateApprovalSecret();
const pending = new Map<string, Plan>();

export function buildCommitFilesTools(
  config: BitbucketConfig,
  client: BitbucketClient
): { reads: readonly AnyToolDefinition[]; writes: readonly AnyToolDefinition[] } {
  const previewTool = defineTool({
    name: "commit_files_preview",
    description:
      "Plan ONE commit on a branch from text files (add/modify) and deletions — server-side, so no local index is involved and no one else's staged work can be swept in. Checks the branch is allowlisted (BITBUCKET_COMMIT_BRANCHES, or BITBUCKET_COMMIT_SHARED_BRANCHES for a branch checked out in a shared worktree), that `parent` IS the branch head (no force, ever — the repo has no server-side protection, so this check is the guard), and what each path does. Returns previewId + approvalToken for commit_files_apply (15 minutes, single use). Changes nothing; works with commits disabled.",
    input: z
      .object({
        repoSlug: repoSlugArg,
        branch: z.string().min(1).max(256),
        parent: z.string().min(7).max(40),
        message: z.string().min(1).max(65_536),
        author: z.string().regex(/^[^<>\n]+ <[^<>\s]+@[^<>\s]+>$/).max(256).optional(),
        files: z
          .array(
            z
              .object({ path: z.string().min(1).max(1024), content: z.string().optional(), delete: z.literal(true).optional() })
              .strict()
          )
          .min(1)
          .max(COMMIT_MAX_FILES),
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object(
      {
        repoSlug: repoSlugProp,
        branch: schema.string("Branch to commit on; created from `parent` if it does not exist (non-shared branches only)"),
        parent: schema.string("The commit you built on. Must be the branch head now"),
        message: schema.string("Commit message"),
        author: schema.string('Optional "Name <email>" (default: the token\'s user)'),
        files: schema.array(
          schema.object(
            {
              path: schema.string("Repo-relative path"),
              content: schema.string("Full new text content (add or modify)"),
              delete: schema.boolean("true to delete the path (omit content)")
            },
            { required: ["path"] }
          ),
          `Up to ${String(COMMIT_MAX_FILES)} changes; text only, ${String(COMMIT_FILE_MAX_BYTES / 1024)} KiB per file, ${String(COMMIT_TOTAL_MAX_BYTES / 1024)} KiB total`,
          { minItems: 1, maxItems: COMMIT_MAX_FILES }
        ),
        profile: profileProp
      },
      { required: ["branch", "parent", "message", "files"] }
    ),
    annotations: { readOnly: true, idempotent: false, destructive: false, openWorld: true },
    handler: async (args) => {
      const repoSlug = resolveRepo(config, args.repoSlug);
      const branch = validateRef(args.branch);
      const files = validateFiles(args.files);
      const kind = classifyBranch(config, repoSlug, branch);

      const parentCommit = await client.getCommit(repoSlug, validateSha(args.parent), "hash");
      const parent = str(parentCommit.hash) ?? args.parent;
      const head = await branchHead(client, repoSlug, branch);
      if (head === null && kind === "shared") {
        throw new PolicyViolationError("branch_not_found", `${branch} does not exist in ${repoSlug}; a shared branch is never created by commit_files.`);
      }
      if (head !== null && head !== parent) {
        throw parentNotHead(branch, head, parent);
      }

      const changes: Record<string, unknown>[] = [];
      for (const f of files) {
        changes.push({ path: f.path, ...(await describeChange(client, repoSlug, parent, f)) });
      }
      if (changes.every((c) => c.action === "unchanged")) {
        throw new PolicyViolationError("no_changes", "Every file already has this content at the parent; there is nothing to commit.");
      }

      prune();
      const previewId = randomUUID();
      const expiresAt = new Date(Date.now() + COMMIT_PREVIEW_TTL_MS).toISOString();
      const plan: Plan = {
        previewId, repoSlug, branch, kind, newBranch: head === null, parent,
        message: args.message, author: args.author, files, digest: "", expiresAt
      };
      plan.digest = digestOf(plan);
      pending.set(previewId, plan);

      return ok({
        workspace: config.workspace,
        repoSlug,
        branch,
        branchKind: kind,
        newBranch: plan.newBranch,
        parent,
        message: args.message,
        changes,
        previewId,
        approvalToken: issuePreviewToken({ previewId, digest: plan.digest, expiresAt }, SECRET),
        expiresAt,
        note:
          kind === "shared"
            ? "A shared branch: after apply, the shared worktree must run the returned reconcile script before anyone commits locally."
            : "Not checked out locally: merge it through a pull request."
      });
    }
  });

  const applyTool = defineTool({
    name: "commit_files_apply",
    description:
      "Create the commit a commit_files_preview planned, from its previewId + approvalToken — the exact previewed content, nothing else. Re-checks that the parent is still the branch head, and Bitbucket asserts it again (refusing with 400/409). Never forces. Disabled unless BITBUCKET_COMMIT_ENABLED=true. For a shared branch the result includes a reconcile script for the local worktree: it refuses unless local HEAD is still the parent and every committed path matches, then moves the branch and resets only those index entries, leaving everyone else's staged work alone.",
    input: z
      .object({ previewId: z.string().min(1).max(128), approvalToken: z.string().min(1).max(4096), profile: profileArg })
      .strict(),
    inputSchema: schema.object(
      {
        previewId: schema.string("From commit_files_preview"),
        approvalToken: schema.string("From commit_files_preview"),
        profile: profileProp
      },
      { required: ["previewId", "approvalToken"] }
    ),
    annotations: annotations.create(),
    handler: async (args) => {
      if (!config.commitEnabled) {
        throw new PolicyViolationError(
          "COMMIT_DISABLED",
          "Creating commits is disabled. Set BITBUCKET_COMMIT_ENABLED=true to enable; commit_files_preview still works."
        );
      }
      const plan = pending.get(args.previewId);
      if (!plan) {
        throw new PolicyViolationError(
          "preview_not_found",
          "No pending preview with that previewId — it expired, was already applied, or the server restarted. Run commit_files_preview again."
        );
      }
      const verdict = verifyPreviewToken(
        args.approvalToken,
        { previewId: plan.previewId, digest: plan.digest, expiresAt: plan.expiresAt },
        SECRET
      );
      if (!verdict.ok) {
        const rejection = describePreviewTokenRejection(verdict.reason);
        throw new PolicyViolationError(rejection.code, rejection.message);
      }
      // Single use from here on, whatever happens next.
      pending.delete(plan.previewId);
      classifyBranch(config, plan.repoSlug, plan.branch);

      const head = await branchHead(client, plan.repoSlug, plan.branch);
      if (plan.newBranch ? head !== null : head !== plan.parent) {
        throw parentNotHead(plan.branch, head, plan.parent);
      }

      let outcome;
      try {
        outcome = await client.createCommit(plan.repoSlug, commitForm(plan));
      } catch (error) {
        if (isParentRefusal(error)) {
          throw new PolicyViolationError(
            "parent_not_head",
            `Bitbucket refused the commit (${String(error.status)}): ${plan.branch} moved after the check, so ${plan.parent} is no longer its head. Nothing was written. Rebuild on the new head and preview again.`
          );
        }
        throw error;
      }

      const newSha = /\/commit\/([0-9a-f]{40})\b/i.exec(outcome.location ?? "")?.[1] ?? (await branchHead(client, plan.repoSlug, plan.branch));
      // Belt and braces: prove the new commit sits on the parent we asserted.
      const created = newSha ? await client.getCommit(plan.repoSlug, newSha, "hash,parents.hash") : {};
      const parents = Array.isArray(created.parents) ? created.parents.map((p) => str(get(p, "hash"))) : [];
      const parentVerified = parents.length === 1 && parents[0] === plan.parent;

      return ok({
        workspace: config.workspace,
        repoSlug: plan.repoSlug,
        branch: plan.branch,
        branchKind: plan.kind,
        committed: true,
        newSha,
        parent: plan.parent,
        parentVerified,
        warning: parentVerified ? undefined : "The new commit's parent is not the asserted one — inspect the branch before doing anything else.",
        files: plan.files.map((f) => ({ path: f.path, action: f.delete ? "delete" : "write" })),
        reconcile: plan.kind === "shared" && newSha ? reconcileScript(plan, newSha) : undefined,
        next: plan.kind === "isolated" ? "Open a pull request from this branch (create_pull_request)." : undefined
      });
    }
  });

  // The branch tools share this group's allowlist and scope (write:repository),
  // so they register with it: commit onto a fresh scratch branch, PR, delete.
  return { reads: [previewTool], writes: [applyTool, ...buildBranchTools(config, client)] };
}

// --- upstream helpers ------------------------------------------------------------

async function branchHead(client: BitbucketClient, repoSlug: string, branch: string): Promise<string | null> {
  try {
    return str(get(await client.getBranch(repoSlug, branch), "target", "hash"));
  } catch (error) {
    if (error instanceof BitbucketHttpError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Bitbucket's own parent assertion. Documented as 409; verified live on
 * 2026-10-13 it answers **400** with "The parent commit specified (…) is not
 * the head of branch …" and writes nothing. Both are taken as the refusal.
 */
function isParentRefusal(error: unknown): error is BitbucketHttpError {
  return (
    error instanceof BitbucketHttpError &&
    (error.status === 409 || (error.status === 400 && /is not the head of branch/i.test(error.detail ?? "")))
  );
}

function parentNotHead(branch: string, head: string | null, parent: string): PolicyViolationError {
  return new PolicyViolationError(
    "parent_not_head",
    head === null
      ? `${branch} no longer exists, so ${parent} cannot be its head. Preview again.`
      : `${branch} is at ${head}, not ${parent}. Someone committed in between: rebuild your change on ${head} and preview again. commit_files never forces.`
  );
}

async function describeChange(
  client: BitbucketClient,
  repoSlug: string,
  parent: string,
  f: FileChange
): Promise<Record<string, unknown>> {
  const encoded = encodeRepoPath(f.path);
  let meta: Record<string, unknown> | null;
  try {
    meta = await client.getSrcMeta(repoSlug, parent, encoded);
  } catch (error) {
    if (!(error instanceof BitbucketHttpError && error.status === 404)) {
      throw error;
    }
    meta = null;
  }
  if (meta && str(meta.type) === "commit_directory") {
    throw new PolicyViolationError("path_is_directory", `"${f.path}" is a directory at the parent.`);
  }
  if (f.delete) {
    if (!meta) {
      throw new PolicyViolationError("delete_missing", `"${f.path}" does not exist at the parent; nothing to delete.`);
    }
    return { action: "delete", bytesBefore: meta.size ?? null };
  }
  const bytes = Buffer.byteLength(f.content ?? "", "utf8");
  if (!meta) {
    return { action: "add", bytes };
  }
  const current = await client.getSrcBounded(repoSlug, parent, encoded, COMMIT_FILE_MAX_BYTES + 1);
  return { action: !current.truncated && current.text === f.content ? "unchanged" : "modify", bytes, bytesBefore: meta.size ?? null };
}

function digestOf(plan: Plan): string {
  const canonical = JSON.stringify({
    repoSlug: plan.repoSlug, branch: plan.branch, newBranch: plan.newBranch, parent: plan.parent,
    message: plan.message, author: plan.author ?? null,
    files: [...plan.files].sort((a, b) => (a.path < b.path ? -1 : 1))
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function prune(): void {
  const now = Date.now();
  for (const [id, plan] of pending) {
    if (Date.parse(plan.expiresAt) <= now) {
      pending.delete(id);
    }
  }
  // Oldest first (Map keeps insertion order): a flood of previews cannot grow memory.
  while (pending.size >= MAX_PENDING_PREVIEWS) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    pending.delete(oldest);
  }
}
