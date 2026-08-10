/**
 * Batch 1 — read/metadata. Eight tools: no writes, no graph traversal (S-32).
 *
 * Each one pairs the zod schema and the JSON Schema it always had with the handler it always
 * called. Both are reused rather than rewritten, and that is the whole safety argument:
 *
 *   - the zod schemas are IMPORTED from `schemas/toolSchemas.ts`, so validation, `.strict()`
 *     unknown-key rejection, defaults and the two `.refine()` cross-field rules are the same
 *     objects the `switch` was parsing with;
 *   - the JSON Schemas are the descriptor literals moved here unedited, so `tools/list` keeps
 *     advertising the same bounds.
 *
 * All eight are `rawResult: true` — the handlers build their own wire result via `ctx.asText`,
 * which is also where success-path telemetry is emitted. Converting them to return payloads
 * would hand serialization to dispatch, and dispatch resolves the profile differently: it reads
 * `profile` off the raw arguments, whereas these handlers run it through
 * `resolveResponseProfile(profile, compact)`. That difference is not academic —
 * `list_repositories` declares `.default("compact").optional()`, and because `.optional()`
 * short-circuits an absent value BEFORE the default applies, `profile` arrives as `undefined`
 * and the handler falls back to `"standard"`. A payload-returning version would quietly answer
 * at `compact` instead. Same story for `get_file_context`, which still honours the legacy
 * `compact: true` boolean. Converting these is a separate, per-handler change.
 */

import { ok } from "@mcp/core";
import type { AnyToolDefinition } from "@mcp/sdk";
import { defineTool } from "@mcp/sdk";

import { handleHealthCheck } from "./handlers/indexHandler.js";
import {
  handleGetFileContext,
  handleGetFileSummary,
  handleGetFolderSummary,
  handleListRepositories,
  handleQueryDocs
} from "./handlers/impactHandler.js";
import { handleFindEntryPoints } from "./handlers/analysisHandler.js";
import { handleOrient } from "./handlers/orientHandler.js";
import * as schemas from "../types/schemas/toolSchemas.js";

import { PROFILE_PROP, raw, readsGraph, type CodebaseIndexDeps } from "./common.js";

/**
 * Registered in the relative order `index.ts` declared them, which keeps this reviewable
 * against the old array. Absolute `tools/list` order does move — the registry lists migrated
 * tools ahead of legacy ones — but the contract snapshot sorts by name, and the protocol makes
 * no ordering promise.
 */
