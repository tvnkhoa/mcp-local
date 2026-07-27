/**
 * Retrying HTTP client.
 *
 * Mechanism for the platform's outbound-API servers: timeout, bounded retry
 * with exponential backoff and jitter, and error mapping that never echoes an
 * Authorization header. Endpoint paths, auth scheme selection, and payload
 * shapes are the calling server's concern.
 */

import type { Logger, Result } from "@mcp/core";
import {
  PlatformError,
  err,
  maskSecret,
  maskUriCredentials,
  ok,
  timeoutError,
  upstreamError
} from "@mcp/core";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/**
 * Methods safe to replay automatically. A retry after a timeout cannot know
 * whether the upstream already committed the write, so anything else must opt
 * in explicitly via `HttpRequest.idempotent`.
 */
const AUTO_RETRYABLE_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>(["GET", "HEAD", "OPTIONS"]);

export type QueryValue = string | number | boolean | undefined | null;

export interface HttpRequest {
  readonly method: HttpMethod;
  /** Path appended to `baseUrl`. A leading slash is optional. */
  readonly path: string;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** Per-request override of the client timeout. */
  readonly timeoutMs?: number;
  /** Return the raw body text instead of parsing JSON. */
  readonly raw?: boolean;
  /**
   * Opt a non-idempotent method into automatic retry. Set this only when the
   * upstream deduplicates (an idempotency key, a natural unique constraint) —
   * otherwise a retried POST can create the resource twice.
   */
  readonly idempotent?: boolean;
}

export interface HttpResponse<T> {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: T;
  /** How many retries were consumed before this response. */
  readonly attempts: number;
}

export interface HttpClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  /** Retries after the first attempt. Default 2. */
  readonly maxRetries?: number;
  /** Pre-built Authorization header value. Never logged. */
  readonly authHeader?: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly userAgent?: string;
  readonly logger?: Logger;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
  readonly sleepImpl?: (ms: number) => Promise<void>;
  readonly randomImpl?: () => number;
  /** Base backoff in ms; doubles per attempt. Default 250. */
  readonly backoffBaseMs?: number;
  readonly backoffMaxMs?: number;
}

export interface HttpClient {
  request<T = unknown>(request: HttpRequest): Promise<Result<HttpResponse<T>, PlatformError>>;
  get<T = unknown>(path: string, query?: Readonly<Record<string, QueryValue>>): Promise<Result<HttpResponse<T>, PlatformError>>;
  post<T = unknown>(path: string, body: unknown): Promise<Result<HttpResponse<T>, PlatformError>>;
  /** Non-secret description for health checks and config echo. */
  describe(): Readonly<Record<string, unknown>>;
}

const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Exponential backoff with full jitter, capped. */
export function computeBackoffMs(attempt: number, baseMs: number, maxMs: number, random: () => number): number {
  const exponential = Math.min(baseMs * 2 ** attempt, maxMs);
  return Math.floor(exponential * (0.5 + random() * 0.5));
}

