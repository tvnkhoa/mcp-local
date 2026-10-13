/**
 * Every endpoint that changes state, as the base of `BitbucketClient`. Kept
 * apart so the writes are reviewable in one place, and so the client stays
 * under the 400-line cap. The public surface is the client's: tools still
 * take one `BitbucketClient`.
 *
 * Nothing here gates anything — each tool checks its own env flag before it
 * calls in. Every non-GET is retried only on 429 and never follows a redirect.
 */

import type { BitbucketConfig } from "../config/index.js";
import { BitbucketTransport } from "./bitbucketTransport.js";
import type { HttpOutcome } from "./httpRange.js";

import { encodePathSegment as enc } from "@mcp/shared";

export type CreatePullRequestBody = {
  title: string;
  description?: string;
  source: { branch: { name: string } };
  destination?: { branch: { name: string } };
  close_source_branch?: boolean;
  reviewers?: Array<{ uuid?: string; account_id?: string }>;
};

export class BitbucketWrites {
  protected readonly http: BitbucketTransport;

  constructor(config: BitbucketConfig) {
    this.http = new BitbucketTransport(config);
  }

  // --- pull requests (write:pullrequest) ---------------------------------------

  /** Relative path of the create-PR endpoint (also used to render dry-run previews). */
  createPullRequestPath(repoSlug: string): string {
    return `${this.http.repoBase(repoSlug)}/pullrequests`;
  }

  /** POST .../pullrequests — create a pull request. */
  createPullRequest(repoSlug: string, body: CreatePullRequestBody): Promise<Record<string, unknown>> {
    return this.http.post<Record<string, unknown>>(this.createPullRequestPath(repoSlug), body);
  }

  /** Relative path of the add-comment endpoint (also rendered by dry runs). */
  pullRequestCommentsPath(repoSlug: string, id: number): string {
    return `${this.http.repoBase(repoSlug)}/pullrequests/${id}/comments`;
  }

  /** POST .../pullrequests/{id}/comments — add a general, inline or reply comment. */
  addPullRequestComment(repoSlug: string, id: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.http.post(this.pullRequestCommentsPath(repoSlug, id), body);
  }

  /** Relative path of the merge endpoint (also rendered by dry runs). */
  mergePullRequestPath(repoSlug: string, id: number): string {
    return `${this.http.repoBase(repoSlug)}/pullrequests/${id}/merge`;
  }

  /** POST .../pullrequests/{id}/merge — merge with the strategy in `body`. */
  mergePullRequest(repoSlug: string, id: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.http.post(this.mergePullRequestPath(repoSlug, id), body);
  }

  // --- commits and branches (write:repository) ---------------------------------

  /**
   * POST .../src — create one commit from form fields. With an existing `branch`
   * and `parents`, Bitbucket asserts the parent is the branch head: verified live
   * on 2026-10-13 it refuses with **400** "… is not the head of branch …" (the
   * docs say 409) and writes nothing. The new commit is in `Location`.
   */
  createCommit(repoSlug: string, form: URLSearchParams): Promise<HttpOutcome> {
    return this.http.postForm(`${this.http.repoBase(repoSlug)}/src`, form);
  }

  /** Relative path of the branches endpoint (also rendered by dry runs). */
  branchesPath(repoSlug: string): string {
    return `${this.http.repoBase(repoSlug)}/refs/branches`;
  }

  /** POST .../refs/branches — a new branch pointing at `targetSha`. */
  createBranch(repoSlug: string, name: string, targetSha: string): Promise<Record<string, unknown>> {
    return this.http.post(this.branchesPath(repoSlug), { name, target: { hash: targetSha } });
  }

  /** DELETE .../refs/branches/{name} — 204, no body. */
  deleteBranch(repoSlug: string, name: string): Promise<void> {
    return this.http.delete(`${this.branchesPath(repoSlug)}/${enc(name)}`);
  }
}
