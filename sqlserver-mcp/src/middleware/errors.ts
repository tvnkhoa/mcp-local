/**
 * sqlserver-mcp's error contract.
 *
 * `tools/list` is not the whole public API — the shape of a *failure* is part of it too, and no
 * type check notices when it changes. Every failure leaves this server as
 * `{ code, message, detail? }`, and `src/tools/tools.test.ts` pins that.
 */

import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { PlatformError, PolicyViolationError, isPlatformError, type ErrorCode } from "@mcp/core";
import {
  abortRule,
  createErrorMapper,
  stringProperty,
  type ErrorRule,
  type WireError
} from "@mcp/sdk";

/**
 * Re-exported so every import site in this server reads `from "../middleware/errors.js"`, whichever
 * package the class actually lives in.
 *
 * Note the constructor is `(code, message)` — the code is per-refusal, not per-class:
 * `throw new PolicyViolationError("write_disabled", "Writes are disabled.")`.
 */
export { PolicyViolationError };

export type MappedError = WireError;

/**
 * Map anything throwable into this server's envelope.
 *
 * The branch order — validation → classes carrying their own code → protocol error → extra rules →
 * fallback — is shared, because three hand-written copies of it is how two of them end up subtly
 * different. What stays here is every string a client can see.
 *
 * **The classes are passed in, not imported by the SDK, and that is the whole point.** Per ADR-0001
 * this server owns its own copies of `zod` and `@modelcontextprotocol/sdk`, so a `ZodError` thrown
 * here is not an instance of any class a shared package could import. Injecting them keeps every
 * `instanceof` running against the classes this server actually throws.
 *
 * Add your own error classes to `coded` as the server grows — anything with a `code` property is
 * reported under it, and a `detail` string is forwarded.
 */

/**
 * Classify a `mssql`/`tedious` connection failure into this server's taxonomy.
 *
 * **Why this exists.** The driver's own message is the only place that says *why* a connect
 * failed, and it is exactly the string we must not forward: tedious embeds `host:port` in every
 * `ESOCKET`, and `Login failed for user 'x'` names the account that `describeConfig` deliberately
 * redacts to `***`. Forwarding it would leak past our own redaction; dropping it leaves
 * `internal_error` with nothing to act on. So this reads the message, decides what happened, and
 * emits wording written here.
 *
 * Only the driver's `code` is ever interpolated, and only after matching `/^[A-Z_]{1,32}$/` — a
 * fixed, non-secret vocabulary (`ESOCKET`, `ELOGIN`, `ETIMEOUT`, …). Everything else the caller
 * sees is a literal below. The original error stays reachable on `cause`, which the logger
 * redacts and `toPayload()` never serializes.
 *
 * Codes come from `ERROR_CODES`, which is closed — so the specificity lives in the message.
 * `config_error` and `unauthorized` are user-facing by the taxonomy's own table, which is right:
 * every case here is fixed by changing configuration, not by retrying.
 */
const CONNECT_CODES = new Set(["ESOCKET", "ELOGIN", "ETIMEOUT", "ECONNRESET", "ECONNREFUSED", "EINSTLOOKUP"]);

function driverCode(error: unknown): string | undefined {
  const code = stringProperty(error, "code");
  return code !== undefined && /^[A-Z_]{1,32}$/.test(code) ? code : undefined;
}

/** The driver nests the useful text one level down on `originalError` as often as not. */
function driverText(error: unknown): string {
  const own = stringProperty(error, "message") ?? "";
  const nested =
    typeof error === "object" && error !== null && "originalError" in error
      ? (stringProperty((error as { originalError: unknown }).originalError, "message") ?? "")
      : "";
  return `${own} ${nested}`.toLowerCase();
}

