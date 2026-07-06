import type { ObserveConfig } from "./config.js";
import { ObserveHttpError } from "./errors.js";

export type SearchParams = {
  sql: string;
  /** Inclusive window start, microseconds since epoch. */
  startUs: number;
  /** Exclusive window end, microseconds since epoch. */
  endUs: number;
  from?: number;
  size?: number;
  /** Stream type routing hint for OpenObserve (`logs` | `traces` | `metrics`). */
  type?: StreamType;
  /**
   * When true, a projected query (`SELECT col, ...`) that fails with a missing-column
   * error is retried once with `SELECT *` — keeps results correct on streams whose
   * schema differs from the configured OBSERVE_LOG_COLUMNS.
   */
  fallbackSelectAll?: boolean;
};

export type SearchResponse = {
  took?: number;
  hits: Array<Record<string, unknown>>;
  total?: number;
  scan_size?: number;
  from?: number;
  size?: number;
};

export type StreamType = "logs" | "traces" | "metrics";

export type StreamInfo = {
  name: string;
  stream_type?: string;
  [key: string]: unknown;
};

/**
 * Thin HTTP client for the OpenObserve REST API. Uses the global `fetch` (undici) —
 * no extra dependencies. All auth lives in the Authorization header and is never
 * logged. Non-2xx responses raise ObserveHttpError with the body as detail.
 */
export class ObserveClient {
  private readonly config: ObserveConfig;

  constructor(config: ObserveConfig) {
    this.config = config;
  }

  /** POST /api/{org}/_search — run a SQL query over a stream within a time window. */
  async search(params: SearchParams): Promise<SearchResponse> {
    const path = params.type
      ? `/api/${enc(this.config.org)}/_search?type=${encodeURIComponent(params.type)}`
      : `/api/${enc(this.config.org)}/_search`;

    const runOnce = (sql: string): Promise<SearchResponse> =>
      this.request<SearchResponse>("POST", path, {
        query: {
          sql,
          start_time: params.startUs,
          end_time: params.endUs,
          from: params.from ?? 0,
          size: params.size ?? this.config.defaultSize
        }
      });

    let body: SearchResponse;
    try {
      body = await runOnce(params.sql);
    } catch (error) {
      // Projected query hit a column the stream doesn't have → retry with SELECT *.
      if (params.fallbackSelectAll && isMissingColumnError(error)) {
        body = await runOnce(toSelectAll(params.sql));
      } else {
        throw error;
      }
    }

    return {
      took: body.took,
      hits: Array.isArray(body.hits) ? body.hits : [],
      total: body.total,
      scan_size: body.scan_size,
      from: body.from,
      size: body.size
    };
  }

  /** GET /api/{org}/streams?type=... — list streams (log/trace/metric datasets). */
  async listStreams(type?: StreamType): Promise<StreamInfo[]> {
    const path = type
      ? `/api/${enc(this.config.org)}/streams?type=${encodeURIComponent(type)}`
      : `/api/${enc(this.config.org)}/streams`;
    const body = await this.request<{ list?: StreamInfo[] }>("GET", path);
    return Array.isArray(body.list) ? body.list : [];
  }

  private async request<T>(method: "GET" | "POST", path: string, jsonBody?: unknown): Promise<T> {
    // Retry transient failures (network / 5xx / 429) with exponential backoff. A
    // timeout (AbortError) and any other 4xx are not retried — they will not fix
    // themselves and retrying would just burn the caller's time budget.
    const maxRetries = this.config.maxRetries;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.attempt<T>(method, path, jsonBody);
      } catch (error) {
        lastError = error;
        if (attempt >= maxRetries || !isRetryable(error)) {
          throw error;
        }
        await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
      }
    }
    throw lastError;
  }

  private async attempt<T>(method: "GET" | "POST", path: string, jsonBody?: unknown): Promise<T> {
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
            Authorization: this.config.authHeader,
            Accept: "application/json",
            ...(jsonBody !== undefined ? { "Content-Type": "application/json" } : {})
          },
          body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
          signal: controller.signal
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }
        throw new ObserveHttpError(0, `Failed to reach OpenObserve at ${this.config.baseUrl}.`, String(error));
      }

      const rawText = await response.text();
      if (!response.ok) {
        throw new ObserveHttpError(
          response.status,
          `OpenObserve returned ${response.status} ${response.statusText}.`,
          truncate(rawText, 1000)
        );
      }

      if (!rawText) {
        return {} as T;
      }
      try {
        return JSON.parse(rawText) as T;
      } catch {
        throw new ObserveHttpError(response.status, "OpenObserve returned a non-JSON response.", truncate(rawText, 500));
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

const BACKOFF_MS = [250, 750];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Transient failures worth retrying: network unreachable (status 0), 429, and any 5xx. */
function isRetryable(error: unknown): boolean {
  if (!(error instanceof ObserveHttpError)) {
    return false;
  }
  return error.status === 0 || error.status === 429 || error.status >= 500;
}

/** A projected SELECT that references a column the stream lacks. */
function isMissingColumnError(error: unknown): boolean {
  if (!(error instanceof ObserveHttpError) || error.status !== 400) {
    return false;
  }
  const text = `${error.message} ${error.detail ?? ""}`.toLowerCase();
  return text.includes("column") || text.includes("field") || text.includes("schema");
}

/** Rewrite a simple `SELECT <cols> FROM ...` into `SELECT * FROM ...` (no subqueries). */
function toSelectAll(sql: string): string {
  return sql.replace(/^SELECT\s+[\s\S]*?\s+FROM\s+/i, "SELECT * FROM ");
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
