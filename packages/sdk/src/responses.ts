/**
 * Profile-aware response shaping.
 *
 * One implementation of what four servers currently each carry a near-identical
 * copy of. Behaviour matches the existing convention exactly: only `verbose` is
 * pretty-printed, every other profile is minified with nullish fields dropped,
 * and configured path-like keys are normalized to forward slashes.
 */

import type { PlatformError, ResponseProfile } from "@mcp/core";
import { normalizePayload, shouldDropNullish, shouldPrettyPrint } from "@mcp/core";


/** Structurally matches the MCP `CallToolResult`. */
export interface ToolCallResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
  readonly [key: string]: unknown;
}

export interface SerializeOptions {
  /** Object keys whose string values are path-like and get forward slashes. */
  readonly pathKeys?: readonly string[];
  /** Stabilise key order. Off by default — preserves author-intended ordering. */
  readonly stableKeys?: boolean;
}

export function serializePayload(
  payload: unknown,
  profile: ResponseProfile,
  options: SerializeOptions = {}
): string {
  const normalized = normalizePayload(payload, {
    dropNullish: shouldDropNullish(profile),
    ...(options.stableKeys === undefined ? {} : { stableKeys: options.stableKeys }),
    ...(options.pathKeys === undefined ? {} : { pathKeys: options.pathKeys })
  });
  return shouldPrettyPrint(profile)
    ? JSON.stringify(normalized, null, 2)
    : JSON.stringify(normalized);
}

/** Wrap a successful payload as an MCP tool result. */
export function asText(
  payload: unknown,
  profile: ResponseProfile,
  options: SerializeOptions = {}
): ToolCallResult {
  return {
    content: [{ type: "text", text: serializePayload(payload, profile, options) }]
  };
}

/**
 * Wrap a platform error as an MCP tool result.
 *
 * Routed through `serializePayload` rather than raw `JSON.stringify`: an error's
 * `details` is caller-supplied and may hold a BigInt or a cycle, which would
 * throw out of the one code path whose entire job is to report failures.
 */
export function asError(error: PlatformError, profile: ResponseProfile): ToolCallResult {
  return {
    content: [{ type: "text", text: serializePayload(error.toPayload(), profile) }],
    isError: true
  };
}

/**
 * Error result built from a caller-shaped payload rather than a `PlatformError`.
 *
 * The servers construct their own error envelopes (`{ requestId, environment,
 * code, message }`) and flag them `isError`. That is the shape `asError` above
 * cannot express, and it is the exact function three servers each carried a copy
 * of. Serialization goes through `serializePayload` for the same reason `asError`
 * does: an error path must not be the thing that throws.
 */
export function asErrorPayload(
  payload: unknown,
  profile: ResponseProfile,
  options: SerializeOptions = {}
): ToolCallResult {
  return {
    content: [{ type: "text", text: serializePayload(payload, profile, options) }],
    isError: true
  };
}

/**
 * Last-resort result for when even error serialization fails. Hand-written so
 * it cannot itself throw.
 */
export function asFatalError(message = "The tool failed and its error could not be serialized."): ToolCallResult {
  return {
    content: [
      {
        type: "text",
        text: `{"code":"internal_error","message":${JSON.stringify(message)},"audience":"developer","retryable":false}`
      }
    ],
    isError: true
  };
}
