import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export type ResponseProfile = "nano" | "compact" | "standard" | "verbose";

export const responseProfileSchema = z.enum(["nano", "compact", "standard", "verbose"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Recursively normalize a payload before serialization. When `strip` is true
 * (compact/nano), omit `null` fields to cut token count. Empty arrays/objects are
 * kept on purpose — they carry "explicitly none" meaning. Ported from
 * codebase-index-mcp/src/responseFormatter.ts (path-key logic dropped: postgres
 * payloads are data rows, not file paths).
 */
export function normalizePayload(value: unknown, strip: boolean): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const nv = normalizePayload(item, strip);
      if (nv !== item) {
        changed = true;
      }
      return nv;
    });
    return changed ? out : value;
  }
  if (isPlainObject(value)) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const nv = normalizePayload(v, strip);
      if (strip && nv === null) {
        changed = true;
        continue;
      }
      if (nv !== v) {
        changed = true;
      }
      out[k] = nv;
    }
    return changed ? out : value;
  }
  return value;
}

/** Serialize a payload as an MCP text result. Only "verbose" is pretty-printed. */
export function asText(payload: unknown, profile: ResponseProfile = "compact"): CallToolResult {
  const strip = profile === "compact" || profile === "nano";
  const normalized = normalizePayload(payload, strip);
  const text = profile === "verbose"
    ? JSON.stringify(normalized, null, 2)
    : JSON.stringify(normalized);
  return { content: [{ type: "text", text }] };
}

/** Serialize an error payload (always minified; flagged isError for the MCP client). */
export function asError(payload: unknown, profile: ResponseProfile = "compact"): CallToolResult {
  const strip = profile === "compact" || profile === "nano";
  const normalized = normalizePayload(payload, strip);
  const text = profile === "verbose"
    ? JSON.stringify(normalized, null, 2)
    : JSON.stringify(normalized);
  return { content: [{ type: "text", text }], isError: true };
}
