/**
 * Documentation utilities
 */

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

export function resolveDocsMode(mode: "auto" | "on" | "off", docsIndexingEnabled: boolean): boolean {
  if (mode === "on") {
    return true;
  }
  if (mode === "off") {
    return false;
  }
  return docsIndexingEnabled;
}

export function assertDocsLaneEnabled(toolName: string, docsToolsEnabled: boolean): void {
  if (!docsToolsEnabled) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${toolName}: docs lane is disabled. Set CODEBASE_INDEX_DOCS_TOOLS_ENABLED=true to enable docs tools.`
    );
  }
}
