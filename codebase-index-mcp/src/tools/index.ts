/**
 * codebase-index-mcp's tool table (S-32).
 *
 * S-32 grew this one batch at a time while `descriptors/` shrank by the same batch. Both the
 * descriptor barrel and `legacyDispatch.ts` are gone — S-33 removed the last of it.
 *
 * All 43 tools are here: read/metadata (8), search (9), graph/impact (12),
 * indexing/watch (4), refactor (10). This list IS the server's tool surface: a name absent
 * from it is an unknown tool, answered by dispatch's not-found path.
 */

import type { AnyToolDefinition } from "@mcp/sdk";

import { buildReadMetadataTools } from "./readMetadata.js";
import { buildRefactorTools } from "./refactor.js";
import { buildSearchTools } from "./search.js";
import { buildGraphImpactTools } from "./graphImpact.js";
import { buildIndexingWatchTools } from "./indexingWatch.js";
import type { CodebaseIndexDeps } from "./common.js";

export type { CodebaseIndexDeps } from "./common.js";

export function buildTools(deps: CodebaseIndexDeps): AnyToolDefinition[] {
  return [...buildReadMetadataTools(deps), ...buildSearchTools(deps), ...buildGraphImpactTools(deps), ...buildIndexingWatchTools(deps), ...buildRefactorTools(deps)];
}
