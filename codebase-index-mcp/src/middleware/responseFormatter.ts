import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { normalizePayload as normalizeShared, type ResponseProfile } from "@mcp/core";

export type { ResponseProfile };

export function resolveResponseProfile(profile: ResponseProfile, compact?: boolean): ResponseProfile {
  return compact ? "compact" : profile;
}

// ── Payload normalization (token reduction) ─────────────────────────────────────
// Key-scoped so it never touches code content (refactor hunk text, query_graph SQL echo).

/**
 * Keys whose string values are filesystem paths → backslashes rewritten to POSIX "/".
 *
 * One list, where there used to be two. The local implementation separated "scalar path keys"
 * from "array-of-path keys" because it applied them at different recursion points;
 * `@mcp/core`'s normalizer carries the parent key into array elements, so a key listed once
 * covers both `filePath: "a\\b"` and `affectedFiles: ["a\\b"]`.
 *
 * Two keys therefore widen slightly: `path` and `scopePaths` were array-only and now also
 * normalize a scalar of the same name. That is the intended reading of a key called `path`,
 * and the replay in the header below shows no response actually changed.
 */
const PATH_KEYS = [
  "filePath", "fromFilePath", "toFilePath", "callerFile", "calleeFile",
  "sourceFile", "testFile", "repoPath", "dbPath", "folderPath", "headingPath",
  "affectedFiles", "importedByFiles", "path", "scopePaths",
  // MCP-ISSUE-049 — the keys that were reaching clients with Windows backslashes while every
  // neighbouring key was normalized, so one response carried both conventions.
  //
  // camelCase: two cross-repo/package tools name their path column differently and were simply
  // never added to this list.
  "consumerFilePath", "relatedFilePath", "topFiles",
  // snake_case: `query_graph` echoes raw DB rows, so the column alias IS the response key. These
  // are the path columns in the allowlisted tables (`files.path` is covered by "path" above).
  "file_path", "from_file_path", "to_file_path", "repo_path"
];

/**
 * Reshape a payload before serialization. Delegates to `@mcp/core`.
 *
 * This module used to carry its own recursive normalizer — the fourth copy of one the other three
 * servers had already replaced (S-24/S-25). `@mcp/core.normalizePayload` was written with a
 * `pathKeys` option *for this server*: its own doc comment cites codebase-index-mcp's deeply
 * nested graph payloads as the reason it is unbounded by default. The option was built and then
 * not adopted here.
 *
 * `strip` maps to `dropNullish`, matching the positional-boolean call sites, and empty arrays and
 * objects survive in both implementations — they carry "explicitly none", and dropping them would
 * break the nano ≤ compact ≤ standard size monotonicity gate.
 *
 * What the shared version adds, none of which the local one handled: cycle detection (a repeated
 * sibling node is *not* treated as a cycle), BigInt → string, Date → ISO.
 *
 * Verified by replaying 18 calls × 4 profiles before and after the swap: **72/72 identical** once
 * the fields that differ between any two runs are masked — `requestId`, timestamps, and the git
 * working-tree counters (`dirtyFiles`, `dirtyCount`), which change simply because making the
 * change edits files. Worth stating plainly: the first raw diff showed 37/72 and every one of the
 * 35 was one of those fields.
 */
function normalizePayload(value: unknown, strip: boolean): unknown {
  return normalizeShared(value, { dropNullish: strip, pathKeys: PATH_KEYS });
}

/**
 * Path-normalize a payload that does NOT go through `asText`.
 *
 * MCP-ISSUE-049: the `repo://` resources serialize through `@mcp/sdk`, so they never touched the
 * normalizer above — which is the whole reason `route_map` returned forward slashes while
 * `repo://…/routes` returned backslashes for the same rows. Nullish keys are deliberately KEPT: a
 * resource payload is not profile-shaped, and `latestRun: null` is a meaningful answer there.
 */
export function normalizeResourcePayload(value: unknown): unknown {
  return normalizePayload(value, false);
}

export type ToolRequestContext = {
  toolName: string;
  startedAt: number;
  args: Record<string, unknown>;
  /**
   * Per-request MCP progress sink, present only when the host supplied a
   * progressToken. Long-running tools (index_repository) call it to stream
   * `notifications/progress` updates. Fire-and-forget.
   */
  progressNotifier?: (progress: number, total: number | undefined, message: string) => void;
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

function estimateResultCount(payload: unknown): number | null {
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
  // Idempotent: accept either a bare package name ("SSNet.CommunicationHub.Messaging")
  // or an already-qualified contract id ("nuget:ssnet.communicationhub.messaging").
  // Strip a leading nuget: prefix (any case/whitespace) before re-prefixing so callers
  // that pass the fully-qualified id don't get double-prefixed to nuget:nuget:... (ISSUE-CR-002).
  const stripped = packageName.trim().replace(/^nuget:\s*/i, "");
  return `nuget:${stripped.trim().toLowerCase()}`;
}
