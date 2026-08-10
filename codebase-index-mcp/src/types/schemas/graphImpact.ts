/**
 * Input schemas for the graph-traversal and impact tools.
 *
 * Split out of `toolSchemas.ts` in S-41: it had reached 615 lines, past the 600-line hard cap. The
 * grouping mirrors `src/tools/` — the same batches S-32 migrated — so a tool and its schema sit in
 * files with the same name. Declaration order within each file is unchanged, which matters: several
 * schemas are built from the fragments above them.
 */

import { z } from "zod";
import { responseProfileSchema } from "./shared.js";

// Dependency graph
export const getDependencyGraphSchema = (MAX_DEPTH: number, MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    symbolId: z.string().min(1).max(200).optional(),
    filePath: z.string().min(1).optional(),
    depth: z.number().int().min(1).max(MAX_DEPTH).default(1),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100),
    profile: responseProfileSchema.default("compact")
  })
  .strict()
  .refine((v) => Boolean(v.symbolId || v.filePath), {
    message: "symbolId or filePath is required",
    path: ["symbolId"]
  });

// Call chain
export const getCallChainSchema = (MAX_DEPTH: number, MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    symbolId: z.string().min(1).max(200),
    direction: z.enum(["callers", "callees"]).default("callees"),
    depth: z.number().int().min(1).max(MAX_DEPTH).default(1),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100),
    // MCP-ISSUE-056: interface dispatch fans hardest into test doubles, so the call-graph tools
    // are exactly where a test filter is most load-bearing — see the note on the handlers.
    excludeTests: z.boolean().default(false),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Impact files
export const findImpactFilesSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    filePath: z.string().min(1),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(50),
    groupBy: z.enum(["file", "module"]).default("file"),
    view: z.enum(["files", "surface"]).default("files"),
    // MCP-ISSUE-056: interface dispatch fans hardest into test doubles, so the call-graph tools
    // are exactly where a test filter is most load-bearing — see the note on the handlers.
    excludeTests: z.boolean().default(false),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Change context
export const getChangeContextSchema = (MAX_DEPTH: number, MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    symbolId: z.string().min(1).max(200).optional(),
    name: z.string().min(1).max(200).optional(),
    callerDepth: z.number().int().min(1).max(MAX_DEPTH).default(2),
    calleeDepth: z.number().int().min(1).max(MAX_DEPTH).default(1),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(20),
    // MCP-ISSUE-056: interface dispatch fans hardest into test doubles, so the call-graph tools
    // are exactly where a test filter is most load-bearing — see the note on the handlers.
    excludeTests: z.boolean().default(false),
    profile: responseProfileSchema.default("compact")
  })
  .strict()
  .refine((v) => Boolean(v.symbolId || v.name), {
    message: "symbolId or name is required",
    path: ["symbolId"]
  });

// Symbol context pack
export const getSymbolContextPackSchema = (MAX_DEPTH: number, MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    callerDepth: z.number().int().min(1).max(MAX_DEPTH).default(2),
    calleeDepth: z.number().int().min(1).max(MAX_DEPTH).default(1),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(20),
    excludeTests: z.boolean().default(false),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Detect changes
export const detectChangesSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    baseRef: z.string().min(1).max(100).optional(),
    headRef: z.string().min(1).max(100).default("HEAD"),
    includeUntracked: z.boolean().default(true),
    maxFiles: z.number().int().min(1).max(500).default(100),
    impactLimit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(20),
    policy: z.enum(["quick-triage", "strict-review", "release-gate", "custom"]).default("custom"),
    minRiskScore: z.number().int().min(0).max(100).optional(),
    riskLevels: z.array(z.enum(["high", "medium", "low"])).min(1).max(3).optional(),
    maxResults: z.number().int().min(1).max(500).optional(),
    sortBy: z.enum(["risk", "impact", "path"]).optional(),
    groupBy: z.enum(["file", "module"]).default("file"),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Dead code scan
export const deadCodeScanSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    filePathPrefix: z.string().max(500).optional(),
    language: z.string().max(50).optional(),
    kind: z.string().max(50).optional(),
    includePrivate: z.boolean().default(false),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Detect circular dependencies
export const detectCircularDependenciesSchema = (MAX_DEPTH: number, MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    filePathPrefix: z.string().max(500).optional(),
    mode: z.enum(["module", "symbol"]).default("module"),
    includeCalls: z.boolean().default(false),
    maxDepth: z.number().int().min(2).max(MAX_DEPTH).default(Math.min(4, MAX_DEPTH)),
    maxCycles: z.number().int().min(1).max(200).default(50),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Cross repo impact
export const crossRepoImpactSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    symbolId: z.string().min(1).max(200).optional(),
    name: z.string().min(1).max(200).optional(),
    direction: z.enum(["outbound", "inbound"]).default("outbound"),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(50),
    profile: responseProfileSchema.default("compact")
  })
  .strict()
  .refine((v) => Boolean(v.symbolId || v.name), {
    message: "symbolId or name is required",
    path: ["symbolId"]
  });

// Find package consumers
export const findPackageConsumersSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    packageName: z.string().min(1).max(200),
    repoId: z.string().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Link tests to source
export const linkTestsToSourceSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    filePath: z.string().max(500).optional(),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100),
    maxCandidates: z.number().int().min(1).max(20).default(3),
    minScore: z.number().min(0).max(1).default(0.4),
    // MCP-ISSUE-056/058(c): drop test files from the SOURCE side of each pair. A test-to-test link
    // is never the answer to "what covers this file".
    excludeTests: z.boolean().default(false),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Trace execution flow
export const traceExecutionFlowSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    entrySymbolId: z.string().min(1).max(200),
    maxDepth: z.number().int().min(1).max(8).default(4),
    maxNodes: z.number().int().min(1).max(100).default(30),
    // MCP-ISSUE-056: interface dispatch fans hardest into test doubles, so the call-graph tools
    // are exactly where a test filter is most load-bearing — see the note on the handlers.
    excludeTests: z.boolean().default(false),
    profile: responseProfileSchema.default("compact")
  })
  .strict();
