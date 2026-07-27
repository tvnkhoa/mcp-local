/**
 * Convention guard.
 *
 * Structural rules a reviewer would otherwise have to remember: required files,
 * required scripts, and file-size caps. The caps are the mechanism that stops a
 * new 2,000-line entry point from appearing again.
 */

import fs from "node:fs";
import path from "node:path";

import type { FindingSeverity, GuardFinding, GuardReport } from "./types.js";
import { listSourceFiles, readWorkspacePackages } from "../scan.js";

/** Soft cap: a warning. Hard cap: an error. */
export const FILE_LOC_SOFT_CAP = 400;
export const FILE_LOC_HARD_CAP = 600;

const REQUIRED_PACKAGE_FILES: readonly string[] = ["package.json", "tsconfig.json", "README.md", "src/index.ts"];
const REQUIRED_SCRIPTS: readonly string[] = ["build", "typecheck", "test"];

export interface ConventionGuardOptions {
  readonly workspaceRoot: string;
  readonly softCap?: number;
  readonly hardCap?: number;
  /** Extra directories to size-check (e.g. server src trees). */
  readonly extraDirs?: readonly string[];
}

export function runConventionGuard(options: ConventionGuardOptions): GuardReport {
  const findings: GuardFinding[] = [];
  const softCap = options.softCap ?? FILE_LOC_SOFT_CAP;
  const hardCap = options.hardCap ?? FILE_LOC_HARD_CAP;
  const packages = readWorkspacePackages(options.workspaceRoot);
  let filesScanned = 0;

  for (const pkg of packages) {
    for (const required of REQUIRED_PACKAGE_FILES) {
      if (!fs.existsSync(path.join(pkg.dir, required))) {
        findings.push({
          rule: "package/required-file",
          severity: "error",
          file: `${pkg.relativeDir}/${required}`,
          message: `Required file is missing from ${pkg.name}.`
        });
      }
    }

    const scripts = (pkg.manifest["scripts"] as Record<string, string> | undefined) ?? {};
    for (const script of REQUIRED_SCRIPTS) {
      if (scripts[script] === undefined) {
        findings.push({
          rule: "package/required-script",
          severity: "error",
          file: `${pkg.relativeDir}/package.json`,
          message: `${pkg.name} is missing the "${script}" script.`,
          hint: `Every package exposes the same script vocabulary: ${REQUIRED_SCRIPTS.join(", ")}.`
        });
      }
    }

    if (pkg.manifest["private"] !== true) {
      findings.push({
        rule: "package/must-be-private",
        severity: "error",
        file: `${pkg.relativeDir}/package.json`,
        message: `${pkg.name} must set "private": true - the platform is internal only.`
      });
    }

    if (pkg.manifest["exports"] === undefined) {
      findings.push({
        rule: "package/exports-map",
        severity: "warning",
        file: `${pkg.relativeDir}/package.json`,
        message: `${pkg.name} has no "exports" map, so deep imports cannot be prevented.`
      });
    }
  }

  const directories: { readonly path: string; readonly migrated: boolean }[] = [
    ...packages.map((pkg) => ({ path: `${pkg.dir}/src`, migrated: true })),
    ...(options.extraDirs ?? []).map((dir) => ({ path: `${options.workspaceRoot}/${dir}`, migrated: false }))
  ];

  for (const directory of directories) {
    // Findings in a not-yet-migrated server are DOWNGRADED to warnings. Their
    // oversized files and stray console.log calls are the pre-migration debt
    // this platform exists to remove — reporting them is the point, but failing
    // the build on them would block work that has not caused them. `--strict`
    // (migration-plan step S-41) is what makes the count blocking.
    const severityOf = (actual: FindingSeverity): FindingSeverity =>
      directory.migrated ? actual : "warning";

    for (const file of listSourceFiles(directory.path, options.workspaceRoot)) {
      filesScanned += 1;

      if (file.lineCount > hardCap) {
        findings.push({
          rule: "size/hard-cap",
          severity: severityOf("error"),
          file: file.relativePath,
          message: `${file.lineCount} lines exceeds the hard cap of ${hardCap}.`,
          hint: "Split along a cohesive boundary."
        });
        // Test files are exempt from the soft cap: length there reflects case
        // count, not production complexity. The hard cap above still applies.
      } else if (!file.isTest && file.lineCount > softCap) {
        findings.push({
          rule: "size/soft-cap",
          severity: "warning",
          file: file.relativePath,
          message: `${file.lineCount} lines exceeds the soft cap of ${softCap}.`
        });
      }

      if (!file.isTest && /^\s*export\s+default\b/m.test(file.content)) {
        findings.push({
          rule: "style/no-default-export",
          severity: "warning",
          file: file.relativePath,
          message: "Default export found; the platform uses named exports only.",
          hint: "Named exports are greppable and survive renames."
        });
      }

      if (!file.isTest && /\bconsole\s*\.\s*log\s*\(/.test(file.content)) {
        findings.push({
          rule: "logging/console-log",
          severity: severityOf("error"),
          file: file.relativePath,
          message: "console.log writes to stdout, which is the MCP transport.",
          hint: "Use the injected @mcp/core logger, which writes to stderr."
        });
      }
    }
  }

  return { guard: "convention", filesScanned, findings };
}
