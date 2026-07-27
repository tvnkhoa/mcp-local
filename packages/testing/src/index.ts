/**
 * @mcp/testing — test harness for platform tools.
 *
 * Depends on @mcp/sdk so tests exercise the real dispatch pipeline. Nothing in
 * the platform may depend on this package outside of its own tests.
 */

export type { LogRecord, MemoryLogger, TestContextOptions } from "./context.js";
export { createMemoryLogger, createTestToolContext } from "./context.js";

export type { HarnessOptions, InvokeOptions, ToolHarness, ToolInvocation } from "./harness.js";
export { createToolHarness, invokeTool } from "./harness.js";

export {
  assertMinified,
  assertNoLeak,
  assertPosixPaths,
  assertToolError,
  assertToolOk
} from "./assertions.js";

export type { ContractDifference, ContractSnapshot } from "./contract.js";
export { diffSnapshots, formatDifferences, serializeSnapshot, snapshotTools } from "./contract.js";
