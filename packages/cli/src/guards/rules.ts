/**
 * The dependency tier matrix, as data.
 *
 * Adding a package means adding a row here — which forces an explicit decision
 * about what it may import, at review time, rather than discovering the answer
 * later from an import that already shipped.
 */

export interface TierRule {
  /** Package name, e.g. "@mcp/core". */
  readonly name: string;
  /** Tier number; imports may only flow to a strictly lower tier. */
  readonly tier: number;
  /** Internal @mcp/* packages this one may import. */
  readonly mayImport: readonly string[];
  /** External packages this one may import. Empty means "no restriction". */
  readonly allowedExternal?: readonly string[];
  /** Import at all costs forbidden, regardless of tier. */
  readonly forbidden?: readonly string[];
}

export const TIER_RULES: readonly TierRule[] = [
  {
    name: "@mcp/core",
    tier: 0,
    mayImport: [],
    // Tier-0 is zero-dependency. Only Node builtins and type-only imports.
    allowedExternal: []
  },
  {
    name: "@mcp/sdk",
    tier: 1,
    mayImport: ["@mcp/core"],
    allowedExternal: ["@modelcontextprotocol/sdk", "zod"]
  },
  {
    name: "@mcp/shared",
    tier: 2,
    mayImport: ["@mcp/core"],
    allowedExternal: [],
    // A capability must never reach the protocol layer.
    forbidden: ["@modelcontextprotocol/sdk", "@mcp/sdk"]
  },
  {
    name: "@mcp/testing",
    tier: 3,
    mayImport: ["@mcp/core", "@mcp/sdk"],
    allowedExternal: ["zod"]
  },
  {
    name: "@mcp/cli",
    tier: 4,
    mayImport: ["@mcp/core"],
    allowedExternal: []
  }
];

/** Only this package may import the MCP protocol SDK (dependency rule 8). */
export const MCP_PROTOCOL_PACKAGE = "@modelcontextprotocol/sdk";
export const MCP_PROTOCOL_OWNER = "@mcp/sdk";

/**
 * Files permitted to read `process.env` (dependency rule 10). Matched as a
 * suffix against the workspace-relative path.
 */
export const ENV_ACCESS_ALLOWLIST: readonly string[] = [
  // The one permitted reader in the platform.
  "packages/core/src/env.ts",
  // The guard itself names the pattern it searches for.
  "packages/cli/src/guards/dependencyGuard.ts",
  "packages/cli/src/guards/rules.ts",
  // Each server's config module is the other permitted reader. Every server
  // keeps its config under src/config/ — the filename differs because
  // postgres-mcp resolves multiple environments.
  "/src/config/index.ts",
  "/src/config/environments.ts"
];

/** Node builtins are always allowed. */
export function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:");
}

export function ruleFor(packageName: string): TierRule | undefined {
  return TIER_RULES.find((rule) => rule.name === packageName);
}