function buildUrl(baseUrl: string, path: string, query?: Readonly<Record<string, QueryValue>>): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${base}${suffix}`);
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function collectHeaders(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  headers.forEach((value, key) => {
    output[key.toLowerCase()] = key.toLowerCase() === "authorization" ? maskSecret(value) : value;
  });
  return output;
}

/**
 * Map an HTTP status to a platform error.
 *
 * `retryable` is derived from the status, never from the error code's default —
 * otherwise a 404 would inherit `upstream_error`'s retryable=true and be
 * retried pointlessly.
 *
 * The upstream response body is deliberately NOT included. `details` is
 * serialized straight to the MCP client (see errors.ts), and an upstream error
 * body routinely echoes the submitted credential or carries PII. The body is
 * logged instead, where the redactor can see it.
 */
function mapStatusToError(status: number, statusText: string): PlatformError {
  const details = { status, statusText };
  const retryable = isRetryableStatus(status);

  if (status === 401 || status === 403) {
    return new PlatformError({
      code: "unauthorized",
      message: "Upstream rejected the credentials.",
      details,
      retryable: false
    });
  }
  if (status === 429) {
    return new PlatformError({
      code: "rate_limited",
      message: "Upstream rate limit reached.",
      details,
      retryable: true
    });
  }
  if (status === 404) {
    return new PlatformError({
      code: "not_found",
      message: "Upstream resource was not found.",
      details,
      retryable: false
    });
  }
  return new PlatformError({
    code: "upstream_error",
    message: `Upstream returned HTTP ${status}.`,
    details,
    retryable
  });
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  if (options.baseUrl.trim() === "") {
    throw new Error("createHttpClient: baseUrl must be a non-empty string");
  }

  const maxRetries = options.maxRetries ?? 2;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleep = options.sleepImpl ?? defaultSleep;
  const random = options.randomImpl ?? Math.random;
  const backoffBaseMs = options.backoffBaseMs ?? 250;
  const backoffMaxMs = options.backoffMaxMs ?? 8_000;
  const logger = options.logger;

  if (typeof fetchImpl !== "function") {
    throw new Error("createHttpClient: no fetch implementation available");
  }

  async function attemptOnce<T>(
    request: HttpRequest,
    attempt: number
  ): Promise<Result<HttpResponse<T>, PlatformError>> {
    const url = buildUrl(options.baseUrl, request.path, request.query);
    const timeoutMs = request.timeoutMs ?? options.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    // Precedence, lowest to highest: defaults -> client auth -> per-request.
    // The client credential must come BEFORE request.headers so a caller can
    // deliberately override it; applying it last would silently discard a
    // per-request authorization and send the wrong identity with no diagnostic.
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(options.userAgent === undefined ? {} : { "user-agent": options.userAgent }),
      ...(options.defaultHeaders ?? {}),
      ...(options.authHeader === undefined ? {} : { authorization: options.authHeader }),
      ...(request.headers ?? {})
    };
    if (request.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    try {
      const response = await fetchImpl(url, {
        method: request.method,
        headers,
        signal: controller.signal,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) })
      });

      const text = await response.text();

      if (!response.ok) {
        // Body goes to the log (redacted), never into the returned error.
        logger?.debug("http_error_body", {
          path: request.path,
          status: response.status,
          bodyPreview: text.slice(0, 512)
        });
        return err(mapStatusToError(response.status, response.statusText));
      }

      let parsed: unknown = text;
      if (request.raw !== true && text !== "") {
        try {
          parsed = JSON.parse(text);
        } catch {
          logger?.debug("http_unparseable_body", {
            path: request.path,
            status: response.status,
            bodyPreview: text.slice(0, 256)
          });
          return err(
            upstreamError("Upstream returned a body that is not valid JSON.", {
              status: response.status
            })
          );
        }
      }

      return ok({
        status: response.status,
        headers: collectHeaders(response.headers),
        body: parsed as T,
        attempts: attempt
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") {
        return err(timeoutError(`Upstream request timed out after ${timeoutMs} ms.`, { url: request.path }, cause));
      }
      return err(
        upstreamError("Upstream request failed before a response was received.", { url: request.path }, cause)
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function request<T>(httpRequest: HttpRequest): Promise<Result<HttpResponse<T>, PlatformError>> {
    let lastError: PlatformError | undefined;

    // A failed write may already have been committed upstream, so replaying it
    // can duplicate the resource. Only safe methods retry automatically.
    const mayReplay = httpRequest.idempotent ?? AUTO_RETRYABLE_METHODS.has(httpRequest.method);

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const result = await attemptOnce<T>(httpRequest, attempt);
      if (result.ok) {
        return result;
      }

      lastError = result.error;
      const retryable = result.error.retryable;
      const isLastAttempt = attempt === maxRetries;
      if (!retryable || !mayReplay || isLastAttempt) {
        return err(result.error);
      }

      const delay = computeBackoffMs(attempt, backoffBaseMs, backoffMaxMs, random);
      logger?.debug("http_retry", {
        path: httpRequest.path,
        attempt: attempt + 1,
        delayMs: delay,
        code: result.error.code
      });
      await sleep(delay);
    }

    return err(lastError ?? upstreamError("Upstream request failed."));
  }

  return {
    request,
    get: (path, query) => request({ method: "GET", path, ...(query === undefined ? {} : { query }) }),
    post: (path, body) => request({ method: "POST", path, body }),
    describe: () => ({
      // describe() feeds health_check output, which is NOT passed through the
      // logger's redactor — so strip any credential the base URL carries.
      baseUrl: maskUriCredentials(options.baseUrl),
      timeoutMs: options.timeoutMs,
      maxRetries,
      authConfigured: options.authHeader !== undefined
    })
  };
}
