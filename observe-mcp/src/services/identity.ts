/**
 * Which service is this log row from? — the one place that knows the answer is not
 * simply `service_name`.
 *
 * These .NET processes emit logs down TWO OTLP paths, and only one of them carries
 * the SDK resource:
 *
 *  - **OTel SDK `ILogger` provider** → the resource is right, so `service_name` names
 *    the app. It carries no Serilog enricher, so the app-name field is absent.
 *  - **Serilog OTLP sink** (`Serilog.Sinks.OpenTelemetry`) → the sink builds its OWN
 *    resource. If the app never sets `options.ResourceAttributes["service.name"]` the
 *    sink falls back to the OTel spec default (`unknown_service:dotnet`), and the
 *    Serilog enricher supplies the real name in `applicationname` instead.
 *
 * Measured on both live orgs (2026-08-10, 1h): per ROW the partition is clean and
 * mutually exclusive — 170,938 rows with a real `service_name` and no
 * `applicationname`, 39,903 rows with the sentinel and an `applicationname`, and
 * **zero** rows with the sentinel and no `applicationname`.
 *
 * Per SERVICE it is not. One app normally runs BOTH paths at once, so its rows land
 * on both sides of that partition: `CRM.Gateway` in one hour on prod emitted 15,528
 * rows through the SDK provider and 3,836 through the Serilog sink. That is what
 * `mixed` means and it is the common case, not an anomaly — it is precisely the set
 * of services that lose rows when a query uses `service_name` alone.
 *
 * Two constraints shape everything here:
 *
 *  1. **Logs only.** The traces stream has no `applicationname` column at all, and
 *     DataFusion rejects an unknown column while PLANNING — naming it there fails the
 *     whole request with `Schema error: No field named applicationname` rather than
 *     matching nothing. Every traces query stays on `service_name`.
 *  2. **A logs stream may lack it too.** So the resolution DOWNGRADES: run the
 *     resolved query, and on a missing-column error for this specific field, remember
 *     that stream cannot resolve and re-run raw. Same shape as the `trace_id` /
 *     `traceid` fallback in `get_trace_spans`, and for the same reason. The happy path
 *     costs nothing; a stream without the column pays one extra request, once.
 */

import type { ObserveLimits } from "../config/index.js";
import { isMissingColumnError } from "./observeClient.js";
import { RAW_SERVICE_COLUMN, sqlColumn, sqlString } from "./queryBuilder.js";

/** Re-exported so a caller needs one import for "the identity question", not two. */
export { RAW_SERVICE_COLUMN };

/**
 * How a service's rows got their name. `mixed` — both paths active, the usual state
 * for a .NET app here — is the one that matters operationally: it says some of this
 * service's rows are reachable ONLY through the app-name field.
 */
export type IdentitySource = "resource" | "enricher" | "mixed";

export type IdentityConfig = Pick<ObserveLimits, "appNameField" | "unknownServiceSentinel">;

/**
 * Resolution needs BOTH halves: a field to read the name from and a sentinel that
 * says the resource is untrustworthy. Blanking either (`OBSERVE_APP_NAME_FIELD=`)
 * turns the whole mechanism off and every query falls back to `service_name`.
 */
export function identityEnabled(limits: IdentityConfig): boolean {
  return limits.appNameField.length > 0 && limits.unknownServiceSentinel.length > 0;
}

/**
 * The SQL expression that names a service on the LOGS lane.
 *
 * The third `COALESCE` arm is load-bearing: a row carrying the sentinel and no app
 * name resolves back TO the sentinel, so `service:"unknown_service:dotnet"` still
 * addresses exactly the unresolvable remainder and no caller needs a special case for
 * it. `NULLIF(field,'')` rather than the bare field because an empty string is not a
 * name, and OpenObserve flattens missing attributes to `''` as often as to NULL.
 */
export function resolvedServiceExpr(limits: IdentityConfig): string {
  if (!identityEnabled(limits)) {
    return RAW_SERVICE_COLUMN;
  }
  const field = sqlColumn(limits.appNameField);
  return `COALESCE(NULLIF(${RAW_SERVICE_COLUMN}, ${sqlString(limits.unknownServiceSentinel)}), NULLIF(${field}, ''), ${RAW_SERVICE_COLUMN})`;
}

/**
 * The two counters that turn "which path did this service's rows arrive on" from a
 * claim into a measurement. Selected alongside an existing `GROUP BY`, so they cost
 * no extra round trip — which is what makes reporting it cheap enough to do on every
 * inventory rather than only when someone goes looking.
 */
export function identitySourceSelect(limits: IdentityConfig): string | null {
  if (!identityEnabled(limits)) {
    return null;
  }
  const sentinel = sqlString(limits.unknownServiceSentinel);
  return (
    `SUM(CASE WHEN ${RAW_SERVICE_COLUMN} = ${sentinel} THEN 1 ELSE 0 END) AS enricher_rows, ` +
    `SUM(CASE WHEN ${RAW_SERVICE_COLUMN} IS NULL OR ${RAW_SERVICE_COLUMN} <> ${sentinel} THEN 1 ELSE 0 END) AS resource_rows`
  );
}

