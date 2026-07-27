/**
 * The standard `health_check` tool.
 *
 * Server convention S1: every server exposes one. Supplying it from the SDK
 * means the shape is identical everywhere — the doctor and the smoke tests can
 * rely on it without per-server special cases.
 *
 * This is a factory, not a behaviour: connectivity probing and config
 * description are supplied by the server.
 */

import type { PlatformError, Result } from "@mcp/core";
import { ok, toPlatformError } from "@mcp/core";
import { z } from "zod";

import { annotations, defineTool } from "./defineTool.js";
import { schema } from "./schema.js";
import type { ToolDefinition } from "./toolDefinition.js";

export interface HealthCheckOptions {
  readonly serverName: string;
  readonly version: string;
  /**
   * Optional connectivity probe. Returning an error marks the server degraded
   * rather than throwing — health checks must always answer.
   */
  readonly probe?: () => Promise<Result<Record<string, unknown>, PlatformError>>;
  /** Non-secret configuration echo. Must already be redacted by the caller. */
  readonly describeConfig?: () => Record<string, unknown>;
  /** Extra static facts (tool counts, feature flags, …). */
  readonly details?: () => Record<string, unknown>;
}

const inputZod = z
  .object({
    profile: z.enum(["nano", "compact", "standard", "verbose"]).optional()
  })
  .strict();

export type HealthStatus = "ok" | "degraded";

export interface HealthCheckPayload {
  readonly status: HealthStatus;
  readonly server: string;
  readonly version: string;
  readonly checkedAt: string;
  readonly config?: Record<string, unknown>;
  readonly details?: Record<string, unknown>;
  readonly probe?: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly message: string };
}

export function createHealthCheckTool(
  options: HealthCheckOptions
): ToolDefinition<z.infer<typeof inputZod>, HealthCheckPayload> {
  return defineTool({
    name: "health_check",
    title: "Health check",
    description: `Report readiness for ${options.serverName}: connectivity, non-secret configuration, and version.`,
    input: inputZod,
    inputSchema: schema.object({ profile: schema.profile() }),
    annotations: annotations.read(),
    handler: async (): Promise<Result<HealthCheckPayload, PlatformError>> => {
      const base = {
        server: options.serverName,
        version: options.version,
        checkedAt: new Date().toISOString(),
        ...(options.describeConfig === undefined ? {} : { config: options.describeConfig() }),
        ...(options.details === undefined ? {} : { details: options.details() })
      };

      if (options.probe === undefined) {
        return ok({ status: "ok", ...base });
      }

      try {
        const probed = await options.probe();
        if (probed.ok) {
          return ok({ status: "ok", ...base, probe: probed.value });
        }
        return ok({
          status: "degraded",
          ...base,
          error: { code: probed.error.code, message: probed.error.message }
        });
      } catch (cause) {
        const error = toPlatformError(cause, "Health probe failed.");
        return ok({
          status: "degraded",
          ...base,
          error: { code: error.code, message: error.message }
        });
      }
    }
  });
}
