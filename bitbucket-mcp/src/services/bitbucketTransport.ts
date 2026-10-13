/**
 * HTTP transport for the Bitbucket Cloud REST API v2.0: auth header, timeout,
 * retry policy, and JSON / text / bounded-text reads.
 *
 * Split out of `bitbucketClient.ts` when the commit and source endpoints arrived:
 * the client was at 397 lines against the 400-line soft cap
 * (`packages/cli/src/guards/conventionGuard.ts`). The client keeps the endpoint
 * catalogue; everything about *how* a request is made lives here, unchanged.
 */

import type { BitbucketConfig } from "../config/index.js";
import { BitbucketHttpError } from "../middleware/errors.js";
import { readCapped, type BoundedText } from "./boundedBody.js";
import type { HttpOutcome } from "./httpRange.js";

import {
  backoffFromSchedule,
  defaultSleep as sleep,
  encodePathSegment as enc,
  isTransientUpstreamStatus,
  truncateForLog as truncate
} from "@mcp/shared";

export type HttpMethod = "GET" | "POST" | "DELETE";

export type ListParams = {
  q?: string;
  sort?: string;
  page?: number;
  pagelen?: number;
};

export class BitbucketTransport {
  private readonly config: BitbucketConfig;

  constructor(config: BitbucketConfig) {
    this.config = config;
  }

  /** `/repositories/{workspace}/{repo_slug}` — the prefix of every repo-scoped endpoint. */
  repoBase(repoSlug: string): string {
    return `/repositories/${enc(this.config.workspace)}/${enc(repoSlug)}`;
  }

  /** `/workspaces/{workspace}` — the prefix of workspace-scoped endpoints (code search). */
  workspaceBase(): string {
    return `/workspaces/${enc(this.config.workspace)}`;
  }

  get workspace(): string {
    return this.config.workspace;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, jsonBody: unknown): Promise<T> {
    return this.request<T>("POST", path, jsonBody);
  }

  /** DELETE; answers 204 with no body. Retried only on 429, like every non-GET. */
  async delete(path: string): Promise<void> {
    await this.attemptWithRetries("DELETE", path, undefined, "application/json");
  }

  /**
   * Form-encoded POST that returns the raw outcome, `Location` included — the
   * create-commit endpoint answers 201 with the new commit's URL there and
   * nothing useful in the body. Retried only on 429, like every POST.
   */
  postForm(path: string, form: URLSearchParams): Promise<HttpOutcome> {
    return this.attemptWithRetries("POST", path, form, "application/json");
  }

  /** Text request (e.g. the PR diff endpoint returns text/plain, not JSON). Unbounded. */
  async getText(path: string): Promise<string> {
    const { body } = await this.attemptWithRetries("GET", path, undefined, "text/plain, */*");
    return body;
  }

  /**
   * Text request that stops reading after `maxBytes`. The stream is cancelled at
   * the cap rather than asked for with `Range`, so the bound holds whether or not
   * the endpoint honours ranges, and a large file is never buffered whole.
   */
  async getTextBounded(path: string, maxBytes: number): Promise<BoundedText> {
    let bounded: BoundedText = { text: "", truncated: false, bytesRead: 0 };
    await this.attemptWithRetries("GET", path, undefined, "text/plain, */*", undefined, async (response) => {
      bounded = await readCapped(response, maxBytes);
      return "";
    });
    return bounded;
  }

  /** Build a clamped list query (page/pagelen/q/sort) shared by all collection endpoints. */
  listQuery(params: ListParams): URLSearchParams {
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
  private async request<T>(method: HttpMethod, path: string, jsonBody?: unknown): Promise<T> {
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

  async attemptWithRetries(
    method: HttpMethod,
    path: string,
    jsonBody: unknown,
    accept: string,
    extraHeaders?: Record<string, string>,
    readBody?: (response: Response) => Promise<string>
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
        return await this.attempt(method, path, jsonBody, accept, extraHeaders, readBody);
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
    method: HttpMethod,
    path: string,
    jsonBody: unknown,
    accept: string,
    extraHeaders?: Record<string, string>,
    readBody?: (response: Response) => Promise<string>
  ): Promise<HttpOutcome> {
    const url = `${this.config.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    // The timeout must cover the body read too — a server can send headers and
    // then stall the body — so clearTimeout only fires once we are fully done.
    try {
      // A URLSearchParams body is sent form-encoded (the create-commit endpoint);
      // anything else defined is JSON.
      const isForm = jsonBody instanceof URLSearchParams;
      const contentType = isForm
        ? "application/x-www-form-urlencoded"
        : jsonBody !== undefined
          ? "application/json"
          : undefined;
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
            ...(contentType ? { "Content-Type": contentType } : {})
          },
          body: isForm ? jsonBody.toString() : jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
          // A redirect would re-send the body and the auth header elsewhere.
          redirect: method === "GET" ? "follow" : "error",
          signal: controller.signal
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }
        throw new BitbucketHttpError(0, `Failed to reach Bitbucket at ${this.config.baseUrl}.`, String(error));
      }

      if (!response.ok) {
        // Error bodies are small JSON envelopes; read them whole but log at most 1000 chars.
        const errorText = await response.text();
        throw new BitbucketHttpError(
          response.status,
          `Bitbucket returned ${response.status} ${response.statusText}.`,
          truncate(errorText, 1000)
        );
      }
      const body = readBody ? await readBody(response) : await response.text();
      return {
        status: response.status,
        body,
        contentRange: response.headers.get("content-range"),
        location: response.headers.get("location")
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
 * already created server-side. Deliberately stricter than observe-mcp, whose
 * POST is a search.
 */
function isRetryable(error: unknown, method: HttpMethod): boolean {
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
export function qs(query: URLSearchParams): string {
  const s = query.toString();
  return s ? `?${s}` : "";
}
