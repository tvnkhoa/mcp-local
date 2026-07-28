/**
 * codebase-index-mcp's tool table (S-32).
 *
 * Grows one batch per step; `descriptors/` and `legacyDispatch.ts` shrink by the same batch,
 * and both disappear at S-33 when this is the only table left.
 *
 * Migrated: read/metadata (8), search (9), graph/impact (12).
 * Still on the switch: indexing/watch (4), refactor (10).
 */

import type { AnyToolDefinition } from "@mcp/sdk";

import { buildReadMetadataTools } from "./readMetadata.js";
import { buildSearchTools } from "./search.js";
import { buildGraphImpactTools } from "./graphImpact.js";
import type { CodebaseIndexDeps } from "./common.js";

export type { CodebaseIndexDeps } from "./common.js";

export function buildTools(deps: CodebaseIndexDeps): AnyToolDefinition[] {
  return [...buildReadMetadataTools(deps), ...buildSearchTools(deps), ...buildGraphImpactTools(deps)];
}