export function buildReadMetadataTools(deps: CodebaseIndexDeps): AnyToolDefinition[] {
  const { limits, buildContext } = deps;

  const healthCheck = defineTool({
    name: "health_check",
    description: "Check server availability plus codebase readiness (staleness, working tree, watch state) with action hints for re-index/watch.",
    input: schemas.healthCheckSchema,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        repoId: { type: "string" }
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleHealthCheck(input, buildContext())))
  });

  const listRepositories = defineTool({
    name: "list_repositories",
    description: "List all indexed repositories. Use profile='nano' for a brief count+status list, omit for full metadata.",
    input: schemas.listRepositoriesSchema,
    inputSchema: { type: "object", additionalProperties: false, properties: { profile: PROFILE_PROP } },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleListRepositories(input, buildContext())))
  });

  const getFileContext = defineTool({
    name: "get_file_context",
    description: "Get symbols and graph edges for a file (provide filePath) or multiple files (provide filePaths array). One of filePath or filePaths is required. Use profile=nano for ultra-compact planning output, compact for token-saving, standard for balanced, verbose for debug-rich.",
    input: schemas.getFileContextSchema(limits.maxResultLimit),
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
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleGetFileContext(input, buildContext())))
  });

  const getFileSummary = defineTool({
    name: "get_file_summary",
    description: "File overview: exported symbols, outgoing imports, and which files import it. Use before get_file_context — lighter payload. profile='nano' for symbol count + top-5, 'compact' (default) for full summary.",
    input: schemas.getFileSummarySchema,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId", "filePath"],
      properties: {
        repoId: { type: "string" },
        filePath: { type: "string" },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleGetFileSummary(input, buildContext())))
  });

  const queryDocs = defineTool({
    name: "query_docs",
    description: "Unified docs tool. mode=search: full-text search across indexed documentation sections (requires query); mode=stale: find docs that mention changed symbols (requires symbolIds); mode=coverage: show which exported symbols are documented (requires filePath). All three modes return the same envelope: { repoId, mode, count, results }. Requires docs lane enabled. includeSymbols=true (mode=search only) additionally pads the result set with matching CODE symbols — off by default, because a docs search answering with symbols is rarely what was asked. mode=stale counts PROSE mentions only; includeCodeMentions=true also counts identifiers appearing inside fenced code samples. mode=search matches headings and prose by default — pass contentTypes to include code_block sections (diagrams, fenced samples).",
    input: schemas.queryDocsSchema(limits.maxResultLimit),
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
        limit: { type: "integer", minimum: 1, maximum: limits.maxResultLimit },
        includeSymbols: { type: "boolean", description: "mode=search only: also return matching code symbols (contentType='symbol'). Off by default." },
        includeCodeMentions: { type: "boolean", description: "mode=stale only: also count identifiers scraped from fenced code samples (mentionType='code_call'). Off by default — a doc that merely contains a call is not documentation of the callee." },
        contentTypes: { type: "array", items: { type: "string", enum: ["heading", "prose", "code_block"] }, minItems: 1, maxItems: 3, description: "mode=search only: which doc section kinds may answer. Defaults to heading+prose; pass code_block to include fenced samples and diagrams." },
        // MCP-ISSUE-049: `profile` was accepted by the zod schema and never advertised, so a client
        // honouring `additionalProperties: false` had to reject a parameter the tool supports.
        // Four more tools have the same gap (get_folder_summary, find_entry_points,
        // get_symbol_detail, find_symbol_at_line) — filed as MCP-ISSUE-051, not fixed here.
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleQueryDocs(input, buildContext())))
  });

  const orient = defineTool({
    name: "orient",
    description: "Task router: given a free-text intent (e.g. 'implement a feature like ConversationNote', 'rename X', 'what breaks if I change Y', 'which tests to run') returns the recommended MCP tool(s) + caveats, and resolves an optional seed to seedSymbols. Deterministic keyword classification (no LLM). Use first when unsure which tool to start with.",
    input: schemas.orientSchema,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["intent"],
      properties: {
        repoId: { type: "string" },
        intent: { type: "string" },
        seed: { type: "string" },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleOrient(input, buildContext())))
  });

  const getFolderSummary = defineTool({
    name: "get_folder_summary",
    description: "List all files under a folder path with per-file stats (language, symbol count, caller count). Use at session start to orient — cheaper than get_file_context on individual files. Prefer this over reading file contents when you just need to find the right files. Response includes indexMeta with branch and commitSha from the last index run — verify these match your current branch before trusting file listings. After a branch switch, run index_repository(mode='full') to purge stale entries.",
    input: schemas.getFolderSummarySchema(limits.maxResultLimit),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId", "folderPath"],
      properties: {
        repoId: { type: "string" },
        folderPath: { type: "string" },
        maxFiles: { type: "integer", minimum: 1, maximum: limits.maxResultLimit },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleGetFolderSummary(input, buildContext())))
  });

  const findEntryPoints = defineTool({
    name: "find_entry_points",
    description: "Find symbols with 0 incoming CALLS edges — these are publicly callable entry points not called by other code in the repo. Use to discover public API surface, HTTP endpoints, or top-level service methods. Filter by kind='method' for controllers, kind='class' for services, kind='route_handler' to surface C# ASP.NET route handlers from the routes table (fast-path, does not require call-graph analysis).",
    input: schemas.findEntryPointsSchema(limits.maxResultLimit),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId"],
      properties: {
        repoId: { type: "string" },
        filePathPrefix: { type: "string" },
        kind: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: limits.maxResultLimit },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleFindEntryPoints(input, buildContext())))
  });

  return [
    healthCheck,
    listRepositories,
    getFileContext,
    getFileSummary,
    queryDocs,
    orient,
    getFolderSummary,
    findEntryPoints
  ];
}
