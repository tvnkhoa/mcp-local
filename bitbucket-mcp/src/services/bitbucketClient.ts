import type { BitbucketConfig } from "../config/index.js";
import { BitbucketHttpError } from "../middleware/errors.js";
import type { BoundedText } from "./boundedBody.js";
import { qs, type ListParams } from "./bitbucketTransport.js";
import { BitbucketWrites } from "./bitbucketWrites.js";
import { rangeStartOffset } from "./httpRange.js";

import { encodePathSegment as enc } from "@mcp/shared";

export type { ListParams } from "./bitbucketTransport.js";
export type { BoundedText } from "./boundedBody.js";
export type { CreatePullRequestBody } from "./bitbucketWrites.js";

/** A Bitbucket Cloud paginated collection response. */
export type Paginated<T = Record<string, unknown>> = {
  values?: T[];
  page?: number;
  pagelen?: number;
  size?: number;
  next?: string;
  previous?: string;
  [key: string]: unknown;
};

export type ListReposParams = ListParams & {
  /** owner | admin | contributor | member — filters to repos where you have that role. */
  role?: string;
};

export type ListPullRequestsParams = ListParams & {
  /** OPEN | MERGED | DECLINED | SUPERSEDED (Bitbucket accepts repeats; we send one). */
  state?: string;
};

/**
 * Pipelines do NOT filter like the other collections. Verified live on 2026-08-21:
 * the endpoint **ignores `q` entirely** (even `q=totally_not_a_field="zzz"` returns every
 * run). It filters by `target.branch` and a repeatable `status` (repeats are ORed; a
 * comma-separated list matches nothing). So there is deliberately no `q`: it would be a no-op.
 */
export type ListPipelinesParams = {
  sort?: string;
  page?: number;
  pagelen?: number;
  /** Sent as `target.branch`. */
  branch?: string;
  /** Sent as one repeated `status` parameter per entry. */
  status?: readonly string[];
};

/**
 * Where to resume a cursor-paged collection. `/commits`, `/src` directory
 * listings and `/filehistory` do not page by a plain integer: verified live on
 * 2026-10-13, `/commits` pages with `page=2&ctx=<hash>` and a directory listing
 * with an opaque `page=E8Ux`. Only these two values are carried — the absolute
 * `next` URL is never followed, so a changed host can never receive our auth.
 * `skip` is the tool layer's: entries of that page already returned (never sent).
 */
export type Cursor = { page: string; ctx?: string; skip?: number };

export type CursorParams = { cursor?: Cursor; pagelen?: number; fields?: string };

export type ListCommitsParams = CursorParams & {
  include?: readonly string[];
  exclude?: readonly string[];
  path?: string;
};

/**
 * Thin HTTP client for the Bitbucket Cloud REST API v2.0 — the endpoint
 * catalogue. How a request is made (auth, timeout, retries, bounded reads) is
 * `BitbucketTransport`; every write endpoint is inherited from `BitbucketWrites`.
 * Non-2xx responses raise BitbucketHttpError.
 */
export class BitbucketClient extends BitbucketWrites {
  constructor(config: BitbucketConfig) {
    super(config);
  }

  // --- repositories --------------------------------------------------------

  /** GET /repositories/{workspace} — list repositories in the workspace. */
  listRepositories(params: ListReposParams = {}): Promise<Paginated> {
    const query = this.http.listQuery(params);
    if (params.role) {
      query.set("role", params.role);
    }
    return this.http.get<Paginated>(`/repositories/${enc(this.http.workspace)}${qs(query)}`);
  }

  /** GET /repositories/{workspace}/{repo_slug} — repository metadata. */
  getRepository(repoSlug: string): Promise<Record<string, unknown>> {
    return this.http.get<Record<string, unknown>>(this.http.repoBase(repoSlug));
  }

  /** GET .../refs/branches — list branches. */
  listBranches(repoSlug: string, params: ListParams = {}): Promise<Paginated> {
    const query = this.http.listQuery(params);
    return this.http.get<Paginated>(`${this.http.repoBase(repoSlug)}/refs/branches${qs(query)}`);
  }

