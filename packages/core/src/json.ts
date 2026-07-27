/**
 * Payload normalization primitives.
 *
 * Pure, transport-agnostic. The profile-aware wrapper that turns a payload into
 * an MCP `CallToolResult` lives in `@mcp/sdk` — this module only reshapes data.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export interface NormalizeOptions {
  /** Drop `null` / `undefined` object entries. */
  readonly dropNullish?: boolean;
  /** Sort object keys so output is byte-stable across runs. */
  readonly stableKeys?: boolean;
  /** Rewrite backslashes to forward slashes for values under these keys. */
  readonly pathKeys?: readonly string[];
  readonly maxDepth?: number;
}

/**
 * Unbounded by default.
 *
 * A finite default silently rewrites real data as `"[depth-limit]"`, and the
 * servers this replaces have no depth bound at all — codebase-index-mcp emits
 * deeply nested graph payloads that a cap of 32 would truncate mid-response.
 * Runaway recursion is already prevented by the cycle check below, which is the
 * actual failure mode a depth cap was standing in for. Callers that genuinely
 * want a bound pass `maxDepth` explicitly.
 */
const DEFAULT_MAX_DEPTH = Number.POSITIVE_INFINITY;

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeNode(
  value: unknown,
  key: string | undefined,
  depth: number,
  seen: WeakSet<object>,
  options: NormalizeOptions,
  pathKeySet: ReadonlySet<string>
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return key !== undefined && pathKeySet.has(key) ? toPosix(value) : value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (depth >= (options.maxDepth ?? DEFAULT_MAX_DEPTH)) {
    return "[depth-limit]";
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[circular]";
    }
    seen.add(value);

    try {
      if (Array.isArray(value)) {
        // Holes and non-serializable entries become null rather than being
        // dropped. Dropping would reindex the array, so element n of the
        // response would no longer correspond to element n of the source.
        return value.map((entry) => {
          const normalized = normalizeNode(entry, key, depth + 1, seen, options, pathKeySet);
          return normalized === undefined ? null : normalized;
        });
      }

      const source = isPlainObject(value) ? value : ({ ...value } as Record<string, unknown>);
      const entries = Object.entries(source);
      if (options.stableKeys === true) {
        entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      }

      const output: Record<string, unknown> = {};
      for (const [entryKey, entryValue] of entries) {
        const normalized = normalizeNode(entryValue, entryKey, depth + 1, seen, options, pathKeySet);
        if (normalized === undefined) {
          continue;
        }
        if (options.dropNullish === true && normalized === null) {
          continue;
        }
        output[entryKey] = normalized;
      }
      return output;
    } finally {
      // Release on exit so `seen` tracks the current ancestor chain — a true
      // cycle — rather than every object seen anywhere. Without this, a graph
      // payload that legitimately repeats a node in a sibling position (a
      // symbol referenced by an edge) would serialize as "[circular]".
      seen.delete(value);
    }
  }

  return String(value);
}

/**
 * Reshape a payload for transport: drop nullish fields, normalize path-like
 * strings, and optionally stabilise key order.
 */
export function normalizePayload(payload: unknown, options: NormalizeOptions = {}): unknown {
  const pathKeySet = new Set(options.pathKeys ?? []);
  return normalizeNode(payload, undefined, 0, new WeakSet<object>(), options, pathKeySet);
}

/** Deterministic JSON.stringify — key order is stabilised before serialising. */
export function stableStringify(payload: unknown, pretty = false): string {
  const normalized = normalizePayload(payload, { stableKeys: true });
  return pretty ? JSON.stringify(normalized, null, 2) : JSON.stringify(normalized);
}
