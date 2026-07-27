/**
 * Profile-aware response shaping.
 *
 * This module used to carry its own copy of `normalizePayload` / `asText` /
 * `asError` — a copy that was 95-97% identical to the one in postgres-mcp and
 * bitbucket-mcp. The logic now lives once in `@mcp/core` (normalization) and
 * `@mcp/sdk` (result envelopes); what remains here is the server-facing surface,
 * kept byte-identical so no call site had to change.
 *
 * Behaviour is equivalence-tested against the pre-extraction implementation in
 * `responseFormatter.test.ts`: 144 of 156 observations are identical, and the
 * only differences replace a crash with a correct value (a cyclic payload used
 * to throw RangeError, a BigInt used to throw TypeError).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { normalizePayload as normalizeShared, type ResponseProfile } from "@mcp/core";
import { asText as asTextShared, asErrorPayload } from "@mcp/sdk";
import { z } from "zod";

export type { ResponseProfile };

export const responseProfileSchema = z.enum(["nano", "compact", "standard", "verbose"]);

/**
 * `strip` maps to `dropNullish`. Kept as a positional boolean rather than an
 * options object because every existing caller passes it that way.
 */
export function normalizePayload(value: unknown, strip: boolean): unknown {
  return normalizeShared(value, { dropNullish: strip });
}

/** Serialize a payload as an MCP text result. Only "verbose" is pretty-printed. */
export function asText(payload: unknown, profile: ResponseProfile = "compact"): CallToolResult {
  // The shared ToolCallResult declares `content` readonly; CallToolResult does
  // not. Structurally identical at runtime — the cast is the variance, not a
  // shape change.
  return asTextShared(payload, profile) as CallToolResult;
}

/** Serialize an error payload (always flagged isError for the MCP client). */
export function asError(payload: unknown, profile: ResponseProfile = "compact"): CallToolResult {
  return asErrorPayload(payload, profile) as CallToolResult;
}
