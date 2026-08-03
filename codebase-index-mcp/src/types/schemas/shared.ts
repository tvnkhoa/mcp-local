/**
 * Fragments more than one tool group builds on, including the response-profile enum every schema references.
 *
 * Split out of `toolSchemas.ts` in S-41: it had reached 615 lines, past the 600-line hard cap. The
 * grouping mirrors `src/tools/` — the same batches S-32 migrated — so a tool and its schema sit in
 * files with the same name. Declaration order within each file is unchanged, which matters: several
 * schemas are built from the fragments above them.
 */

import { z } from "zod";

// Response profile schema used across multiple tools
export const responseProfileSchema = z.enum(["nano", "compact", "standard", "verbose"]);

// Refactor schemas
const refactorSymbolKindSchema = z.enum(["class", "property", "field", "method"]);

export const refactorScopeSchema = z
  .object({
    includePaths: z.array(z.string().min(1).max(500)).max(200).default([]),
    excludePaths: z.array(z.string().min(1).max(500)).max(200).default([]),
    fileGlobs: z.array(z.string().min(1).max(500)).max(200).default([])
  })
  .strict()
  .default({ includePaths: [], excludePaths: [], fileGlobs: [] });

export const refactorGuardsSchema = z
  .object({
    language: z.string().min(1).max(50).optional(),
    symbolKinds: z.array(refactorSymbolKindSchema).max(10).default([]),
    allowOwnerTypes: z.array(z.string().min(1).max(200)).max(200).default([]),
    disallowOwnerTypes: z.array(z.string().min(1).max(200)).max(200).default([]),
    disallowTypeList: z.array(z.string().min(1).max(200)).max(200).default([])
  })
  .strict()
  .default({ symbolKinds: [], allowOwnerTypes: [], disallowOwnerTypes: [], disallowTypeList: [] });

export const refactorInitializerRewriteSchema = z
  .object({
    objectProperty: z.string().min(1).max(200),
    objectType: z.string().min(1).max(200),
    targetMember: z.string().min(1).max(200).optional()
  })
  .strict();

const refactorCompilerDiagnosticSchema = z
  .object({
    code: z.string().min(1).max(20),
    filePath: z.string().min(1).max(500),
    line: z.number().int().min(1).max(2_000_000),
    message: z.string().max(1_000).optional(),
    expectedType: z.string().min(1).max(300).optional(),
    actualType: z.string().min(1).max(300).optional()
  })
  .strict();

export const refactorCompilerAssistSchema = z
  .object({
    diagnostics: z.array(refactorCompilerDiagnosticSchema).max(1_000).default([]),
    codes: z.array(z.string().min(1).max(20)).max(20).default(["CS0029", "CS1503"]),
    lineWindow: z.number().int().min(0).max(20).default(2),
    filePathPrefix: z.string().min(1).max(500).optional()
  })
  .strict();
