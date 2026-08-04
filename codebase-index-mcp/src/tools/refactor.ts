/**
 * Batch 5 — refactor. Highest risk, migrated last: preview/apply/rollback is approval-gated and
 * mutates files on disk (S-32).
 *
 * Same construction as batches 1–4. Two things are specific to this group:
 *
 *   - **Annotations are the whole point here.** This is the batch where a host's confirmation
 *     prompt actually protects something, so `refactor_replace_apply` and
 *     `refactor_replace_rollback` are marked destructive while the preview/dry-run tools are
 *     not. The reasoning sits on the presets in `common.ts`.
 *   - **Three handlers are async, and the legacy switch treated them inconsistently.**
 *     `refactor_symbol_migration` and `change_value_representation` used `return await`;
 *     `refactor_replace_apply` used a plain `return`, which inside a `try` does not route a
 *     rejection to the catch. Measured against the pre-S-31 build, that made a failed apply
 *     (unknown previewId, PREVIEW_EXPIRED, AMBIGUITY_THRESHOLD_EXCEEDED, unknown repo) surface
 *     as a raw JSON-RPC error while its two siblings returned the normal
 *     `{ code, message, requestId }` envelope. All three now await, so all three report the
 *     envelope. See the S-32 notes in `docs/archive/migration/status.md`.
 */

import { ok } from "@mcp/core";
import type { AnyToolDefinition } from "@mcp/sdk";
import { defineTool } from "@mcp/sdk";

import { handleFindFieldAccesses } from "./handlers/impactHandler.js";
import { handleChangeImpact } from "./handlers/indexHandler.js";
import { handleGetValueContractImpact } from "./handlers/persistenceHandler.js";
import {
  handleChangeValueRepresentation,
  handleRefactorReplaceApply,
  handleRefactorReplacePreview,
  handleRefactorReplaceRollback,
  handleRefactorSymbolMigration,
  handleRenameAssist
} from "./handlers/refactorHandler.js";
import { handleGetSymbolBlame } from "./handlers/searchHandler.js";
import * as schemas from "../types/schemas/toolSchemas.js";

import {
  PROFILE_PROP,
  appliesChange,
  previewsChange,
  raw,
  readsGraph,
  revertsChange,
  type CodebaseIndexDeps
} from "./common.js";

