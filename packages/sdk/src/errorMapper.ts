/**
 * The wire-error mapper.
 *
 * Three servers each carried a near-identical `mapError`: normalize anything
 * thrown into `{ code, message, detail? }`, in the same branch order — validation
 * error, then classes carrying their own code, then a protocol error, then a
 * catch-all. Only the strings and one or two branches differed.
 *
 * It stayed triplicated because of ADR-0001: servers are not npm workspace
 * members, so each has its own copy of `zod` and `@modelcontextprotocol/sdk`, and
 * a `ZodError` thrown inside a server is **not** an instance of the `ZodError`
 * class a shared package would import. A shared implementation would silently
 * fall through both branches and report every validation failure as
 * `internal_error` carrying a raw Zod dump.
 *
 * The way out is not duck-typing — matching on `.name` would classify any object
 * that happens to be named `ZodError` — but **injection**: the server passes its
 * own class objects in, and `instanceof` runs against exactly the classes that
 * server throws. This package never imports them, which is the constraint
 * ADR-0001 actually sets. What is shared is the branch order and the envelope
 * shape; what stays per-server is every string a client can see.
 *
 * Deliberately NOT covering codebase-index-mcp. Its envelope is a different
 * contract — UPPER_SNAKE codes, a `requestId`, and every message prefixed with
 * the tool name — and there is only one copy of it, so there is no duplication to
 * remove and folding it in would distort both.
 */

/** The envelope all three servers publish. */
export interface WireError {
  readonly code: string;
  readonly message: string;
  readonly detail?: string;
}

/**
 * A class matched with `instanceof`, supplied by the server that throws it.
 *
 * Abstract-constructor-shaped so both concrete error classes and abstract bases
 * are accepted; the mapper only ever uses it on the right-hand side of
 * `instanceof`, never to construct anything.
 */
export type ErrorClass = abstract new (...args: never[]) => object;

/** One extra branch. Return `undefined` to decline and let the next one try. */
export type ErrorRule = (error: unknown) => WireError | undefined;

export interface ValidationErrorSpec {
  /** The server's own `z.ZodError`. */
  readonly type: ErrorClass;
  /** Default `validation_error`. */
  readonly code?: string;
  /** The client-facing message. The issues go in `detail`, not here. */
  readonly message: string;
  /** Label for an issue whose path is empty — `"root"` and `"(root)"` are both in use. */
  readonly rootLabel: string;
  /** Between issues. Default `"; "`. */
  readonly separator?: string;
}

export interface ErrorMapperSpec {
  /** Matched first, because a caller's malformed input is never a server fault. */
  readonly validation?: ValidationErrorSpec;
  /**
   * Classes that already carry their own `code` — a policy violation, an upstream
   * HTTP failure. Tried in the order given, and a `detail` property is forwarded
   * when the instance has one.
   */
  readonly coded?: readonly ErrorClass[];
  /** The server's own `McpError`. */
  readonly mcpError?: ErrorClass;
  /** Default `mcp_error`. */
  readonly mcpErrorCode?: string;
  /** Extra branches, in order, after the class branches and before the fallback. */
  readonly rules?: readonly ErrorRule[];
  /**
   * Last resort. Default: `internal_error` carrying the thrown value's own message
   * — which is what two of the three servers do. A server whose catch-all must not
   * echo an upstream message (postgres-mcp, whose driver errors can carry a
   * connection string) supplies its own.
   */
  readonly fallback?: (error: unknown) => WireError;
}

/** An issue as zod shapes it. Read structurally — the class itself is injected. */
interface ZodLikeIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

function describeIssues(error: object, spec: ValidationErrorSpec): string {
  const issues = (error as { issues?: readonly ZodLikeIssue[] }).issues ?? [];
  return issues
    .map((issue) => `${issue.path.join(".") || spec.rootLabel}: ${issue.message}`)
    .join(spec.separator ?? "; ");
}

/**
 * Forward `detail` whenever it is a string — **including an empty one**.
 *
 * Not a nicety: the hand-written mappers passed `detail: error.detail` through
 * unconditionally, and an upstream HTTP error with an empty body produces `""`.
 * Dropping it here would change one published envelope. A non-string (the usual
 * case: the class has no `detail` at all) is omitted, which is what
 * `JSON.stringify` did with the explicit `detail: undefined` key anyway.
 */
function withDetail(code: string, message: string, detail: unknown): WireError {
  return typeof detail === "string" ? { code, message, detail } : { code, message };
}

function defaultFallback(error: unknown): WireError {
  return {
    code: "internal_error",
    message: error instanceof Error ? error.message : String(error)
  };
}

/**
 * Build a server's `mapError`.
 *
 * Branch order is fixed and shared: validation → coded classes → protocol error →
 * the server's extra rules → fallback. That order is the part worth having once;
 * three hand-written copies of it is how two of them end up subtly different.
 */
export function createErrorMapper(spec: ErrorMapperSpec): (error: unknown) => WireError {
  const validation = spec.validation;
  const coded = spec.coded ?? [];
  const rules = spec.rules ?? [];
  const fallback = spec.fallback ?? defaultFallback;
  const mcpErrorCode = spec.mcpErrorCode ?? "mcp_error";

  return (error: unknown): WireError => {
    if (validation !== undefined && error instanceof validation.type) {
      return {
        code: validation.code ?? "validation_error",
        message: validation.message,
        detail: describeIssues(error, validation)
      };
    }

    for (const type of coded) {
      if (error instanceof type) {
        const carrier = error as { code?: unknown; message?: unknown; detail?: unknown };
        return withDetail(
          typeof carrier.code === "string" ? carrier.code : "internal_error",
          typeof carrier.message === "string" ? carrier.message : String(error),
          carrier.detail
        );
      }
    }

    if (spec.mcpError !== undefined && error instanceof spec.mcpError) {
      return { code: mcpErrorCode, message: (error as Error).message };
    }

    for (const rule of rules) {
      const mapped = rule(error);
      if (mapped !== undefined) {
        return mapped;
      }
    }

    return fallback(error);
  };
}

/**
 * `AbortError` → `timeout`, with the caller's wording.
 *
 * A rule rather than a `coded` class: `AbortError` is not a class at all, it is a
 * plain `Error` with a `name`, so `instanceof` cannot see it. `Error` is a single
 * global across every module instance, so this one check is safe to share.
 */
export function abortRule(message: string, code = "timeout"): ErrorRule {
  return (error) =>
    error instanceof Error && error.name === "AbortError" ? { code, message } : undefined;
}

/**
 * Read a string property off a thrown non-null object.
 *
 * The seam for rules that classify by a driver's own fields (a Postgres
 * `SQLSTATE` in `code`) rather than by class. Returns `undefined` for anything
 * that is not an object, so a thrown string still reaches the fallback.
 */
export function stringProperty(error: unknown, key: string): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
