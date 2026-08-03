/**
 * The rule-based refactor engine.
 *
 * Split in S-41; this barrel keeps `tools/handlers/` unchanged. No part invokes an LLM, and
 * `guard:no-llm-runtime` verifies that statically - every decision here is `rule_engine`.
 */

export { buildRefactorPreview } from "./refactorPreviewBuild.js";
export { applyCompilerAssistToPreview } from "./refactorCompilerAssist.js";
export { buildSymbolMigrationPreview } from "./refactorSymbolMigration.js";
export { executeRefactorApplyPlan } from "./refactorApplyPlan.js";
