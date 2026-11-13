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
    description: "What a symbol or file depends on: IMPORTS/DEPENDS_ON edges for a symbol (symbolId) or module-level flow edges for a file (filePath); one required. Who depends on a file → find_impact_files. profile='nano' gives a top-10 edge count; 'compact' (default) all edges with minimal fields.",
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
    description: "Call path between methods: the path from a callable symbolId (function/method, not a class) toward its callers or callees (direction). A path, not a list — every caller → get_change_context; forward execution sub-graph → trace_execution_flow. profile='nano' gives the first 10 hops; 'compact' (default) the full edge list. excludeTests=true drops test-path results entirely. A SQL name defined at several sites (a table in archive/ and the baseline, a replaced function) binds its references to the CURRENT definition only; `sqlDefinition` says whether this site is current and lists `alsoDefinedAt` (file:line).",
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
        excludeTests: { type: "boolean" },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleGetCallChain(input, buildContext())))
  });

  const findImpactFiles = defineTool({
    name: "find_impact_files",
    description: "Who imports this file? The importers and dependents of a FILE (view='files', default), or the external symbols that call into it (view='surface'). One symbol's callers → get_change_context; your diff → change_impact. Use before refactor_replace_preview to scope a change. profile='nano' gives a top-10 count; 'compact' (default) the full list. A stale index adds a non-fatal `staleWarning` (re-index for exact results). excludeTests=true drops test-path results entirely.",
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
        excludeTests: { type: "boolean" },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: async (input) => ok(raw(await handleFindImpactFiles(input, buildContext())))
  });

  const getChangeContext = defineTool({
    name: "get_change_context",
    description: "Callers of a function or symbol: who calls X (BFS up to callerDepth), plus its callees and type deps. Accepts symbolId or name (one required). One call path → get_call_chain; who imports a file → find_impact_files. profile=nano gives the top-10 callers; compact (default) for planning; standard balanced; verbose for debugging. A stale index adds a non-fatal `staleWarning`. excludeTests=true drops test-path results entirely.",
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
        excludeTests: { type: "boolean" },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: async (input) => ok(raw(await handleGetChangeContext(input, buildContext())))
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
    description: "Risk score of changed files before merge or review: changed files from git, their graph impact and deterministic risk (high/medium/low). Policy presets quick-triage|strict-review|release-gate|custom. Tests to run for the diff → change_impact. baseRef defaults to the latest indexed commit when available. Each changed path says added/modified/deleted; a rename lists both paths (renamedFrom/renamedTo), and a removed path's dependents are the files whose imports still resolve to it. Range mode pairs renames at git's default similarity (-M, 50%): a move rewritten past that reads as a delete plus an add.",
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
    description:
      "Which tests cover a source file: links tests to source files by deterministic naming heuristics plus IMPORTS/CALLS tracing. excludeTests=true drops test-path results entirely. " +
      "forWorkingTreeDiff=true answers 'which tests does my uncommitted change need': the dirty files (staged, unstaged, untracked) → reverse closure over IMPORTS, USES_COMPONENT and workspace-package imports (maxDepth, maxFiles; truncation reported) → the tests reached, every changed test file itself, and name links with score >= minScore (default 0.7 in this mode; lower ones are dropped and counted in belowMinScore). Each test carries `why`. " +
      "Per package it reads the nearest vitest/vite config lexically (include, exclude, root, test.projects; never executed — an unreadable value is named and the package dir is used) and emits one command that runs the package's own vitest binary, e.g. `cd packages/core && ./node_modules/.bin/vitest run <files>` — never a package manager, which can rewrite tracked config or create a store in the tree (node_modules must already be installed); tests no include admits are listed in `excluded` with the reason. A node:test file gets runner 'unknown' and a `node --test` hint. Nothing is executed.",
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
        minScore: { type: "number", minimum: 0, maximum: 1, description: "Score floor for name/score links. Default 0.4; 0.7 with forWorkingTreeDiff." },
        excludeTests: { type: "boolean" },
        forWorkingTreeDiff: { type: "boolean", description: "Tests for the working-tree diff plus a vitest command per package. Exclusive with filePath." },
        maxDepth: { type: "integer", minimum: 1, maximum: 12, description: "forWorkingTreeDiff: reverse-import hops from a changed file (default 6)." },
        maxFiles: { type: "integer", minimum: 1, maximum: 20000, description: "forWorkingTreeDiff: files the closure may reach before it stops and reports truncation (default 2000)." },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleLinkTestsToSource(input, buildContext())))
  });

  const getCrossRepoImpact = defineTool({
    name: "get_cross_repo_impact",
    description:
      "Expose cross-repo dependencies for a symbol (or every symbol of a file, via filePath) from cross_repo_deps. Supports outbound or inbound direction. " +
      "HTTP endpoints link across repos: a controller action (or its file) with direction:'inbound' lists the consumers whose endpoint matches its route — " +
      "C# HttpClient calls and declared JS/TS route sources (`source: 'scheme:GET /path'`), with the consumer's file:line, route and tool name and the match kind " +
      "(exact, wildcard on path parameters, or gateway_prefix when the consumer path carries a gateway prefix the provider does not declare).",
    input: schemas.crossRepoImpactSchema(limits.maxResultLimit),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId"],
      properties: {
        repoId: { type: "string" },
        symbolId: { type: "string" },
        name: { type: "string", description: "An exact symbol name. Every declaration of that name is considered: the one carrying an endpoint contract (a controller action) is preferred, and nameResolution says how it was picked; if several remain the answer is status \"ambiguous\" with every candidate (symbolId, file, line, endpointContracts) and no count. Pass symbolId to pin one." },
        filePath: { type: "string", description: "Repo-relative file: query every symbol it declares (its endpoint contracts included)." },
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
    description: "Find repositories/symbols that depend on a NuGet package contract, without requiring a symbolId. The package argument accepts either the bare name or the nuget:<name> form — both normalize to nuget:<lowercased>, so the prefix is optional, not required.",
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
    description: "Forward execution flow from an entry symbol: BFS over outbound CALLS edges up to maxDepth, returning the nodes and edges of the sub-graph — how a method propagates through the codebase. Inbound callers → get_change_context; a single path → get_call_chain. excludeTests=true drops test-path results entirely.",
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
        excludeTests: { type: "boolean" },
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