export function classifyConnectionFailure(
  error: unknown
): { code: ErrorCode; message: string } | undefined {
  const code = driverCode(error);
  if (code === undefined || !CONNECT_CODES.has(code)) {
    return undefined;
  }
  const text = driverText(error);
  const suffix = ` (driver: ${code})`;

  if (/certificate|self.signed|local issuer|unable to verify/.test(text)) {
    return {
      code: "config_error",
      message:
        "TLS certificate verification failed" +
        suffix +
        ". The server's certificate is not signed by a CA this host trusts — the usual cause on " +
        "AWS RDS, whose certificates chain to an Amazon RDS CA that is not in Node's default " +
        "trust store. Point NODE_EXTRA_CA_CERTS at the regional RDS CA bundle. Setting " +
        "TrustServerCertificate=true also connects, but stops the certificate from being " +
        "verified at all — the traffic stays encrypted and becomes impersonable."
    };
  }
  if (/enotfound|eai_again|getaddrinfo/.test(text)) {
    return {
      code: "config_error",
      message:
        "The server hostname did not resolve" +
        suffix +
        ". Check the `Data Source=` host in the connection string, and that this host can reach " +
        "the network it lives on."
    };
  }
  if (code === "ELOGIN" || /login failed/.test(text)) {
    return {
      code: "unauthorized",
      message:
        "The SQL login was rejected" +
        suffix +
        ". Check `User ID=` / `Password=`, and that the login may connect to the catalog named " +
        "by `Initial Catalog=`. The account name is not echoed here; `health_check` reports it " +
        "as `***`."
    };
  }
  if (code === "ETIMEOUT" || /timeout/.test(text)) {
    return {
      code: "timeout",
      message:
        "Timed out connecting to the server" +
        suffix +
        ". Common causes are a security group or firewall dropping port 1433, or a `Connection " +
        "Timeout=` shorter than the network path needs."
    };
  }
  if (/econnrefused/.test(text)) {
    return {
      code: "config_error",
      message:
        "The server refused the connection" +
        suffix +
        ". Reachable, but nothing is listening on that port — check the port in `Data Source=` " +
        "and that the SQL Server service is running."
    };
  }
  return {
    code: "upstream_error",
    message:
      "Could not connect to the server" +
      suffix +
      ". The driver's own message can embed the host and the login name, so it is logged rather " +
      "than returned."
  };
}

/**
 * The same classification as a `PlatformError`, for `health_check`'s probe.
 *
 * `createHealthCheckTool` reports a returned error as `degraded` and a thrown one as
 * `internal_error` with a fixed "Health probe failed." — so a probe that throws is a probe that
 * says nothing. This is what makes it return instead.
 */
export function connectionFailureAsPlatformError(error: unknown): PlatformError {
  const classified = classifyConnectionFailure(error);
  if (classified === undefined) {
    return new PlatformError({
      code: "internal_error",
      message: "Health probe failed before the server answered.",
      audience: "developer",
      cause: error
    });
  }
  return new PlatformError({ ...classified, cause: error });
}

/** Wired into `mapError` below, so every tool that opens a connection reports the same cause. */
const connectionFailureRule: ErrorRule = (error) => classifyConnectionFailure(error);

export const mapError: (error: unknown) => MappedError = createErrorMapper({
  validation: { type: z.ZodError, message: "Invalid arguments.", rootLabel: "(root)" },
  coded: [PolicyViolationError],
  mcpError: McpError,
  rules: [abortRule("Request timed out."), connectionFailureRule]
  // No `fallback`: the platform default is `internal_error` carrying the thrown value's own
  // message. Supply one if this server's upstream errors can carry a secret — a connection string,
  // a token — that must not reach a client.
});

/**
 * `mapError`, plus the refusals dispatch itself raises.
 *
 * A `PlatformError` reaching `mapError` would fall into its catch-all and be reported as
 * `internal_error` — misleading for an unknown tool name, which dispatch answers with `not_found`.
 * Unwrapping it first preserves the code dispatch chose. This is what `formatError` gets.
 *
 * It lives here rather than in `tools/index.ts` because it is the error contract, which is this
 * file's stated job — and because `tools/index.ts` imports every tool builder, so anything under
 * `tools/` that needed this would have formed an import cycle. `tools/index.ts` re-exports it, so
 * no call site changed.
 */
export function toWireError(error: unknown): MappedError {
  if (isPlatformError(error)) {
    return { code: error.code, message: error.message };
  }
  return mapError(error);
}
