/**
 * Dependency-rule guard.
 *
 * Enforces the tier matrix statically. Without this the rules are comments —
 * which is precisely how three hand-copied SQL guardrail implementations were
 * able to drift apart unnoticed.
 */

import type { GuardFinding, GuardReport } from "./types.js";
import {
  ENV_ACCESS_ALLOWLIST,
  MCP_PROTOCOL_OWNER,
  MCP_PROTOCOL_PACKAGE,
  isNodeBuiltin,
  ruleFor
} from "./rules.js";
import {
  extractImports,
  isDeepImport,
  listSourceFiles,
  packageNameOf,
  readWorkspacePackages,
  stripComments
} from "../scan.js";

export interface DependencyGuardOptions {
  readonly workspaceRoot: string;
  /** Also scan server directories for cross-server imports. Default false. */
  readonly serverDirs?: readonly string[];
}

export function runDependencyGuard(options: DependencyGuardOptions): GuardReport {
  const findings: GuardFinding[] = [];
  const packages = readWorkspacePackages(options.workspaceRoot);
  const knownPackageNames = new Set(packages.map((pkg) => pkg.name));
  let filesScanned = 0;

  for (const pkg of packages) {
    const rule = ruleFor(pkg.name);
    const files = listSourceFiles(`${pkg.dir}/src`, options.workspaceRoot);
    filesScanned += files.length;

    if (rule === undefined) {
      findings.push({
        rule: "tier/unknown-package",
        severity: "error",
        file: `${pkg.relativeDir}/package.json`,
        message: `Package "${pkg.name}" has no entry in the tier matrix.`,
        hint: "Add a TierRule to packages/cli/src/guards/rules.ts declaring what it may import."
      });
      continue;
    }

    for (const file of files) {
      // Rule 10 - process.env is read in one place only. Comments are stripped
      // first so documenting the rule does not violate it.
      if (/\bprocess\s*\.\s*env\b/.test(stripComments(file.content))) {
        const permitted = ENV_ACCESS_ALLOWLIST.some((allowed) =>
          allowed.startsWith("/") ? file.relativePath.endsWith(allowed) : file.relativePath === allowed
        );
        if (!permitted) {
          findings.push({
            rule: "env/direct-access",
            severity: "error",
            file: file.relativePath,
            message: "Reads process.env directly.",
            hint: "Use @mcp/core createEnvReader(defaultEnvSource()) and pass the snapshot down."
          });
        }
      }

      for (const ref of extractImports(file.content)) {
        const specifier = ref.specifier;

        if (isNodeBuiltin(specifier) || specifier.startsWith(".") || specifier.startsWith("/")) {
          continue;
        }

        // Rule 6 - no deep imports past a package entry point.
        if (isDeepImport(specifier)) {
          findings.push({
            rule: "imports/deep-import",
            severity: "error",
            file: file.relativePath,
            line: ref.line,
            message: `Deep import "${specifier}".`,
            hint: "Import the package entry point and re-export from its index if the symbol is missing."
          });
          continue;
        }

        const imported = packageNameOf(specifier);
        if (imported === undefined || imported === pkg.name) {
          continue;
        }

        // Rule 8 - the protocol SDK has exactly one importer.
        if (imported === MCP_PROTOCOL_PACKAGE && pkg.name !== MCP_PROTOCOL_OWNER) {
          findings.push({
            rule: "imports/protocol-sdk",
            severity: "error",
            file: file.relativePath,
            line: ref.line,
            message: `Only ${MCP_PROTOCOL_OWNER} may import ${MCP_PROTOCOL_PACKAGE}.`,
            hint: "Depend on @mcp/sdk instead of the protocol package."
          });
          continue;
        }

        if (rule.forbidden?.includes(imported) === true) {
          findings.push({
            rule: "tier/forbidden-import",
            severity: "error",
            file: file.relativePath,
            line: ref.line,
            message: `${pkg.name} must never import ${imported}.`
          });
          continue;
        }

        if (knownPackageNames.has(imported)) {
          // Internal import - must be allowed by the tier matrix.
          if (!rule.mayImport.includes(imported)) {
            const importedRule = ruleFor(imported);
            const direction =
              importedRule !== undefined && importedRule.tier >= rule.tier
                ? " (imports may only flow to a lower tier)"
                : "";
            findings.push({
              rule: "tier/violation",
              severity: "error",
              file: file.relativePath,
              line: ref.line,
              message: `${pkg.name} (tier ${rule.tier}) may not import ${imported}${direction}.`,
              hint: `Allowed: ${rule.mayImport.length === 0 ? "none" : rule.mayImport.join(", ")}.`
            });
            continue;
          }
        } else if (rule.allowedExternal !== undefined && rule.allowedExternal.length === 0) {
          // Rule 7 - a declared zero-dependency package acquired one.
          findings.push({
            rule: "tier/zero-dependency",
            severity: "error",
            file: file.relativePath,
            line: ref.line,
            message: `${pkg.name} is declared dependency-free but imports "${imported}".`,
            hint: "Adding a runtime dependency here requires an ADR."
          });
          continue;
        } else if (
          rule.allowedExternal !== undefined &&
          rule.allowedExternal.length > 0 &&
          !rule.allowedExternal.includes(imported)
        ) {
          findings.push({
            rule: "tier/undeclared-external",
            severity: "warning",
            file: file.relativePath,
            line: ref.line,
            message: `${pkg.name} imports "${imported}", which is not in its allowedExternal list.`,
            hint: "Add it to the TierRule if intended."
          });
          continue;
        }

        // Every import must be declared in package.json.
        if (!pkg.dependencies.has(imported)) {
          findings.push({
            rule: "imports/undeclared-dependency",
            severity: "error",
            file: file.relativePath,
            line: ref.line,
            message: `"${imported}" is imported but not declared in ${pkg.relativeDir}/package.json.`
          });
        }
      }
    }
  }

  // Server-scoped rules. These run over serverDirs, which readWorkspacePackages
  // does not enumerate — without this loop the env rule below would never fire
  // on a server, and the "/src/config.ts" allowlist entries would be dead.
  for (const serverDir of options.serverDirs ?? []) {
    const files = listSourceFiles(`${options.workspaceRoot}/${serverDir}/src`, options.workspaceRoot);
    filesScanned += files.length;
    const others = (options.serverDirs ?? []).filter((dir) => dir !== serverDir);

    for (const file of files) {
      // Rule 10 - a server reads process.env only in its config module.
      //
      // Reported as a WARNING, not an error: no server has been migrated to the
      // platform yet, so scattered env reads are the expected pre-migration
      // state. This count is the number the migration drives to zero, and
      // `--strict` (migration-plan step S-41) is what makes it blocking.
      if (/\bprocess\s*\.\s*env\b/.test(stripComments(file.content))) {
        const permitted = ENV_ACCESS_ALLOWLIST.some((allowed) =>
          allowed.startsWith("/") ? file.relativePath.endsWith(allowed) : file.relativePath === allowed
        );
        if (!permitted) {
          findings.push({
            rule: "env/direct-access",
            severity: "warning",
            file: file.relativePath,
            message: "Reads process.env outside the server's config module.",
            hint: "Load config once in src/config.ts and pass the typed result down."
          });
        }
      }

      for (const ref of extractImports(file.content)) {
        const crossed = others.find(
          (other) => ref.specifier.includes(`/${other}/`) || ref.specifier.startsWith(`${other}/`)
        );
        if (crossed !== undefined) {
          findings.push({
            rule: "servers/cross-import",
            severity: "error",
            file: file.relativePath,
            line: ref.line,
            message: `Server "${serverDir}" imports from server "${crossed}".`,
            hint: "Promote the shared need into packages/shared."
          });
        }
      }
    }
  }

  return { guard: "deps", filesScanned, findings };
}