  /** GET .../refs/branches/{name} — one branch (its `target.hash` is the head SHA). */
  getBranch(repoSlug: string, name: string): Promise<Record<string, unknown>> {
    return this.http.get(`${this.http.repoBase(repoSlug)}/refs/branches/${enc(name)}?fields=name,target.hash`);
  }

  /** GET .../refs/tags/{name} — one tag. */
  getTag(repoSlug: string, name: string): Promise<Record<string, unknown>> {
    return this.http.get(`${this.http.repoBase(repoSlug)}/refs/tags/${enc(name)}?fields=name,target.hash`);
  }

  // --- pull requests -------------------------------------------------------

  /** GET .../pullrequests — list PRs (default OPEN). */
  listPullRequests(repoSlug: string, params: ListPullRequestsParams = {}): Promise<Paginated> {
    const query = this.http.listQuery(params);
    if (params.state) {
      query.set("state", params.state);
    }
    return this.http.get<Paginated>(`${this.http.repoBase(repoSlug)}/pullrequests${qs(query)}`);
  }

  /** GET .../pullrequests/{id} — a single PR. */
  getPullRequest(repoSlug: string, id: number): Promise<Record<string, unknown>> {
    return this.http.get<Record<string, unknown>>(`${this.http.repoBase(repoSlug)}/pullrequests/${id}`);
  }

  /** GET .../pullrequests/{id}/diff — raw unified diff (text). */
  getPullRequestDiff(repoSlug: string, id: number): Promise<string> {
    return this.http.getText(`${this.http.repoBase(repoSlug)}/pullrequests/${id}/diff`);
  }

  /** GET .../pullrequests/{id}/comments — one page of a PR's comments, oldest first. */
  listPullRequestComments(repoSlug: string, id: number, params: ListParams = {}): Promise<Paginated> {
    const query = this.http.listQuery({ ...params, sort: params.sort ?? "created_on" });
    return this.http.get<Paginated>(`${this.http.repoBase(repoSlug)}/pullrequests/${id}/comments${qs(query)}`);
  }

  // --- commits and refs comparison -----------------------------------------

  /** GET .../commits — commits reachable from `include` and not from `exclude`, newest first. */
  listCommits(repoSlug: string, params: ListCommitsParams = {}): Promise<Paginated> {
    const query = cursorQuery(this.http.listQuery({ pagelen: params.pagelen }), params);
    // append, not set — the endpoint takes repeated include/exclude parameters.
    for (const ref of params.include ?? []) {
      query.append("include", ref);
    }
    for (const ref of params.exclude ?? []) {
      query.append("exclude", ref);
    }
    if (params.path) {
      query.set("path", params.path);
    }
    return this.http.get<Paginated>(`${this.http.repoBase(repoSlug)}/commits${qs(query)}`);
  }

  /** GET .../commit/{sha} — one commit. */
  getCommit(repoSlug: string, sha: string, fields?: string): Promise<Record<string, unknown>> {
    const query = new URLSearchParams();
    if (fields) {
      query.set("fields", fields);
    }
    return this.http.get(`${this.http.repoBase(repoSlug)}/commit/${enc(sha)}${qs(query)}`);
  }

  /**
   * GET .../diffstat/{spec} — per-file line counts. `spec` is a single SHA (that
   * commit against its first parent) or `x..y`, where Bitbucket's `x` is the
   * NEW side — see `buildCompareSpec` in tools/refs.ts.
   */
  getDiffstat(
    repoSlug: string,
    spec: string,
    params: { page?: number; pagelen?: number; paths?: readonly string[] } = {}
  ): Promise<Paginated> {
    const query = this.http.listQuery(params);
    query.set("fields", "size,page,next,values.status,values.lines_added,values.lines_removed,values.old.path,values.new.path");
    appendPaths(query, params.paths);
    return this.http.get<Paginated>(`${this.http.repoBase(repoSlug)}/diffstat/${spec}${qs(query)}`);
  }

