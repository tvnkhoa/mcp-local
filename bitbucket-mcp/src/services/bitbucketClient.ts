import type { BitbucketConfig } from "../config/index.js";
import { BitbucketHttpError } from "../middleware/errors.js";
import { rangeStartOffset, type HttpOutcome } from "./httpRange.js";

import {
  backoffFromSchedule,
  defaultSleep as sleep,
  encodePathSegment as enc,
  isTransientUpstreamStatus,
  truncateForLog as truncate
} from "@mcp/shared";

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

export type ListParams = {
  q?: string;
  sort?: string;
  page?: number;
  pagelen?: number;
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
 * Pipelines do NOT filter like the other collections.
 *
 * Verified against the live API on 2026-08-21: the pipelines endpoint **ignores
 * `q` entirely** — `q=build_number > 3` and even `q=totally_not_a_field="zzz"`
 * both return every run with no error. Filtering is by dedicated parameters
 * instead: `target.branch`, and a `status` that may repeat (Bitbucket ORs the
 * repeats; a comma-separated list matches nothing).
 *
 * So this type deliberately has no `q`. Advertising one would advertise a no-op.
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

export type CreatePullRequestBody = {
  title: string;
  description?: string;
  source: { branch: { name: string } };
  destination?: { branch: { name: string } };
  close_source_branch?: boolean;
  reviewers?: Array<{ uuid?: string; account_id?: string }>;
};

/**
 * Thin HTTP client for the Bitbucket Cloud REST API v2.0. Uses the global `fetch`
 * (undici) — no extra dependencies. All auth lives in the Authorization header and
 * is never logged. Non-2xx responses raise BitbucketHttpError with the body as detail.
 */
export class BitbucketClient {
  private readonly config: BitbucketConfig;

  constructor(config: BitbucketConfig) {
    this.config = config;
  }

  // --- repositories --------------------------------------------------------

  /** GET /repositories/{workspace} — list repositories in the workspace. */
  listRepositories(params: ListReposParams = {}): Promise<Paginated> {
    const query = this.listQuery(params);
    if (params.role) {
      query.set("role", params.role);
    }
    return this.get<Paginated>(`/repositories/${enc(this.config.workspace)}${qs(query)}`);
  }

  /** GET /repositories/{workspace}/{repo_slug} — repository metadata. */
  getRepository(repoSlug: string): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>(`/repositories/${enc(this.config.workspace)}/${enc(repoSlug)}`);
  }

  /** GET /repositories/{workspace}/{repo_slug}/refs/branches — list branches. */
  listBranches(repoSlug: string, params: ListParams = {}): Promise<Paginated> {
    const query = this.listQuery(params);
    return this.get<Paginated>(
      `/repositories/${enc(this.config.workspace)}/${enc(repoSlug)}/refs/branches${qs(query)}`
    );
  }

  // --- pull requests -------------------------------------------------------

  /** GET /repositories/{workspace}/{repo_slug}/pullrequests — list PRs (default OPEN). */
  listPullRequests(repoSlug: string, params: ListPullRequestsParams = {}): Promise<Paginated> {
    const query = this.listQuery(params);
    if (params.state) {
      query.set("state", params.state);
    }
    return this.get<Paginated>(
      `/repositories/${enc(this.config.workspace)}/${enc(repoSlug)}/pullrequests${qs(query)}`
    );
  }

  /** GET /repositories/{workspace}/{repo_slug}/pullrequests/{id} — a single PR. */
  getPullRequest(repoSlug: string, id: number): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>(
      `/repositories/${enc(this.config.workspace)}/${enc(repoSlug)}/pullrequests/${id}`
    );
  }

  /** GET /repositories/{workspace}/{repo_slug}/pullrequests/{id}/diff — raw unified diff (text). */
  getPullRequestDiff(repoSlug: string, id: number): Promise<string> {
    return this.getText(
      `/repositories/${enc(this.config.workspace)}/${enc(repoSlug)}/pullrequests/${id}/diff`
    );
  }

  /** Relative path of the create-PR endpoint (also used to render dry-run previews). */
  createPullRequestPath(repoSlug: string): string {
    return `/repositories/${enc(this.config.workspace)}/${enc(repoSlug)}/pullrequests`;
  }

  /** POST /repositories/{workspace}/{repo_slug}/pullrequests — create a pull request. */
  createPullRequest(repoSlug: string, body: CreatePullRequestBody): Promise<Record<string, unknown>> {
    return this.post<Record<string, unknown>>(this.createPullRequestPath(repoSlug), body);
  }

  // --- pipelines -----------------------------------------------------------

  /** GET /repositories/{workspace}/{repo_slug}/pipelines — list pipeline runs. */
  listPipelines(repoSlug: string, params: ListPipelinesParams = {}): Promise<Paginated> {
    // No `q`: see ListPipelinesParams for why this endpoint is the odd one out.
    const query = this.listQuery({
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
    return this.get<Paginated>(
      `/repositories/${enc(this.config.workspace)}/${enc(repoSlug)}/pipelines${qs(query)}`
    );
  }

  /**
   * GET /repositories/{workspace}/{repo_slug}/pipelines/{pipeline_ref} — one run.
   *
   * `pipelineRef` is already normalized by the tool layer to either a braced
   * UUID or a build number; `enc` percent-encodes the braces.
   */
  getPipeline(repoSlug: string, pipelineRef: string): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>(
      `/repositories/${enc(this.config.workspace)}/${enc(repoSlug)}/pipelines/${enc(pipelineRef)}`
    );
  }

  /** GET .../pipelines/{pipeline_ref}/steps — the steps of one run. */
  listPipelineSteps(
    repoSlug: string,
    pipelineRef: string,
    params: ListParams = {}
  ): Promise<Paginated> {
    const query = this.listQuery(params);
    return this.get<Paginated>(
      `/repositories/${enc(this.config.workspace)}/${enc(repoSlug)}/pipelines/${enc(pipelineRef)}/steps${qs(query)}`
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
      `/repositories/${enc(this.config.workspace)}/${enc(repoSlug)}` +
      `/pipelines/${enc(pipelineRef)}/steps/${enc(stepUuid)}/log`;
    const accept = "text/plain, */*";
    let result;
    try {
      result = await this.attemptWithRetries("GET", path, undefined, accept, {
        Range: `bytes=-${String(Math.floor(maxBytes))}`
      });
    } catch (error) {
      // A suffix range against a zero-length log is unsatisfiable (416), and a
      // 4xx is never retried. An empty log is an empty log, not a failure.
      if (error instanceof BitbucketHttpError && error.status === 416) {
        result = await this.attemptWithRetries("GET", path, undefined, accept);
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

  // --- transport -----------------------------------------------------------

  private get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  private post<T>(path: string, jsonBody: unknown): Promise<T> {
    return this.request<T>("POST", path, jsonBody);
  }

  /** Build a clamped list query (page/pagelen/q/sort) shared by all collection endpoints. */
  private listQuery(params: ListParams): URLSearchParams {
    const query = new URLSearchParams();
    if (params.q) {
      query.set("q", params.q);
    }
    if (params.sort) {
      query.set("sort", params.sort);
    }
    if (params.page && Number.isFinite(params.page) && params.page > 0) {
      query.set("page", String(Math.floor(params.page)));
    }
    const pagelen = clampPagelen(params.pagelen, this.config);
    query.set("pagelen", String(pagelen));
    return query;
  }

  /** JSON request with retry + timeout. */
  private async request<T>(method: "GET" | "POST", path: string, jsonBody?: unknown): Promise<T> {
    const { status, body } = await this.attemptWithRetries(method, path, jsonBody, "application/json");
    if (!body) {
      return {} as T;
    }
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new BitbucketHttpError(status, "Bitbucket returned a non-JSON response.", truncate(body, 500));
    }
  }

  /** Text request (e.g. the PR diff endpoint returns text/plain, not JSON). */
  private async getText(path: string): Promise<string> {
    const { body } = await this.attemptWithRetries("GET", path, undefined, "text/plain, */*");
    return body;
  }

  private async attemptWithRetries(
    method: "GET" | "POST",
    path: string,
    jsonBody: unknown,
    accept: string,
    extraHeaders?: Record<string, string>
  ): Promise<HttpOutcome> {
    // Retry transient failures with exponential backoff. Which failures are
    // retryable depends on the method (see isRetryable): idempotent GETs retry
    // on network/5xx/429, but a create-PR POST only retries on 429 so a blip
    // after the write was accepted can't open a duplicate pull request. A
    // timeout (AbortError) and any 4xx are never retried.
    const maxRetries = this.config.maxRetries;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.attempt(method, path, jsonBody, accept, extraHeaders);
      } catch (error) {
        lastError = error;
        if (attempt >= maxRetries || !isRetryable(error, method)) {
          throw error;
        }
        await sleep(backoffFromSchedule(attempt));
      }
    }
    throw lastError;
  }

  private async attempt(
    method: "GET" | "POST",
    path: string,
    jsonBody: unknown,
    accept: string,
    extraHeaders?: Record<string, string>
  ): Promise<HttpOutcome> {
    const url = `${this.config.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    // The timeout must cover the body read too — a server can send headers and
    // then stall the body — so clearTimeout only fires once we are fully done.
    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            // First, so no caller-supplied header can shadow Authorization or
            // Accept. Today the only extra header is Range on a step log.
            ...(extraHeaders ?? {}),
            Authorization: this.config.authHeader,
            Accept: accept,
            ...(jsonBody !== undefined ? { "Content-Type": "application/json" } : {})
          },
          body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
          signal: controller.signal
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }
        throw new BitbucketHttpError(0, `Failed to reach Bitbucket at ${this.config.baseUrl}.`, String(error));
      }

      const rawText = await response.text();
      if (!response.ok) {
        throw new BitbucketHttpError(
          response.status,
          `Bitbucket returned ${response.status} ${response.statusText}.`,
          truncate(rawText, 1000)
        );
      }
      return {
        status: response.status,
        body: rawText,
        contentRange: response.headers.get("content-range")
      };
    } finally {
      clearTimeout(timer);
    }
  }
}


/**
 * Transient failures worth retrying. For idempotent GETs: network unreachable
 * (status 0), 429, and any 5xx. For non-idempotent methods (the create-PR POST)
 * only 429 is retried — a 429 is rejected before processing, so a retry cannot
 * duplicate the write, whereas a 5xx or a dropped connection may mean the PR was
 * already created server-side.
 */
/**
 * Method-aware on purpose: a POST here can create a pull request, so replaying it
 * after a 5xx risks a duplicate. Only 429 (definitively "not processed") is
 * replayed for non-GET. Deliberately stricter than observe-mcp, whose POST is a
 * search.
 */
function isRetryable(error: unknown, method: "GET" | "POST"): boolean {
  if (!(error instanceof BitbucketHttpError)) {
    return false;
  }
  if (method !== "GET") {
    return error.status === 429;
  }
  return isTransientUpstreamStatus(error.status);
}

function clampPagelen(value: number | undefined, config: BitbucketConfig): number {
  if (value === undefined || !Number.isFinite(value)) {
    return config.defaultPagelen;
  }
  return Math.min(Math.max(1, Math.floor(value)), config.maxPagelen);
}


/** Render a query string with a leading `?` (empty string when there are no params). */
function qs(query: URLSearchParams): string {
  const s = query.toString();
  return s ? `?${s}` : "";
}
