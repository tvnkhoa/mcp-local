/**
 * Batch 3 — graph and impact. Traversal-heavy, and the group the edge-resolution suites cover
 * (S-32).
 *
 * Same construction as batches 1 and 2: zod schemas imported from `schemas/toolSchemas.ts`,
 * JSON Schemas moved from the descriptor table unedited, handlers called unchanged,
 * `rawResult: true` so each keeps resolving its own profile and emitting its own telemetry.
 *
 * All twelve are read-only. `detect_changes` shells out to git and `find_impact_files` runs the
 * S-30 UNION query, but neither writes: the only state either leaves is the read it performed.
 */

import { ok } from "@mcp/core";
import type { AnyToolDefinition } from "@mcp/sdk";
import { defineTool } from "@mcp/sdk";

import {
  handleDeadCodeScan,
  handleDetectCircularDependencies,
  handleLinkTestsToSource
} from "./handlers/analysisHandler.js";
import { handleFindPackageConsumers, handleGetCrossRepoImpact } from "./handlers/crossRepoHandler.js";
import {
  handleFindImpactFiles,
  handleGetCallChain,
  handleGetChangeContext,
  handleGetDependencyGraph
} from "./handlers/impactHandler.js";
import { handleDetectChanges } from "./handlers/indexHandler.js";
import { handleTraceExecutionFlow } from "./handlers/traceHandler.js";
import { handleGetSymbolContextPack } from "./handlers/searchHandler.js";
import * as schemas from "../types/schemas/toolSchemas.js";

import { PROFILE_PROP, raw, readsGraph, type CodebaseIndexDeps } from "./common.js";