export function buildRefactorTools(deps: CodebaseIndexDeps): AnyToolDefinition[] {
  const { limits, buildContext } = deps;

  const renameAssist = defineTool({
    name: "rename_assist",
    description: "Rename impact for a symbol: returns all callers and importers that need updating. Default (emitPreview=false) is read-only advisory (hints). Set emitPreview=true to get an applyable refactor preview (previewId + approvalToken) that renames the identifier on word boundaries across the affected files — then call refactor_replace_apply (use includeLowConfidence=true for top-level identifiers, which have no enclosing owner type). Use before refactoring to understand blast radius, or to execute the rename directly.",
    input: schemas.renameAssistSchema(limits.maxResultLimit),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId", "symbolId", "newName"],
      properties: {
        repoId: { type: "string" },
        symbolId: { type: "string" },
        newName: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: limits.maxResultLimit },
        emitPreview: { type: "boolean", description: "Return an applyable refactor preview instead of read-only hints." },
        wholeWord: { type: "boolean", description: "Match the identifier on word boundaries (default true)." },
        profile: PROFILE_PROP
      }
    },
    // `previewsChange` rather than `readsGraph`: with emitPreview=true it persists a preview
    // row and mints an approval token, so it is not idempotent even though it writes no source.
    annotations: previewsChange,
    rawResult: true,
    handler: (input) => ok(raw(handleRenameAssist(input, buildContext())))
  });

  const refactorReplacePreview = defineTool({
    name: "refactor_replace_preview",
    description: "Preview bulk replacements with scope and type-ownership guards. findMode='literal' (default) matches `find` as plain text; findMode='regex' treats `find` as a regular expression and substitutes capture-group backreferences in `replaceExpression` — numbered ($1..$99), whole-match ($&), named ($<name> or ${name}), and a literal `$` via $$ — ideal for context-preserving bulk edits in one pass. A backreference to a group that did not match is flagged `unsubstituted_backreference` and blocked at apply (it is never silently written). profile='nano' returns only match count + affected files (fastest blast-radius check); 'compact' omits before/after text; 'standard' (default) returns full hunk content.",
    input: schemas.refactorReplacePreviewSchema,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId", "find", "replaceExpression"],
      properties: {
        repoId: { type: "string" },
        find: { type: "string" },
        replaceExpression: { type: "string" },
        findMode: { type: "string", enum: ["literal", "regex"] },
        regexFlags: { type: "string", description: "Optional regex flags, subset of i|m|s (g is always applied)." },
        profile: PROFILE_PROP,
        scope: {
          type: "object",
          additionalProperties: false,
          properties: {
            includePaths: { type: "array", items: { type: "string" }, maxItems: 200 },
            excludePaths: { type: "array", items: { type: "string" }, maxItems: 200 },
            fileGlobs: { type: "array", items: { type: "string" }, maxItems: 200 }
          }
        },
        guards: {
          type: "object",
          additionalProperties: false,
          properties: {
            language: { type: "string" },
            symbolKinds: { type: "array", items: { type: "string", enum: ["class", "property", "field", "method"] }, maxItems: 10 },
            allowOwnerTypes: { type: "array", items: { type: "string" }, maxItems: 200 },
            disallowOwnerTypes: { type: "array", items: { type: "string" }, maxItems: 200 },
            disallowTypeList: { type: "array", items: { type: "string" }, maxItems: 200 }
          }
        },
        compilerAssist: {
          type: "object",
          additionalProperties: false,
          properties: {
            diagnostics: {
              type: "array",
              maxItems: 1000,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["code", "filePath", "line"],
                properties: {
                  code: { type: "string" },
                  filePath: { type: "string" },
                  line: { type: "integer", minimum: 1 },
                  message: { type: "string" },
                  expectedType: { type: "string" },
                  actualType: { type: "string" }
                }
              }
            },
            codes: { type: "array", items: { type: "string" }, maxItems: 20 },
            lineWindow: { type: "integer", minimum: 0, maximum: 20 },
            filePathPrefix: { type: "string" }
          }
        },
        mode: { type: "string", enum: ["text", "syntax-aware", "symbol-aware"] },
        ambiguityThresholdPercent: { type: "number", minimum: 0, maximum: 100 }
      }
    },
    annotations: previewsChange,
    rawResult: true,
    handler: (input) => ok(raw(handleRefactorReplacePreview(input, buildContext())))
  });

  const refactorReplaceApply = defineTool({
    name: "refactor_replace_apply",
    description: "Apply an approved replacement plan using previewId and approvalToken from preview. profile='nano' returns only success status + file count. profile='compact' omits expectedFiles list. profile='standard' (default) returns full scope check.",
    input: schemas.refactorReplaceApplySchema,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["previewId", "approvalToken"],
      properties: {
        previewId: { type: "string" },
        approvalToken: { type: "string" },
        maxFilesPerBatch: { type: "integer", minimum: 1, maximum: 500 },
        stopOnFirstConflict: { type: "boolean" },
        includeLowConfidence: { type: "boolean" },
        profile: PROFILE_PROP
      }
    },
    annotations: appliesChange,
    rawResult: true,
    // Awaited. The pre-S-31 switch did not, which sent every failed apply out as a raw JSON-RPC
    // error instead of this server's envelope — losing the PolicyViolationError code with it.
    handler: async (input) => ok(raw(await handleRefactorReplaceApply(input, buildContext())))
  });

  const refactorReplaceRollback = defineTool({
    name: "refactor_replace_rollback",
    description: "Rollback one previous apply operation by rollbackId.",
    input: schemas.refactorReplaceRollbackSchema,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["rollbackId"],
      properties: {
        rollbackId: { type: "string" }
      }
    },
    annotations: revertsChange,
    rawResult: true,
    handler: (input) => ok(raw(handleRefactorReplaceRollback(input, buildContext())))
  });

  const refactorSymbolMigration = defineTool({
    name: "refactor_symbol_migration",
    description: "Run owner-type constrained symbol migrations (dry-run by default) using the same preview/apply engine. Sites are constrained by requiredOwnerType and, optionally, by symbolKinds (default: any kind). When a migration reports 0 matches, read rejectedSites — it names the guard that dropped each site.",
    input: schemas.refactorSymbolMigrationSchema,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId", "migrations"],
      properties: {
        repoId: { type: "string" },
        migrations: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["fromSymbol", "toSymbol", "requiredOwnerType"],
            properties: {
              fromSymbol: { type: "string" },
              toSymbol: { type: "string" },
              requiredOwnerType: { type: "string" },
              forbiddenOwnerTypes: { type: "array", items: { type: "string" }, maxItems: 200 },
              symbolKinds: {
                type: "array",
                items: { type: "string" },
                maxItems: 20,
                description: "Restrict sites to these inferred kinds (e.g. [\"property\",\"field\"]). Omit for any kind."
              },
              initializerRewrite: {
                type: "object",
                additionalProperties: false,
                properties: {
                  objectProperty: { type: "string" },
                  objectType: { type: "string" },
                  targetMember: { type: "string" }
                },
                required: ["objectProperty", "objectType"]
              }
            }
          }
        },
        scopePaths: { type: "array", items: { type: "string" }, maxItems: 200 },
        dryRun: { type: "boolean" },
        includeLowConfidence: { type: "boolean", description: "Allow apply for low-confidence hunks. Does NOT lift a risk flag such as ambiguous_target." }
      }
    },
    // Dry-run by default; a non-dry-run call goes through the apply path, which is itself
    // annotated destructive. The hint describes the default posture of this entry point.
    annotations: previewsChange,
    rawResult: true,
    handler: async (input) => ok(raw(await handleRefactorSymbolMigration(input, buildContext())))
  });

  const changeValueRepresentation = defineTool({
    name: "change_value_representation",
    description: "Promote a property's literal values to enum members (e.g. HandledBy = \"ai\" → ConversationHandledBy.Ai) across assignments, object initializers, ==/!= comparisons, and assertion arguments. Sites are located via the C# AST (no user-authored regex/backreference) and rewritten through the preview/apply/rollback engine — dry-run by default. Cross-type sites (a same-named property on a different owner type) are skipped; sites where the owner type can't be proven are flagged ambiguous_target.",
    input: schemas.changeValueRepresentationSchema,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId", "property", "requiredOwnerType", "valueMap"],
      properties: {
        repoId: { type: "string" },
        property: { type: "string", description: "Property identifier whose literals are promoted, e.g. \"HandledBy\"." },
        requiredOwnerType: { type: "string", description: "Owner type scoping the rewrite, e.g. \"Conversation\"." },
        valueMap: {
          type: "object",
          minProperties: 1,
          additionalProperties: { type: "string" },
          description: "Literal value (unquoted) → replacement expression, e.g. { \"ai\": \"ConversationHandledBy.Ai\" }."
        },
        includeComparisons: { type: "boolean", description: "Also rewrite ==/!= and assertion-argument sites (default true); false = assignments/initializers only." },
        scopePaths: { type: "array", items: { type: "string" }, maxItems: 200 },
        dryRun: { type: "boolean" },
        includeLowConfidence: { type: "boolean", description: "Allow apply for low-confidence hunks. Does NOT lift the ambiguous_target risk flag — see ambiguousReasons in the response." },
        profile: PROFILE_PROP
      }
    },
    annotations: previewsChange,
    rawResult: true,
    handler: async (input) => ok(raw(await handleChangeValueRepresentation(input, buildContext())))
  });

  const changeImpact = defineTool({
    name: "change_impact",
    description: "Composite 'what did my change affect and which tests cover it' for the working-tree diff (or a commit range): maps changed files → static dependents → covering tests, returning a ranked testsToRun list (by source risk × link score) plus a residualRisk note for changed files with no linked test. Use after editing to run a trusted targeted test subset instead of the whole suite. Defaults baseRef to the indexed commit (working-tree diff when no new commits).",
    input: schemas.changeImpactSchema(limits.maxResultLimit),
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
        testLinkMinScore: { type: "number", minimum: 0, maximum: 1 },
        testLinkMaxCandidates: { type: "integer", minimum: 1, maximum: 20 },
        maxTestsToRun: { type: "integer", minimum: 1, maximum: 500 },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleChangeImpact(input, buildContext())))
  });

  const getValueContractImpact = defineTool({
    name: "get_value_contract_impact",
    description: "Trace a stored/wire VALUE (e.g. a status string \"resolved\" or magic code) across ALL registered repos by fanning search_literals, grouping exact-value hits by repo and classifying each as producer (assigned/written) or consumer (compared/read) where inferable. This is the data-contract gate for a storage-format migration — what get_cross_repo_impact (symbol-oriented) can't answer. Rule-based, no LLM.",
    input: schemas.getValueContractImpactSchema,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: {
        value: { type: "string", description: "The exact stored/wire literal to trace, e.g. \"resolved\"." },
        column: { type: "string", description: "Optional DB column/field name to sharpen producer/consumer classification, e.g. \"status\"." },
        repoIds: { type: "array", items: { type: "string" }, maxItems: 50, description: "Optional subset of registered repoIds; defaults to all." },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleGetValueContractImpact(input, buildContext())))
  });

  const findFieldAccesses = defineTool({
    name: "find_field_accesses",
    description: "List every read/write callsite of a property (field) with its enclosing symbol — the 'who reads vs who writes this field' audit for wrong-level-resolution checks. Reads the PROPERTY_REF (read) / PROPERTY_WRITE (write) edges. Provide a property symbolId or a resolvable name. mode=read|write|all (default all). Returns reads/writes partitioned, each with enclosingName/filePath/line, plus a coverage block. Use this instead of grepping a field name across the repo.",
    input: schemas.findFieldAccessesSchema(limits.maxResultLimit),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId"],
      properties: {
        repoId: { type: "string" },
        symbolId: { type: "string" },
        name: { type: "string" },
        mode: { type: "string", enum: ["read", "write", "all"] },
        limit: { type: "integer", minimum: 1, maximum: limits.maxResultLimit },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleFindFieldAccesses(input, buildContext())))
  });

  const getSymbolBlame = defineTool({
    name: "get_symbol_blame",
    description: "Return git blame metadata for a symbol line by joining symbol location with `git blame -L line,line --porcelain`.",
    input: schemas.symbolBlameSchema,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoId"],
      properties: {
        repoId: { type: "string" },
        symbolId: { type: "string" },
        name: { type: "string" },
        redactEmail: { type: "boolean" },
        profile: PROFILE_PROP
      }
    },
    annotations: readsGraph,
    rawResult: true,
    handler: (input) => ok(raw(handleGetSymbolBlame(input, buildContext())))
  });

  return [
    findFieldAccesses,
    getSymbolBlame,
    changeImpact,
    renameAssist,
    refactorReplacePreview,
    refactorReplaceApply,
    refactorReplaceRollback,
    refactorSymbolMigration,
    changeValueRepresentation,
    getValueContractImpact
  ];
}
