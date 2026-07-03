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
    const query: Record<string, unknown> = {
      sql: params.sql,
      start_time: params.startUs,
      end_time: params.endUs,
      from: params.from ?? 0,
      size: params.size ?? this.config.defaultSize
    };
    const path = params.type
      ? `/api/${enc(this.config.org)}/_search?type=${encodeURIComponent(params.type)}`
      : `/api/${enc(this.config.org)}/_search`;

    const body = await this.request<SearchResponse>("POST", path, { query });
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

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
