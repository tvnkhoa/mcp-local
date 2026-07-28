/**
 * Batch 4 — indexing and watch. First group that writes to the graph or holds a watcher.
 *
 * `tools/list` descriptors for this batch, lifted verbatim out of the inline array in
 * `index.ts` (S-31). Grouped by S-32 migration batch on purpose: when a batch moves to
 * one-file-per-tool definitions, this file is deleted whole rather than edited.
 *
 * Editing a description or a schema here changes the public contract — `contracts:check`
 * will say so.
 */

import type { ListedToolDescriptor } from "@mcp/sdk";

import type { DescriptorLimits } from "./limits.js";

export function indexingWatchDescriptors(limits: DescriptorLimits): readonly ListedToolDescriptor[] {
  return [
      {
        name: "index_repository",
        description: "Index repository files into internal graph storage (incremental by default). mode='dirty' re-indexes ONLY git working-tree-changed files (unstaged+staged+untracked) — a fast refresh of just-edited files (extraction is scoped to the changed set; edge resolution still runs repo-wide). Pruning is suppressed (subset scan). docsMode controls docs lane isolation: auto uses server default, on forces docs indexing, off disables docs indexing for this run.",
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
        }
      },
      {
        name: "watch_repo",
        description: "Manage real-time file watching for a repository. action=start begins debounced incremental re-index on file changes; action=stop halts watching; action=status returns current watch state and counters.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["action"],
          properties: {
            action: { type: "string", enum: ["start", "stop", "status"] },
            repoId: { type: "string" },
            repoPath: { type: "string" }
          }
        }
      },
      {
        name: "get_feature_bundle",
        description: "Gather a whole vertical-slice feature from one seed: given an entity (seedSymbol e.g. 'ConversationNote', or seedFile) it walks the C# convention (entity → {E}Configuration → Create/Update/Delete{E}Command + handlers + validators → Get{E}Query + handlers → {E}Endpoints) and returns the related symbols with source in one call. Use for 'implement X by mirroring Y' tasks instead of reading 6+ files separately. Heuristic, name-pattern based; unresolvedRoles lists roles not found by name.",
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
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "get_persistence_mapping",
        description: "Return the EF persistence mapping for a property — column name, value converter, max length, CHECK constraints — plus DB_TRANSLATED_PROJECTION warnings when a value-converted property is used inside an EF-translated .Select()/.Where() with no preceding materialization (.ToListAsync()/.AsEnumerable()). Surfaces the persistence-layer facts a symbol graph can't see (rule/AST-based, no LLM).",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "property"],
          properties: {
            repoId: { type: "string" },
            property: { type: "string", description: "Property name, e.g. \"HandledBy\"." },
            ownerType: { type: "string", description: "Optional owner/entity type to scope the mapping, e.g. \"Conversation\"." },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      }
  ];
}