/** `resource` / `enricher` / `mixed` from the two counters; null when neither counted. */
export function classifyIdentitySource(resourceRows: number, enricherRows: number): IdentitySource | null {
  if (resourceRows > 0 && enricherRows > 0) {
    return "mixed";
  }
  if (resourceRows > 0) {
    return "resource";
  }
  if (enricherRows > 0) {
    return "enricher";
  }
  return null;
}

/**
 * The same rule applied to a fetched row rather than in SQL — `normalizeLog` needs it
 * because a projected `SELECT` returns the two raw columns, not the expression.
 * Kept beside `resolvedServiceExpr` on purpose: two implementations of one rule that
 * can drift is exactly how a tool starts disagreeing with itself.
 */
export function resolveServiceValue(
  serviceName: string | null,
  appName: string | null,
  limits: IdentityConfig
): string | null {
  if (!identityEnabled(limits)) {
    return serviceName;
  }
  if (serviceName !== null && serviceName !== limits.unknownServiceSentinel) {
    return serviceName;
  }
  return appName !== null && appName !== "" ? appName : serviceName;
}

// ---------------------------------------------------------------------------
// Capability: does THIS stream have the field?
// ---------------------------------------------------------------------------

/**
 * Per `${environment}:${stream}` — false once a query has proved the column absent.
 * Module-level and never invalidated: a stream does not grow the column mid-process,
 * and a server restart is the cheap way to re-test if one ever does.
 */
const unsupported = new Set<string>();

/** Test hook — the capability cache is process-global, so a test must be able to clear it. */
export function resetIdentityCapability(): void {
  unsupported.clear();
}

/** True once this stream has been proved not to carry the app-name field. */
export function identityDowngraded(cacheKey: string): boolean {
  return unsupported.has(cacheKey);
}

/**
 * Narrower than `isMissingColumnError` alone, which matches any 400 mentioning a
 * column, field or schema. Demanding the app-name field BE NAMED in the error keeps
 * an unrelated bad-column query — a caller's own typo in `stream`, say — from
 * permanently marking a perfectly capable stream as unresolvable.
 */
function isMissingAppNameField(error: unknown, field: string): boolean {
  if (!isMissingColumnError(error) || field.length === 0) {
    return false;
  }
  const text = error instanceof Error ? `${error.message} ${(error as { detail?: string }).detail ?? ""}` : String(error);
  return text.toLowerCase().includes(field.toLowerCase());
}

export type IdentityRun<T> = {
  result: T;
  /** False when the query ran on raw `service_name` — either disabled or downgraded. */
  resolved: boolean;
};

/**
 * Run a logs query with the resolved service expression, downgrading to raw
 * `service_name` if this stream turns out not to carry the app-name field.
 *
 * `run` is handed the expression to build its SQL from rather than a finished
 * statement, because every caller shapes a different query around it.
 */
export async function withIdentity<T>(
  cacheKey: string,
  limits: IdentityConfig,
  run: (serviceExpr: string, resolved: boolean) => Promise<T>
): Promise<IdentityRun<T>> {
  if (!identityEnabled(limits) || unsupported.has(cacheKey)) {
    return { result: await run(RAW_SERVICE_COLUMN, false), resolved: false };
  }
  try {
    return { result: await run(resolvedServiceExpr(limits), true), resolved: true };
  } catch (error) {
    if (!isMissingAppNameField(error, limits.appNameField)) {
      throw error;
    }
    unsupported.add(cacheKey);
    return { result: await run(RAW_SERVICE_COLUMN, false), resolved: false };
  }
}

/**
 * An explicit `OBSERVE_LOG_COLUMNS` projection plus the app-name field.
 *
 * Without this, setting a column list quietly disables resolution for every returned
 * row: the SQL filter would still resolve, but `normalizeLog` would have no field to
 * read and would report the sentinel. Appending it is safe on a stream that lacks the
 * column — a projected query that names a missing column already auto-falls back to
 * `SELECT *` in `observeClient`.
 *
 * An empty list means `SELECT *`, which already returns the field, so it stays empty.
 */
export function logColumnsWithIdentity(columns: string[], limits: IdentityConfig): string[] {
  if (columns.length === 0 || !identityEnabled(limits) || columns.includes(limits.appNameField)) {
    return columns;
  }
  return [...columns, limits.appNameField];
}

/** The `identity` block echoed on every response, so a caller can see how it matched. */
export function describeIdentity(limits: IdentityConfig, resolved: boolean): Record<string, unknown> {
  return {
    resolved,
    field: identityEnabled(limits) ? limits.appNameField : null,
    sentinel: identityEnabled(limits) ? limits.unknownServiceSentinel : null,
    note: resolved
      ? null
      : identityEnabled(limits)
        ? `This stream has no "${limits.appNameField}" column, so rows are attributed by ${RAW_SERVICE_COLUMN} alone; apps that never set OTel service.name stay under "${limits.unknownServiceSentinel}".`
        : "Service identity resolution is disabled (OBSERVE_APP_NAME_FIELD / OBSERVE_UNKNOWN_SERVICE_SENTINEL)."
  };
}
