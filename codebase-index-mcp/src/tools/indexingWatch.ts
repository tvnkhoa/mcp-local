/**
 * Batch 4 — indexing and watch. The first group that writes to the graph or holds a watcher
 * (S-32).
 *
 * Same construction as batches 1–3, with two differences that matter:
 *
 *   - Two of the four are NOT read-only, so this is the first batch whose annotations are a
 *     judgement rather than a default. The reasoning lives on the presets in `common.ts`, where
 *     it can be argued with.
 *   - `index_repository` and `watch_repo` are the first async handlers, so their tool handlers
 *     await. That matters for the error envelope: a rejection has to surface as a failure of
 *     this call so `formatError` renders it, which is the same reason the legacy switch awaited
 *     the two refactor handlers explicitly.
 */

import { ok } from "@mcp/core";
import type { AnyToolDefinition } from "@mcp/sdk";
import { defineTool } from "@mcp/sdk";

import { handleGetFeatureBundle } from "./handlers/bundleHandler.js";
import { handleIndexRepository, handleWatchRepo } from "./handlers/indexHandler.js";
import { handleGetPersistenceMapping } from "./handlers/persistenceHandler.js";
import * as schemas from "../types/schemas/toolSchemas.js";

import {
  PROFILE_PROP,
  controlsWatcher,
  raw,
  readsGraph,
  rebuildsIndex,
  type CodebaseIndexDeps
} from "./common.js";

export function buildIndexingWatchTools(deps: CodebaseIndexDeps): AnyToolDefinition[] {
  const { limits, buildContext } = deps;

  const indexRepository = defineTool({
    name: "index_repository",
    description: "Index repository files into internal graph storage (incremental by default). mode='dirty' re-indexes ONLY git working-tree-changed files (unstaged+staged+untracked) — a fast refresh of just-edited files (extraction is scoped to the changed set; edge resolution still runs repo-wide). Pruning is suppressed (subset scan). docsMode controls docs lane isolation: auto uses server default, on forces docs indexing, off disables docs indexing for this run.",
    input: schemas.indexRepositorySchema(limits.maxFilesPerRun),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId", "repoPath"],
      properties: {
        repoId: { type: "string" },
        repoPath: { type: "string" },
        mode: { type: "string", enum: ["full", "incremental", "dirty"] },
        docsMode: { type: "string", enum: ["auto", "on", "off"] },
        maxFiles: { type: "integer", minimum: 1, maximum: limits.maxFilesPerRun },
        batchSize: { type: "integer", minimum: 1, maximum: 2000 }
      }
    },
    annotations: rebuildsIndex,
    rawResult: true,
    handler: async (input) => ok(raw(await handleIndexRepository(input, buildContext())))
  });

  const watchRepo = defineTool({
    name: "watch_repo",
    description: "Manage real-time file watching for a repository. action=start begins debounced incremental re-index on file changes; action=stop halts watching; action=status returns current watch state and counters.",
    input: schemas.watchRepoSchema,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["start", "stop", "status"] },
        repoId: { type: "string" },
        repoPath: { type: "string" }
      }
    },
    annotations: controlsWatcher,
    rawResult: true,
    handler: async (input) => ok(raw(await handleWatchRepo(input, buildContext())))
  });

  const getFeatureBundle = defineTool({
    name: "get_feature_bundle",
    description: "Gather a whole vertical-slice feature from one seed: given an entity (seedSymbol e.g. 'ConversationNote', or seedFile) it walks the C# convention (entity → {E}Configuration → Create/Update/Delete{E}Command + handlers + validators → Get{E}Query + handlers → {E}Endpoints) and returns the related symbols with source in one call. Use for 'implement X by mirroring Y' tasks instead of reading 6+ files separately. Heuristic, name-pattern based; unresolvedRoles lists roles not found by name. excludeTests=true drops test-path results entirely — recommended, since a name-pattern match happily awards a role to '{E}CommandHandlerTests' or resolves a DbSet to a TestDbContext.",
    input: schemas.getFeatureBundleSchema,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId"],
      properties: {
        repoId: { type: "string" },
        seedSymbol: { type: "string" },
        seedFile: { type: "string" },
        convention: { type: "string", enum: ["csharp-vertical-slice"] },
        maxFiles: { type: "integer", minimum: 1, maximum: 60 },
        maxBytesPerFile: { type: "integer", minimum: 1, maximum: 20000 },
        includeSource: { type: "boolean" },
        excludeTests: { type: "boolean" },
        profile: PROFILE_PROP
      }
    },
    // Reads source files from disk as well as the graph, but reads only.
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleGetFeatureBundle(input, buildContext())))
  });

  const getPersistenceMapping = defineTool({
    name: "get_persistence_mapping",
    description: "Return the EF persistence mapping for a property — column name, value converter, max length, CHECK constraints — plus DB_TRANSLATED_PROJECTION warnings when a value-converted property is used inside an EF-translated .Select()/.Where() with no preceding materialization (.ToListAsync()/.AsEnumerable()). Surfaces the persistence-layer facts a symbol graph can't see (rule/AST-based, no LLM).",
    input: schemas.getPersistenceMappingSchema,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId", "property"],
      properties: {
        repoId: { type: "string" },
        property: { type: "string", description: "Property name, e.g. \"HandledBy\"." },
        ownerType: { type: "string", description: "Optional owner/entity type to scope the mapping, e.g. \"Conversation\"." },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleGetPersistenceMapping(input, buildContext())))
  });

  return [indexRepository, watchRepo, getFeatureBundle, getPersistenceMapping];
}
