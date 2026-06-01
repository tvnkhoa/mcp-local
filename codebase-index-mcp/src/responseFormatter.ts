import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ResponseProfile = "nano" | "compact" | "standard" | "verbose";

export function resolveResponseProfile(profile: ResponseProfile, compact?: boolean): ResponseProfile {
  return compact ? "compact" : profile;
}

// ── Payload normalization (token reduction) ─────────────────────────────────────
// Key-scoped so it never touches code content (refactor hunk text, query_graph SQL echo).

// Scalar string fields that hold a filesystem path → backslashes normalized to POSIX "/".
const PATH_KEYS = new Set([
  "filePath", "fromFilePath", "toFilePath", "callerFile", "calleeFile",
  "sourceFile", "testFile", "repoPath", "dbPath", "folderPath"
]);

// Array fields whose string elements are paths → each element normalized.
const PATH_ARRAY_KEYS = new Set([
  "affectedFiles", "importedByFiles", "path", "scopePaths"
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Recursively normalizes a payload before serialization:
 *  - POSIX-normalizes path-like string values (key-scoped, never blanket-string).
 *  - When `strip` is true (compact/nano profiles), omits `null` fields.
 *    (Empty arrays/objects are intentionally kept: they carry "explicitly none" meaning and
 *    dropping them would break the nano ≤ compact ≤ standard size monotonicity gate.)
 */
export function normalizePayload(value: unknown, strip: boolean, key?: string): unknown {
  if (typeof value === "string") {
    // Skip the regex entirely when there's nothing to rewrite (the common case).
    return key && PATH_KEYS.has(key) && value.includes("\\") ? value.replace(/\\/g, "/") : value;
  }
  if (Array.isArray(value)) {
    const normalizeStrings = key !== undefined && PATH_ARRAY_KEYS.has(key);
    let changed = false;
    const out = value.map((item) => {
      if (normalizeStrings && typeof item === "string") {
        if (!item.includes("\\")) return item;
        changed = true;
        return item.replace(/\\/g, "/");
      }
      const nv = normalizePayload(item, strip);
      if (nv !== item) changed = true;
      return nv;
    });
    // Return the original reference when nothing changed — avoids reallocating unchanged subtrees.
    return changed ? out : value;
  }
  if (isPlainObject(value)) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const nv = normalizePayload(v, strip, k);
      if (strip && nv === null) { changed = true; continue; }
      if (nv !== v) changed = true;
      out[k] = nv;
    }
    return changed ? out : value;
  }
  return value;
}

export type ToolRequestContext = {
  toolName: string;
  startedAt: number;
  args: Record<string, unknown>;
};

export type ToolTelemetryEvent = {
  ts: string;
  toolName: string;
  elapsedMs: number;
  responseBytes: number;
  resultCount: number | null;
  profile: ResponseProfile | "none";
  requestedProfile: string | null;
  compactRequested: boolean;
  isError: boolean;
  errorCode?: string;
};

export function estimateResultCount(payload: unknown): number | null {
  if (Array.isArray(payload)) {
    return payload.length;
  }

  if (!payload || typeof payload !== "object") {
    return null;
  }

  const obj = payload as Record<string, unknown>;
  if (typeof obj.count === "number") {
    return obj.count;
  }

  const arrayKeys = [
    "symbols",
    "candidates",
    "files",
    "edges",
    "callers",
    "callees",
    "imports",
    "importsBy",
    "importedByFiles",
    "matchedSymbols"
  ];

  for (const key of arrayKeys) {
    const value = obj[key];
    if (Array.isArray(value)) {
      return value.length;
    }
  }

  return null;
}

export function emitTelemetry(
  event: ToolTelemetryEvent,
  telemetryEnabled: boolean,
  sampleRate: number
): void {
  if (!telemetryEnabled) {
    return;
  }

  if (Math.random() > sampleRate) {
    return;
  }

  process.stderr.write(`[tool-telemetry] ${JSON.stringify(event)}\n`);
}

export function asText(
  payload: unknown,
  profile: ResponseProfile,
  ctx: ToolRequestContext | undefined,
  telemetryEnabled: boolean,
  telemetrySampleRate: number
): CallToolResult {
  const strip = profile === "compact" || profile === "nano";
  const normalized = normalizePayload(payload, strip);
  // Only "verbose" stays pretty-printed (human debugging). All other profiles minify.
  const text = profile === "verbose"
    ? JSON.stringify(normalized, null, 2)
    : JSON.stringify(normalized);

  if (ctx) {
    emitTelemetry({
      ts: new Date().toISOString(),
      toolName: ctx.toolName,
      elapsedMs: Date.now() - ctx.startedAt,
      responseBytes: Buffer.byteLength(text, "utf8"),
      resultCount: estimateResultCount(payload),
      profile,
      requestedProfile: typeof ctx.args.profile === "string" ? ctx.args.profile : null,
      compactRequested: ctx.args.compact === true,
      isError: false
    }, telemetryEnabled, telemetrySampleRate);
  }

  return {
    content: [{ type: "text", text }]
  };
}

export function asArgsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function toNugetContractId(packageName: string): string {
  return `nuget:${packageName.trim().toLowerCase()}`;
}
