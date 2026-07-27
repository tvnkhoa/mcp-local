/**
 * Bounded limits and timeouts.
 *
 * Convention rule 10: every list/search/query tool accepts `limit` and
 * `timeoutMs` with documented hard caps. Resolution is centralised here so no
 * server can quietly accept an unbounded request.
 */

export interface BoundSpec {
  readonly defaultValue: number;
  readonly max: number;
  readonly min?: number;
}

export interface BoundResolution {
  readonly value: number;
  /** True when the requested value was above `max` or below `min`. */
  readonly clamped: boolean;
  readonly requested: number | undefined;
}

function coerce(requested: unknown): number | undefined {
  if (requested === undefined || requested === null) {
    return undefined;
  }
  const parsed = typeof requested === "number" ? requested : Number(requested);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function resolveBound(requested: unknown, spec: BoundSpec): BoundResolution {
  const min = spec.min ?? 1;
  const parsed = coerce(requested);

  if (parsed === undefined) {
    return { value: Math.min(Math.max(spec.defaultValue, min), spec.max), clamped: false, requested: undefined };
  }

  const truncated = Math.trunc(parsed);
  if (truncated > spec.max) {
    return { value: spec.max, clamped: true, requested: truncated };
  }
  if (truncated < min) {
    return { value: min, clamped: true, requested: truncated };
  }
  return { value: truncated, clamped: false, requested: truncated };
}

/** Convenience wrapper returning just the resolved number. */
export function resolveLimit(requested: unknown, spec: BoundSpec): number {
  return resolveBound(requested, spec).value;
}

/** Convenience wrapper for timeouts (min defaults to 1 ms). */
export function resolveTimeoutMs(requested: unknown, spec: BoundSpec): number {
  return resolveBound(requested, spec).value;
}

export interface LimitPolicy {
  readonly limit: BoundSpec;
  readonly timeoutMs: BoundSpec;
}

export function createLimitPolicy(limit: BoundSpec, timeoutMs: BoundSpec): LimitPolicy {
  return { limit, timeoutMs };
}
