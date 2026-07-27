/**
 * @mcp/sdk — Tier-1 platform runtime.
 *
 * Contains the reusable tool builder (protocol-free) and the MCP runtime that
 * turns a list of tools into a running server. This is the only package allowed
 * to import @modelcontextprotocol/sdk (dependency rule 8).
 */

export type { JsonSchemaNode, JsonSchemaObject, ObjectOptions } from "./schema.js";
export { EMPTY_OBJECT_SCHEMA, schema } from "./schema.js";

export type {
  AnyToolDefinition,
  Guard,
  GuardContext,
  ToolAnnotations,
  ToolContext,
  ToolDefinition,
  ToolDescriptor,
  ToolHandler
} from "./toolDefinition.js";
export { toToolDescriptor } from "./toolDefinition.js";

export type { ToolSpec } from "./defineTool.js";
export { annotations, defineTool } from "./defineTool.js";

export { defineGuard, featureFlagGuard, immutableTargetGuard, runGuards } from "./guards.js";

export type { SerializeOptions, ToolCallResult } from "./responses.js";
export { asError, asErrorPayload, asFatalError, asText, serializePayload } from "./responses.js";

export type { LegacyBridge, RegistryOptions, ToolRegistry } from "./registry.js";
export { createToolRegistry } from "./registry.js";

export type { DispatchDeps } from "./dispatch.js";
export { dispatchToolCall } from "./dispatch.js";

export type { Lifecycle, ShutdownHook } from "./lifecycle.js";
export { assertConfigValid, createLifecycle } from "./lifecycle.js";

export { redirectConsoleToStderr } from "./console.js";

export type { HealthCheckOptions, HealthCheckPayload, HealthStatus } from "./healthTool.js";
export { createHealthCheckTool } from "./healthTool.js";

export type { McpServerHandle, McpServerOptions } from "./createServer.js";
export { createMcpServer } from "./createServer.js";
