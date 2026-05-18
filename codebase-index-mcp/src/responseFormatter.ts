import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ResponseProfile = "nano" | "compact" | "standard" | "verbose";

export function resolveResponseProfile(profile: ResponseProfile, compact?: boolean): ResponseProfile {
  return compact ? "compact" : profile;
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
  const text = profile === "compact" || profile === "nano"
    ? JSON.stringify(payload)
    : JSON.stringify(payload, null, 2);

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
