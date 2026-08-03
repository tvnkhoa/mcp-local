/**
 * Input schemas for the indexing and watch tools.
 *
 * Split out of `toolSchemas.ts` in S-41: it had reached 615 lines, past the 600-line hard cap. The
 * grouping mirrors `src/tools/` — the same batches S-32 migrated — so a tool and its schema sit in
 * files with the same name. Declaration order within each file is unchanged, which matters: several
 * schemas are built from the fragments above them.
 */

import { z } from "zod";
import { responseProfileSchema } from "./shared.js";

// Index repository
export const indexRepositorySchema = (MAX_FILES_PER_RUN: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    repoPath: z.string().min(1),
    mode: z.enum(["full", "incremental", "dirty"]).default("incremental"),
    docsMode: z.enum(["auto", "on", "off"]).default("auto"),
    maxFiles: z.number().int().min(1).max(MAX_FILES_PER_RUN).default(MAX_FILES_PER_RUN),
    batchSize: z.number().int().min(1).max(2_000).default(200)
  })
  .strict();

// Feature bundle (ENH-B): gather a vertical-slice feature (entity → config → commands/queries → endpoints) from one seed
export const getFeatureBundleSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    seedSymbol: z.string().min(1).max(200).optional(),
    seedFile: z.string().min(1).max(500).optional(),
    convention: z.enum(["csharp-vertical-slice"]).default("csharp-vertical-slice"),
    maxFiles: z.number().int().min(1).max(60).default(25),
    maxBytesPerFile: z.number().int().min(1).max(20000).default(8000),
    includeSource: z.boolean().default(true),
    profile: responseProfileSchema.default("compact")
  })
  .strict()
  .refine((v) => Boolean(v.seedSymbol || v.seedFile), {
    message: "seedSymbol or seedFile is required",
    path: ["seedSymbol"]
  });

// Watch repo
export const watchRepoSchema = z
  .object({
    action: z.enum(["start", "stop", "status"]),
    repoId: z.string().min(1).max(200).optional(),
    repoPath: z.string().min(1).optional()
  })
  .strict();

export const getPersistenceMappingSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    property: z.string().min(1).max(200),
    ownerType: z.string().min(1).max(200).optional(),
    profile: responseProfileSchema.default("compact")
  })
  .strict();
