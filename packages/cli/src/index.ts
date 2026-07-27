/**
 * @mcp/cli — workspace tooling.
 *
 * Tier 4: may consume lower tiers, and nothing may consume it. Provides the
 * architecture guards and the `mcp-platform` command.
 */

export type { ImportRef, SourceFile, WorkspacePackage } from "./scan.js";
export {
  extractImports,
  findWorkspaceRoot,
  isDeepImport,
  listSourceFiles,
  packageNameOf,
  readWorkspacePackages,
  stripComments
} from "./scan.js";

export type {
  ConventionGuardOptions,
  DependencyGuardOptions,
  FindingSeverity,
  GuardFinding,
  GuardReport,
  TierRule
} from "./guards/index.js";
export {
  ENV_ACCESS_ALLOWLIST,
  FILE_LOC_HARD_CAP,
  FILE_LOC_SOFT_CAP,
  MCP_PROTOCOL_OWNER,
  MCP_PROTOCOL_PACKAGE,
  TIER_RULES,
  countBySeverity,
  isNodeBuiltin,
  ruleFor,
  runConventionGuard,
  runDependencyGuard
} from "./guards/index.js";

export type { RenderOptions } from "./report.js";
export { exitCodeFor, renderReport, renderSummary } from "./report.js";