  /** GET .../merge-base/{spec} — the best common ancestor of the two sides. */
  getMergeBase(repoSlug: string, spec: string): Promise<Record<string, unknown>> {
    return this.http.get(`${this.http.repoBase(repoSlug)}/merge-base/${spec}?fields=hash,date`);
  }

  /** GET .../diff/{spec} — unified diff as text, read up to `maxBytes`. */
  getDiffBounded(repoSlug: string, spec: string, maxBytes: number, paths?: readonly string[]): Promise<BoundedText> {
    const query = new URLSearchParams();
    appendPaths(query, paths);
    return this.http.getTextBounded(`${this.http.repoBase(repoSlug)}/diff/${spec}${qs(query)}`, maxBytes);
  }

  /** GET .../commit/{sha}/statuses — build statuses reported against a commit (any CI). */
  listCommitStatuses(repoSlug: string, sha: string, params: ListParams = {}): Promise<Paginated> {
    const query = this.http.listQuery(params);
    return this.http.get<Paginated>(`${this.http.repoBase(repoSlug)}/commit/${enc(sha)}/statuses${qs(query)}`);
  }

  // --- source --------------------------------------------------------------
  // `encodedPath` is already segment-encoded by the tool layer (encodeRepoPath):
  // a single `enc` would turn every `/` into `%2F` and break nested paths.

  /** GET .../src/{sha}/{path}?format=meta — type (file/directory), size, attributes. */
  getSrcMeta(repoSlug: string, sha: string, encodedPath: string): Promise<Record<string, unknown>> {
    return this.http.get(`${this.http.repoBase(repoSlug)}/src/${enc(sha)}/${encodedPath}?format=meta`);
  }

  /** GET .../src/{sha}/{path}/ — one page of a directory listing. */
  listSrcDir(repoSlug: string, sha: string, encodedPath: string, params: CursorParams = {}): Promise<Paginated> {
    const query = cursorQuery(this.http.listQuery({ pagelen: params.pagelen }), params);
    const dir = encodedPath ? `${encodedPath}/` : "";
    return this.http.get<Paginated>(`${this.http.repoBase(repoSlug)}/src/${enc(sha)}/${dir}${qs(query)}`);
  }

  /**
   * GET .../src/{sha}/{path}?format=raw — file content, read up to `maxBytes`.
   *
   * `format=raw` is load-bearing. Verified live on 2026-10-13 with an Atlassian
   * API token (Basic): the bare `/src/{sha}/{path}` answers **403 Forbidden** for
   * every file, whatever the Accept header, while `?format=meta` and
   * `?format=raw` on the same path answer 200.
   */
  getSrcBounded(repoSlug: string, sha: string, encodedPath: string, maxBytes: number): Promise<BoundedText> {
    return this.http.getTextBounded(
      `${this.http.repoBase(repoSlug)}/src/${enc(sha)}/${encodedPath}?format=raw`,
      maxBytes
    );
  }

  /** GET .../filehistory/{sha}/{path} — commits that changed a file, following renames. */
  listFileHistory(repoSlug: string, sha: string, encodedPath: string, params: CursorParams = {}): Promise<Paginated> {
    const query = cursorQuery(this.http.listQuery({ pagelen: params.pagelen }), params);
    return this.http.get<Paginated>(
      `${this.http.repoBase(repoSlug)}/filehistory/${enc(sha)}/${encodedPath}${qs(query)}`
    );
  }

  /** GET /workspaces/{workspace}/search/code — code search over default branches. */
  searchCode(searchQuery: string, params: { page?: number; pagelen?: number } = {}): Promise<Paginated> {
    const query = this.http.listQuery(params);
    query.set("search_query", searchQuery);
    return this.http.get<Paginated>(`${this.http.workspaceBase()}/search/code${qs(query)}`);
  }

  // --- pipelines -----------------------------------------------------------

