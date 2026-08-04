/**
 * Input schemas for the refactor tools.
 *
 * Split out of `toolSchemas.ts` in S-41: it had reached 615 lines, past the 600-line hard cap. The
 * grouping mirrors `src/tools/` — the same batches S-32 migrated — so a tool and its schema sit in
 * files with the same name. Declaration order within each file is unchanged, which matters: several
 * schemas are built from the fragments above them.
 */

import { z } from "zod";
import { responseProfileSchema, refactorScopeSchema, refactorGuardsSchema, refactorInitializerRewriteSchema, refactorCompilerAssistSchema, refactorSymbolKindSchema } from "./shared.js";

// Field accesses (ISSUE-018) — read/write callsites of a property
export const findFieldAccessesSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    symbolId: z.string().min(1).max(200).optional(),
    name: z.string().min(1).max(200).optional(),
    mode: z.enum(["read", "write", "all"]).default("all"),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100),
    profile: responseProfileSchema.default("compact")
  })
  .strict()
  .refine((v) => Boolean(v.symbolId || v.name), {
    message: "symbolId or name is required",
    path: ["symbolId"]
  });

// Change impact (ENH-E): changed files → dependents → covering tests → tests-to-run + residual risk
export const changeImpactSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    baseRef: z.string().min(1).max(100).optional(),
    headRef: z.string().min(1).max(100).default("HEAD"),
    includeUntracked: z.boolean().default(true),
    maxFiles: z.number().int().min(1).max(500).default(100),
    impactLimit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(20),
    testLinkMinScore: z.number().min(0).max(1).default(0.4),
    testLinkMaxCandidates: z.number().int().min(1).max(20).default(3),
    maxTestsToRun: z.number().int().min(1).max(500).default(50),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Symbol blame
export const symbolBlameSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    symbolId: z.string().min(1).max(200).optional(),
    name: z.string().min(1).max(200).optional(),
    redactEmail: z.boolean().default(true),
    profile: responseProfileSchema.default("compact")
  })
  .strict()
  .refine((v) => Boolean(v.symbolId || v.name), {
    message: "symbolId or name is required",
    path: ["symbolId"]
  });

// Rename assist
export const renameAssistSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    symbolId: z.string().min(1).max(200),
    newName: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(50),
    emitPreview: z.boolean().default(false),
    wholeWord: z.boolean().default(true),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

export const refactorReplacePreviewSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    find: z.string().min(1).max(2_000),
    replaceExpression: z.string().max(2_000),
    findMode: z.enum(["literal", "regex"]).default("literal"),
    regexFlags: z.string().max(8).regex(/^[ims]*$/, "regexFlags may only contain i, m, s").optional(),
    scope: refactorScopeSchema,
    guards: refactorGuardsSchema,
    compilerAssist: refactorCompilerAssistSchema.optional(),
    mode: z.enum(["text", "syntax-aware", "symbol-aware"]).default("symbol-aware"),
    ambiguityThresholdPercent: z.number().min(0).max(100).default(1),
    profile: responseProfileSchema.default("standard")
  })
  .strict();

export const refactorReplaceApplySchema = z
  .object({
    previewId: z.string().min(1).max(200),
    approvalToken: z.string().min(1).max(2_000),
    maxFilesPerBatch: z.number().int().min(1).max(500).default(50),
    stopOnFirstConflict: z.boolean().default(true),
    includeLowConfidence: z.boolean().default(false),
    profile: responseProfileSchema.default("standard")
  })
  .strict();

export const refactorReplaceRollbackSchema = z
  .object({
    rollbackId: z.string().min(1).max(200)
  })
  .strict();

export const refactorSymbolMigrationSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    migrations: z
      .array(
        z
          .object({
            fromSymbol: z.string().min(1).max(500),
            toSymbol: z.string().min(1).max(500),
            requiredOwnerType: z.string().min(1).max(200),
            forbiddenOwnerTypes: z.array(z.string().min(1).max(200)).max(200).default([]),
            // MCP-ISSUE-043: was hardcoded to ["property","field"], which silently dropped every
            // method site before the owner prover ran. Empty (the default) means any kind.
            symbolKinds: z.array(refactorSymbolKindSchema).max(10).default([]),
            initializerRewrite: refactorInitializerRewriteSchema.optional()
          })
          .strict()
      )
      .min(1)
      .max(200),
    scopePaths: z.array(z.string().min(1).max(500)).max(200).default([]),
    dryRun: z.boolean().default(true),
    includeLowConfidence: z.boolean().default(false)
  })
  .strict();

export const changeValueRepresentationSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    property: z.string().min(1).max(200),
    requiredOwnerType: z.string().min(1).max(200),
    valueMap: z.record(z.string().min(1).max(500), z.string().min(1).max(500)),
    includeComparisons: z.boolean().default(true),
    scopePaths: z.array(z.string().min(1).max(500)).max(200).default([]),
    dryRun: z.boolean().default(true),
    includeLowConfidence: z.boolean().default(false),
    profile: responseProfileSchema.default("standard")
  })
  .strict()
  .refine((v) => Object.keys(v.valueMap).length >= 1, { message: "valueMap must have at least one entry", path: ["valueMap"] });

export const getValueContractImpactSchema = z
  .object({
    value: z.string().min(1).max(500),
    column: z.string().min(1).max(200).optional(),
    repoIds: z.array(z.string().min(1).max(200)).max(50).optional(),
    profile: responseProfileSchema.default("compact")
  })
  .strict();