export function buildGraphImpactTools(deps: CodebaseIndexDeps): AnyToolDefinition[] {
  const { limits, buildContext } = deps;

  const getDependencyGraph = defineTool({
    name: "get_dependency_graph",
    description: "Get IMPORTS/DEPENDS_ON dependency edges for a symbol (symbolId) or module-level flow edges for a file (filePath). One required. Use profile='nano' for top-10 edge count, 'compact' (default) for all edges with minimal fields.",
    input: schemas.getDependencyGraphSchema(limits.maxDepth, limits.maxResultLimit),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId"],
      properties: {
        repoId: { type: "string" },
        symbolId: { type: "string" },
        filePath: { type: "string" },
        depth: { type: "integer", minimum: 1, maximum: limits.maxDepth },
        limit: { type: "integer", minimum: 1, maximum: limits.maxResultLimit },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleGetDependencyGraph(input, buildContext())))
  });

  const getCallChain = defineTool({
    name: "get_call_chain",
    description: "Trace a call path from a symbolId (direction=callers or callees). Shows the path, not a caller list — use get_change_context for caller lists. Requires a callable symbolId (function/method), not a class. Use profile='nano' for path summary, 'compact' (default) for full edge list.",
    input: schemas.getCallChainSchema(limits.maxDepth, limits.maxResultLimit),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId", "symbolId"],
      properties: {
        repoId: { type: "string" },
        symbolId: { type: "string" },
        direction: { type: "string", enum: ["callers", "callees"] },
        depth: { type: "integer", minimum: 1, maximum: limits.maxDepth },
        limit: { type: "integer", minimum: 1, maximum: limits.maxResultLimit },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleGetCallChain(input, buildContext())))
  });

  const findImpactFiles = defineTool({
    name: "find_impact_files",
    description: "Scope blast radius for a file change. view='files' (default): which files import/call symbols in this file. view='surface': which external symbols call into this file. Use before refactor_replace_preview to scope the change. profile='nano' for top-10 count, 'compact' (default) for full list. A stale index (indexed commit ≠ HEAD) is reported as a non-fatal `staleWarning` field in the response, not an error — re-index for exact results.",
    input: schemas.findImpactFilesSchema(limits.maxResultLimit),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId", "filePath"],
      properties: {
        repoId: { type: "string" },
        filePath: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: limits.maxResultLimit },
        groupBy: { type: "string", enum: ["file", "module"] },
        view: { type: "string", enum: ["files", "surface"] },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleFindImpactFiles(input, buildContext())))
  });

  const getChangeContext = defineTool({
    name: "get_change_context",
    description: "Get callers (BFS up to depth), callees, and type deps for a symbol. Accepts symbolId or name (one required). Use profile=nano for ultra-compact, compact to reduce payload during planning, standard for balanced, verbose for debugging. A stale index (indexed commit ≠ HEAD) is reported as a non-fatal `staleWarning` field in the response, not an error.",
    input: schemas.getChangeContextSchema(limits.maxDepth, limits.maxResultLimit),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId"],
      properties: {
        repoId: { type: "string" },
        symbolId: { type: "string" },
        name: { type: "string" },
        callerDepth: { type: "integer", minimum: 1, maximum: limits.maxDepth },
        calleeDepth: { type: "integer", minimum: 1, maximum: limits.maxDepth },
        limit: { type: "integer", minimum: 1, maximum: limits.maxResultLimit },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleGetChangeContext(input, buildContext())))
  });

  const getSymbolContextPack = defineTool({
    name: "get_symbol_context_pack",
    description: "Single-call planning pack for a symbol name: ranked candidates + callers + callees + importers + change-context. When a name resolves to several symbols (e.g. a class and its same-named constructor), the substantive symbol (class/interface/method) is selected for the context, so callers/importers are meaningful. Use this instead of get_change_context when you need symbol detail without deep caller traversal. Use profile='compact' (default) or 'nano' in Plan mode. excludeTests=true drops test-path candidates and callers entirely.",
    input: schemas.getSymbolContextPackSchema(limits.maxDepth, limits.maxResultLimit),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId", "name"],
      properties: {
        repoId: { type: "string" },
        name: { type: "string" },
        callerDepth: { type: "integer", minimum: 1, maximum: limits.maxDepth },
        calleeDepth: { type: "integer", minimum: 1, maximum: limits.maxDepth },
        limit: { type: "integer", minimum: 1, maximum: limits.maxResultLimit },
        excludeTests: { type: "boolean" },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleGetSymbolContextPack(input, buildContext())))
  });

  const detectChanges = defineTool({
    name: "detect_changes",
    description: "Detect changed files from git, estimate graph impact, and compute deterministic risk scores (high/medium/low) for review prioritization. Supports policy presets (quick-triage|strict-review|release-gate|custom). Defaults baseRef to latest indexed commit when available.",
    input: schemas.detectChangesSchema(limits.maxResultLimit),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId"],
      properties: {
        repoId: { type: "string" },
        baseRef: { type: "string" },
        headRef: { type: "string" },
        includeUntracked: { type: "boolean" },
        maxFiles: { type: "integer", minimum: 1, maximum: 500 },
        impactLimit: { type: "integer", minimum: 1, maximum: limits.maxResultLimit },
        policy: { type: "string", enum: ["quick-triage", "strict-review", "release-gate", "custom"] },
        minRiskScore: { type: "integer", minimum: 0, maximum: 100 },
        riskLevels: { type: "array", items: { type: "string", enum: ["high", "medium", "low"] }, minItems: 1, maxItems: 3 },
        maxResults: { type: "integer", minimum: 1, maximum: 500 },
        sortBy: { type: "string", enum: ["risk", "impact", "path"] },
        groupBy: { type: "string", enum: ["file", "module"] },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleDetectChanges(input, buildContext())))
  });

  const detectCircularDependencies = defineTool({
    name: "detect_circular_dependencies",
    description: "Detect circular dependencies via DFS on graph edges. Supports mode='module' or mode='symbol' and returns explicit cycle paths.",
    input: schemas.detectCircularDependenciesSchema(limits.maxDepth, limits.maxResultLimit),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId"],
      properties: {
        repoId: { type: "string" },
        filePathPrefix: { type: "string" },
        mode: { type: "string", enum: ["module", "symbol"] },
        includeCalls: { type: "boolean" },
        maxDepth: { type: "integer", minimum: 2, maximum: limits.maxDepth },
        maxCycles: { type: "integer", minimum: 1, maximum: 200 },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleDetectCircularDependencies(input, buildContext())))
  });

  const deadCodeScan = defineTool({
    name: "dead_code_scan",
    description: "Find likely dead symbols using deterministic graph rules: symbols with no incoming CALLS/TYPE_REF/IMPORTS edges (excluding bootstrap entry files).",
    input: schemas.deadCodeScanSchema(limits.maxResultLimit),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId"],
      properties: {
        repoId: { type: "string" },
        filePathPrefix: { type: "string" },
        language: { type: "string" },
        kind: { type: "string" },
        includePrivate: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: limits.maxResultLimit },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleDeadCodeScan(input, buildContext())))
  });

  const linkTestsToSource = defineTool({
    name: "link_tests_to_source",
    description: "Link tests to likely source files using deterministic naming heuristics plus IMPORTS/CALLS tracing.",
    input: schemas.linkTestsToSourceSchema(limits.maxResultLimit),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId"],
      properties: {
        repoId: { type: "string" },
        filePath: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: limits.maxResultLimit },
        maxCandidates: { type: "integer", minimum: 1, maximum: 20 },
        minScore: { type: "number", minimum: 0, maximum: 1 },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleLinkTestsToSource(input, buildContext())))
  });

  const getCrossRepoImpact = defineTool({
    name: "get_cross_repo_impact",
    description: "Expose cross-repo dependencies for a symbol from cross_repo_deps. Supports outbound or inbound direction.",
    input: schemas.crossRepoImpactSchema(limits.maxResultLimit),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId"],
      properties: {
        repoId: { type: "string" },
        symbolId: { type: "string" },
        name: { type: "string" },
        direction: { type: "string", enum: ["outbound", "inbound"] },
        limit: { type: "integer", minimum: 1, maximum: limits.maxResultLimit },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleGetCrossRepoImpact(input, buildContext())))
  });

  const findPackageConsumers = defineTool({
    name: "find_package_consumers",
    description: "Find repositories/symbols that depend on a NuGet package contract (nuget:<name>) without requiring a symbolId.",
    input: schemas.findPackageConsumersSchema(limits.maxResultLimit),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["packageName"],
      properties: {
        packageName: { type: "string" },
        repoId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: limits.maxResultLimit },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleFindPackageConsumers(input, buildContext())))
  });

  const traceExecutionFlow = defineTool({
    name: "trace_execution_flow",
    description: "BFS-trace the call graph starting from an entry symbol, following CALLS edges outbound up to maxDepth levels. Returns nodes and edges forming the execution sub-graph. Use to understand how a method propagates through the codebase.",
    input: schemas.traceExecutionFlowSchema,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId", "entrySymbolId"],
      properties: {
        repoId: { type: "string" },
        entrySymbolId: { type: "string" },
        maxDepth: { type: "integer", minimum: 1, maximum: 8 },
        maxNodes: { type: "integer", minimum: 1, maximum: 100 },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleTraceExecutionFlow(input, buildContext())))
  });

  return [
    getDependencyGraph,
    getCallChain,
    findImpactFiles,
    getChangeContext,
    getSymbolContextPack,
    detectChanges,
    detectCircularDependencies,
    deadCodeScan,
    linkTestsToSource,
    getCrossRepoImpact,
    findPackageConsumers,
    traceExecutionFlow
  ];
}
