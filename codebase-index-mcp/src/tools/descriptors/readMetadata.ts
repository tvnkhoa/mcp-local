/**
 * Batch 1 — read/metadata. The lowest-risk group: no writes, no graph traversal.
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

export function readMetadataDescriptors(limits: DescriptorLimits): readonly ListedToolDescriptor[] {
  return [
      {
        name: "list_repositories",
        description: "List all indexed repositories. Use profile='nano' for a brief count+status list, omit for full metadata.",
        inputSchema: { type: "object", additionalProperties: false, properties: { profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] } } }
      },
      {
        name: "health_check",
        description: "Check server availability plus codebase readiness (staleness, working tree, watch state) with action hints for re-index/watch.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            repoId: { type: "string" }
          }
        }
      },
      {
        name: "get_file_summary",
        description: "File overview: exported symbols, outgoing imports, and which files import it. Use before get_file_context — lighter payload. profile='nano' for symbol count + top-5, 'compact' (default) for full summary.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "filePath"],
          properties: {
            repoId: { type: "string" },
            filePath: { type: "string" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "get_folder_summary",
        description: "List all files under a folder path with per-file stats (language, symbol count, caller count). Use at session start to orient — cheaper than get_file_context on individual files. Prefer this over reading file contents when you just need to find the right files. Response includes indexMeta with branch and commitSha from the last index run — verify these match your current branch before trusting file listings. After a branch switch, run index_repository(mode='full') to purge stale entries.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "folderPath"],
          properties: {
            repoId: { type: "string" },
            folderPath: { type: "string" },
            maxFiles: { type: "integer", minimum: 1, maximum: limits.maxResultLimit }
          }
        }
      },
      {
        name: "orient",
        description: "Task router: given a free-text intent (e.g. 'implement a feature like ConversationNote', 'rename X', 'what breaks if I change Y', 'which tests to run') returns the recommended MCP tool(s) + caveats, and resolves an optional seed to seedSymbols. Deterministic keyword classification (no LLM). Use first when unsure which tool to start with.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["intent"],
          properties: {
            repoId: { type: "string" },
            intent: { type: "string" },
            seed: { type: "string" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "query_docs",
        description: "Unified docs tool. mode=search: full-text search across indexed documentation sections (requires query); mode=stale: find docs that mention changed symbols (requires symbolIds); mode=coverage: show which exported symbols are documented (requires filePath). Requires docs lane enabled.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "mode"],
          properties: {
            repoId: { type: "string" },
            mode: { type: "string", enum: ["search", "stale", "coverage"] },
            query: { type: "string" },
            symbolIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 },
            filePath: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: limits.maxResultLimit }
          }
        }
      },
      {
        name: "find_entry_points",
        description: "Find symbols with 0 incoming CALLS edges — these are publicly callable entry points not called by other code in the repo. Use to discover public API surface, HTTP endpoints, or top-level service methods. Filter by kind='method' for controllers, kind='class' for services, kind='route_handler' to surface C# ASP.NET route handlers from the routes table (fast-path, does not require call-graph analysis).",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId"],
          properties: {
            repoId: { type: "string" },
            filePathPrefix: { type: "string" },
            kind: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: limits.maxResultLimit }
          }
        }
      },
      {
        name: "get_file_context",
        description: "Get symbols and graph edges for a file (provide filePath) or multiple files (provide filePaths array). One of filePath or filePaths is required. Use profile=nano for ultra-compact planning output, compact for token-saving, standard for balanced, verbose for debug-rich.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId"],
          properties: {
            repoId: { type: "string" },
            filePath: { type: "string" },
            filePaths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 },
            limit: { type: "integer", minimum: 1, maximum: limits.maxResultLimit },
            compact: { type: "boolean" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      }
  ];
}
