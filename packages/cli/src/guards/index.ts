export type { FindingSeverity, GuardFinding, GuardReport } from "./types.js";
export { countBySeverity } from "./types.js";

export type { TierRule } from "./rules.js";
export {
  ENV_ACCESS_ALLOWLIST,
  MCP_PROTOCOL_OWNER,
  MCP_PROTOCOL_PACKAGE,
  TIER_RULES,
  isNodeBuiltin,
  ruleFor
} from "./rules.js";

export type { DependencyGuardOptions } from "./dependencyGuard.js";
export { runDependencyGuard } from "./dependencyGuard.js";

export type { ConventionGuardOptions } from "./conventionGuard.js";
export { EXEMPTABLE_RULES, FILE_LOC_HARD_CAP, FILE_LOC_SOFT_CAP, parseExemptions, runConventionGuard } from "./conventionGuard.js";
