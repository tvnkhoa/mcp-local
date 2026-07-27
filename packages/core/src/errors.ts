/**
 * The platform error taxonomy.
 *
 * Every error crossing a boundary carries a stable `code` and a message that is
 * safe to show a user. Internal detail belongs in `details` (which the logger
 * redacts) or in `cause` — never in `message`.
 */

export const ERROR_CODES = [
  "validation_error",
  "policy_violation",
  "not_found",
  "conflict",
  "unauthorized",
  "rate_limited",
  "upstream_error",
  "timeout",
  "config_error",
  "unsupported",
  "internal_error"
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * `user` — the caller can fix this by changing their request or configuration.
 * `developer` — indicates a defect or an unexpected upstream condition.
 */
export type ErrorAudience = "user" | "developer";

export interface PlatformErrorOptions {
  readonly code: ErrorCode;
  readonly message: string;
  readonly audience?: ErrorAudience;
  readonly retryable?: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export interface PlatformErrorPayload {
  readonly code: ErrorCode;
  readonly message: string;
  readonly audience: ErrorAudience;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

const USER_FACING: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "validation_error",
  "policy_violation",
  "not_found",
  "conflict",
  "unauthorized",
  "rate_limited",
  "config_error",
  "unsupported"
]);

const RETRYABLE_BY_DEFAULT: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "rate_limited",
  "timeout",
  "upstream_error"
]);

export class PlatformError extends Error {
  readonly code: ErrorCode;
  readonly audience: ErrorAudience;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(options: PlatformErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PlatformError";
    this.code = options.code;
    this.audience = options.audience ?? (USER_FACING.has(options.code) ? "user" : "developer");
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT.has(options.code);
    this.details = options.details;
  }

  /** Serializable shape for transport. Never includes `cause` or a stack. */
  toPayload(): PlatformErrorPayload {
    const payload: {
      code: ErrorCode;
      message: string;
      audience: ErrorAudience;
      retryable: boolean;
      details?: Readonly<Record<string, unknown>>;
    } = {
      code: this.code,
      message: this.message,
      audience: this.audience,
      retryable: this.retryable
    };
    if (this.details !== undefined) {
      payload.details = this.details;
    }
    return payload;
  }
}

export function isPlatformError(value: unknown): value is PlatformError {
  return value instanceof PlatformError;
}

/** Normalize any thrown value into a PlatformError without leaking internals. */
export function toPlatformError(value: unknown, fallbackMessage = "An unexpected error occurred."): PlatformError {
  if (isPlatformError(value)) {
    return value;
  }
  // The original message may embed a connection string, a token, or a file
  // path. It goes on `cause` — which is logged but never serialized by
  // toPayload() — and never into `details`, which does reach the caller.
  if (value instanceof Error) {
    return new PlatformError({
      code: "internal_error",
      message: fallbackMessage,
      audience: "developer",
      details: { originalName: value.name },
      cause: value
    });
  }
  return new PlatformError({
    code: "internal_error",
    message: fallbackMessage,
    audience: "developer",
    details: { originalType: typeof value },
    cause: value
  });
}

function make(code: ErrorCode) {
  return (message: string, details?: Readonly<Record<string, unknown>>, cause?: unknown): PlatformError =>
    new PlatformError(
      details === undefined
        ? cause === undefined
          ? { code, message }
          : { code, message, cause }
        : cause === undefined
          ? { code, message, details }
          : { code, message, details, cause }
    );
}

export const validationError = make("validation_error");
export const policyViolation = make("policy_violation");
export const notFound = make("not_found");
export const conflictError = make("conflict");
export const unauthorizedError = make("unauthorized");
export const rateLimitedError = make("rate_limited");
export const upstreamError = make("upstream_error");
export const timeoutError = make("timeout");
export const configError = make("config_error");
export const unsupportedError = make("unsupported");
export const internalError = make("internal_error");


/**
 * Policy / guardrail violation raised by a server tool.
 *
 * Carries a stable machine-readable `code` so responses can surface a consistent
 * error taxonomy. postgres-mcp, observe-mcp and bitbucket-mcp each had a
 * byte-identical copy of this class; they now re-export this one.
 *
 * Distinct from {@link PlatformError}: this is the servers' pre-existing
 * contract type with a free-form string code (`APPROVAL_TOKEN_EXPIRED`,
 * `config_error`, ...), whereas PlatformError carries the platform's own closed
 * `ERROR_CODES` taxonomy plus audience/retryable metadata. Converging them would
 * change every server's error payload, so both exist.
 *
 * Safe to share despite `instanceof`: @mcp/core is resolved through a single
 * symlink, so every importer sees the same class object. That is NOT true of
 * `zod` or `@modelcontextprotocol/sdk`, which each server carries its own copy
 * of — which is why `mapError` stays inside each server.
 */
export class PolicyViolationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "PolicyViolationError";
  }
}