  /** GET .../pipelines — list pipeline runs. */
  listPipelines(repoSlug: string, params: ListPipelinesParams = {}): Promise<Paginated> {
    // No `q`: see ListPipelinesParams for why this endpoint is the odd one out.
    const query = this.http.listQuery({
      sort: params.sort,
      page: params.page,
      pagelen: params.pagelen
    });
    if (params.branch) {
      query.set("target.branch", params.branch);
    }
    for (const status of params.status ?? []) {
      // append, not set — repeated parameters are how this endpoint says OR.
      query.append("status", status);
    }
    return this.http.get<Paginated>(`${this.http.repoBase(repoSlug)}/pipelines${qs(query)}`);
  }

  /**
   * GET .../pipelines/{pipeline_ref} — one run.
   *
   * `pipelineRef` is already normalized by the tool layer to either a braced
   * UUID or a build number; `enc` percent-encodes the braces.
   */
  getPipeline(repoSlug: string, pipelineRef: string): Promise<Record<string, unknown>> {
    return this.http.get<Record<string, unknown>>(
      `${this.http.repoBase(repoSlug)}/pipelines/${enc(pipelineRef)}`
    );
  }

  /** GET .../pipelines/{pipeline_ref}/steps — the steps of one run. */
  listPipelineSteps(repoSlug: string, pipelineRef: string, params: ListParams = {}): Promise<Paginated> {
    const query = this.http.listQuery(params);
    return this.http.get<Paginated>(
      `${this.http.repoBase(repoSlug)}/pipelines/${enc(pipelineRef)}/steps${qs(query)}`
    );
  }

  /**
   * GET .../pipelines/{pipeline_ref}/steps/{step_uuid}/log — the step's log, as text.
   *
   * A build log can be tens of megabytes, so this asks for a *suffix range* —
   * the last `maxBytes` bytes, which is where a failure is. Bitbucket answers
   * 206 with the tail; a server that ignores `Range` answers 200 with the whole
   * log, which the tool layer then truncates, so the bound holds either way.
   */
  async getPipelineStepLog(
    repoSlug: string,
    pipelineRef: string,
    stepUuid: string,
    maxBytes: number
  ): Promise<{ text: string; partial: boolean }> {
    const path =
      `${this.http.repoBase(repoSlug)}` +
      `/pipelines/${enc(pipelineRef)}/steps/${enc(stepUuid)}/log`;
    const accept = "text/plain, */*";
    let result;
    try {
      result = await this.http.attemptWithRetries("GET", path, undefined, accept, {
        Range: `bytes=-${String(Math.floor(maxBytes))}`
      });
    } catch (error) {
      // A suffix range against a zero-length log is unsatisfiable (416), and a
      // 4xx is never retried. An empty log is an empty log, not a failure.
      if (error instanceof BitbucketHttpError && error.status === 416) {
        result = await this.http.attemptWithRetries("GET", path, undefined, accept);
      } else {
        throw error;
      }
    }

    // `206` alone does NOT mean the body was cut. A suffix range wider than the
    // log is satisfied by returning the whole log — still 206, but with
    // `Content-Range: bytes 0-9032/9033`. Verified against a real 9 KB step log:
    // the default 256 KiB request answers 206 at offset 0. Reading 206 as "cut"
    // therefore deleted the genuine first line of every log smaller than
    // maxBytes, which is the common case. The start offset is the only proof.
    return { text: result.body, partial: rangeStartOffset(result.contentRange) > 0 };
  }
}

/**
 * Repeated `path` parameters. Verified live on 2026-10-13: diffstat and diff
 * match each one as an exact FILE path — a directory matches nothing, and `q`
 * is ignored — so directory filtering is done by the caller.
 */
function appendPaths(query: URLSearchParams, paths: readonly string[] | undefined): void {
  for (const path of paths ?? []) {
    query.append("path", path);
  }
}

/** Add `fields` and a resume cursor (`page`, plus `ctx` when the endpoint uses one). */
function cursorQuery(query: URLSearchParams, params: CursorParams): URLSearchParams {
  if (params.fields) {
    query.set("fields", params.fields);
  }
  if (params.cursor) {
    query.set("page", params.cursor.page);
    if (params.cursor.ctx) {
      query.set("ctx", params.cursor.ctx);
    }
  }
  return query;
}
