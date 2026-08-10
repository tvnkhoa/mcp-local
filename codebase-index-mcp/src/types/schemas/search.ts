/**
 * Input schemas for the search tools.
 *
 * Split out of `toolSchemas.ts` in S-41: it had reached 615 lines, past the 600-line hard cap. The
 * grouping mirrors `src/tools/` — the same batches S-32 migrated — so a tool and its schema sit in
 * files with the same name. Declaration order within each file is unchanged, which matters: several
 * schemas are built from the fragments above them.
 */

import { z } from "zod";
import { responseProfileSchema } from "./shared.js";

// Search symbols
export const searchSymbolsSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    query: z.string().min(1).max(200),
    repoId: z.string().min(1).max(200).optional(),
    language: z.string().max(50).optional(),
    kind: z.string().max(50).optional(),
    filePath: z.string().max(500).optional(),
    strategy: z.enum(["name", "intent"]).default("name"),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(50),
    compact: z.boolean().default(false),
    profile: responseProfileSchema.default("compact"),
    ranked: z.boolean().default(false),
    excludeTests: z.boolean().default(false)
  })
  .strict();

// Search string literals (ISSUE-023)
export const searchLiteralsSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    query: z.string().min(1).max(200),
    filePath: z.string().max(500).optional(),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(50),
    excludeTests: z.boolean().default(false),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Regex source search
export const searchRegexSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    pattern: z.string().min(1).max(500),
    regexFlags: z.string().max(8).regex(/^[ims]*$/).optional(),
    filePathPrefix: z.union([z.string().max(500), z.array(z.string().max(500)).max(20)]).optional(),
    pathExclude: z.union([z.string().max(500), z.array(z.string().max(500)).max(20)]).optional(),
    language: z.string().max(50).optional(),
    excludeTests: z.boolean().default(false),
    scanAll: z.boolean().default(false),
    contextLines: z.number().int().min(0).max(10).default(2),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(50),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Symbol detail
export const getSymbolDetailSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    symbolId: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100),
    // MCP-ISSUE-056: interface dispatch fans hardest into test doubles, so the call-graph tools
    // are exactly where a test filter is most load-bearing — see the note on the handlers.
    excludeTests: z.boolean().default(false),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Find symbol at line
export const findSymbolAtLineSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    filePath: z.string().min(1),
    line: z.number().int().min(1),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Symbol source span
export const getSymbolSourceSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    symbolId: z.string().min(1).max(200).optional(),
    name: z.string().min(1).max(200).optional(),
    contextLines: z.number().int().min(0).max(50).default(0),
    maxLines: z.number().int().min(1).max(2000).default(400),
    profile: responseProfileSchema.default("compact")
  })
  .strict()
  .refine((v) => Boolean(v.symbolId || v.name), {
    message: "symbolId or name is required",
    path: ["symbolId"]
  });

// Find implementations
export const findImplementationsSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    interfaceName: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(50),
    excludeTests: z.boolean().default(false),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Route map
export const routeMapSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    filePathPrefix: z.string().max(500).optional(),
    httpMethod: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional(),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100),
    excludeTests: z.boolean().default(false),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Query graph
const queryGraphParamsValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const queryGraphSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    sql: z.string().min(1).max(10_000),
    params: z.record(queryGraphParamsValueSchema).default({}),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100),
    timeoutMs: z.number().int().min(1).max(30_000).default(5_000),
    profile: responseProfileSchema.default("compact")
  })
  .strict();
