/**
 * Input schemas for the read/metadata tools.
 *
 * Split out of `toolSchemas.ts` in S-41: it had reached 615 lines, past the 600-line hard cap. The
 * grouping mirrors `src/tools/` — the same batches S-32 migrated — so a tool and its schema sit in
 * files with the same name. Declaration order within each file is unchanged, which matters: several
 * schemas are built from the fragments above them.
 */

import { z } from "zod";
import { responseProfileSchema } from "./shared.js";

// Health check
export const healthCheckSchema = z
  .object({
    repoId: z.string().min(1).max(200).optional()
  })
  .strict();

// List repositories
export const listRepositoriesSchema = z.object({ profile: responseProfileSchema.default("compact").optional() }).strict();

// File context
export const getFileContextSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    filePath: z.string().min(1).optional(),
    filePaths: z.array(z.string().min(1)).min(1).max(50).optional(),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(200),
    compact: z.boolean().default(false),
    profile: responseProfileSchema.default("compact")
  })
  .strict()
  .refine((v) => Boolean(v.filePath || v.filePaths), {
    message: "filePath or filePaths is required",
    path: ["filePath"]
  });

// File summary
export const getFileSummarySchema = z
  .object({
    repoId: z.string().min(1).max(200),
    filePath: z.string().min(1),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Query docs
export const queryDocsSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    mode: z.enum(["search", "stale", "coverage"]),
    query: z.string().min(1).max(200).optional(),
    symbolIds: z.array(z.string().min(1).max(200)).min(1).max(100).optional(),
    filePath: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(20),
    profile: responseProfileSchema.default("compact")
  })
  .strict()
  .refine(
    (v) => {
      if (v.mode === "search") return Boolean(v.query);
      if (v.mode === "stale") return Boolean(v.symbolIds);
      if (v.mode === "coverage") return Boolean(v.filePath);
      return true;
    },
    (v) => ({
      message: v.mode === "search" ? "query is required for mode=search" : v.mode === "stale" ? "symbolIds is required for mode=stale" : "filePath is required for mode=coverage",
      path: ["query"]
    })
  );

// Orient (ENH-F): deterministic intent router → recommended tools + seed symbols (NO LLM)
export const orientSchema = z
  .object({
    repoId: z.string().min(1).max(200).optional(),
    intent: z.string().min(1).max(500),
    seed: z.string().min(1).max(200).optional(),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Folder summary
export const getFolderSummarySchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    folderPath: z.string().min(1),
    maxFiles: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Find entry points
export const findEntryPointsSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    filePathPrefix: z.string().max(500).optional(),
    kind: z.string().max(50).optional(),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(50),
    profile: responseProfileSchema.default("compact")
  })
  .strict();
