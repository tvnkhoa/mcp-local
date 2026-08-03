/**
 * The __DIR__ tool table.
 *
 * Separated from `index.ts` on purpose: the entry point has start-up side effects (config load,
 * transport connect), so anything worth testing lives here and is exercised without a server.
 *
 * Two things `defineTool` enforces at construction — a malformed tool fails at startup, not on
 * first call:
 *
 * - `name` must be snake_case, and it is a **permanent** contract. `contracts/__KEY__.json` pins it.
 * - `annotations` must state `readOnly` / `idempotent` / `destructive`. Clients use those hints to
 *   decide what may be auto-approved, so a wrong one is a safety bug rather than a doc bug. Use
 *   the `annotations.*` presets and pick by what the tool actually does.
 */

import { isPlatformError, ok } from "@mcp/core";
import { annotations, createHealthCheckTool, defineTool, registerTool, schema } from "@mcp/sdk";
import type { AnyToolDefinition } from "@mcp/sdk";
import { z } from "zod";

import { describeConfig, type __PASCAL__Config } from "../config/index.js";
import { mapError, type MappedError } from "../middleware/errors.js";
import { responseProfileSchema } from "../middleware/responseFormatter.js";

/**
 * `mapError`, plus the refusals dispatch itself raises.
 *
 * A `PlatformError` reaching `mapError` would fall into its catch-all and be reported as
 * `internal_error` — actively misleading for something like an unknown tool name, which dispatch
 * answers with `not_found`. Unwrapping it first preserves the code dispatch chose.
 *
 * Declared here rather than in `middleware/errors.ts` so this module is the single place
 * `index.ts` and the tests wire their error contract from — same as `observe-mcp` and
 * `bitbucket-mcp`. This is what `formatError` gets, not `mapError` itself.
 */
export function toWireError(error: unknown): MappedError {
  if (isPlatformError(error)) {
    return { code: error.code, message: error.message };
  }
  return mapError(error);
}

export function buildTools(config: __PASCAL__Config): readonly AnyToolDefinition[] {
  // `registerTool` flattens the groups it is given and rejects a duplicate name at the point of
  // assembly — at start-up — rather than letting one tool silently shadow another at call time.
  // One group today; add `buildWriteTools(...)` beside it as the server grows.
  return registerTool([
    /**
     * Server convention S1: every server exposes `health_check`, with an identical shape supplied
     * by the SDK so `mcp:doctor` and the smoke tests need no per-server special cases.
     *
     * Add a `probe` once this server talks to something — returning an error marks the server
     * degraded instead of throwing, because a health check must always answer.
     */
    createHealthCheckTool({
      serverName: "__KEY__",
      version: "0.1.0",
      describeConfig: () => describeConfig(config)
    }),

    /**
     * Placeholder. Replace with a real tool.
     *
     * Kept so a freshly scaffolded server has something to call besides `health_check`, and so
     * `tools.test.ts` has a non-trivial response pinned from the first commit.
     *
     * Note the handler returns `ok(payload)` — not a serialized result. Dispatch resolves the
     * profile from the raw arguments and serializes for you.
     */
    defineTool({
      name: "echo",
      title: "Echo",
      description: "Return the supplied message. Placeholder — replace with a real tool.",
      annotations: annotations.read(),
      inputSchema: schema.object(
        {
          message: schema.string("Text to echo back"),
          profile: schema.enumOf(["nano", "compact", "standard", "verbose"])
        },
        { required: ["message"] }
      ),
      input: z
        .object({
          message: z.string().min(1).max(4096),
          profile: responseProfileSchema.optional()
        })
        .strict(),
      handler: async (args) => ok({ message: args.message, server: "__KEY__" })
    })
  ]);
}
