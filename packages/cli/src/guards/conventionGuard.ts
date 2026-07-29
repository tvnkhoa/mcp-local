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

/**
 * Rules a file may exempt itself from, with a stated reason:
 *
 *     // @convention-exempt size/hard-cap: <why this file is allowed to be long>
 *
 * Only the size caps are exemptable, and that restriction is the point. A line count is a
 * proxy for complexity, and a proxy sometimes measures the wrong thing — a pure delegation
 * façade is long without being complex. The other rules are not proxies: `logging/console-log`
 * catches a write to the MCP transport itself, and no reason makes that acceptable. Attempting
 * to exempt a non-exemptable rule is an error, not a silent no-op.
 */
export const EXEMPTABLE_RULES: readonly string[] = ["size/hard-cap", "size/soft-cap"];

/**
 * Anchored to the start of a line, and accepting either a `//` comment or a `*` JSDoc
 * continuation. Both details are load-bearing:
 *
 * - Without the anchor, this guard's own hint strings — which quote the pragma syntax — parse
 *   as live exemptions of `conventionGuard.ts`. It did, on the first run.
 * - Without `*`, a pragma written inside the file-header JSDoc where it belongs is silently
 *   ignored, which is the one failure mode this whole feature exists to prevent.
 *
 * The colon stays optional so a reason-less pragma is still *parsed* — and then reported as an
 * error, rather than vanishing.
 */
const EXEMPTION_PATTERN = /^[ \t]*(?:\/\/|\*)[ \t]*@convention-exempt[ \t]+([\w/-]+)[ \t]*:?[ \t]*(.*)$/gm;

export interface Exemption {
  readonly rule: string;
  readonly reason: string;
  readonly line: number;
}

/** Parse `@convention-exempt` pragmas out of a source file. */
export function parseExemptions(content: string): Exemption[] {
  const found: Exemption[] = [];
  EXEMPTION_PATTERN.lastIndex = 0;
  let match = EXEMPTION_PATTERN.exec(content);
  while (match !== null) {
    const rule = match[1] ?? "";
    found.push({
      rule,
      reason: (match[2] ?? "").trim(),
      line: content.slice(0, match.index).split(/\r?\n/).length
    });
    match = EXEMPTION_PATTERN.exec(content);
  }
  return found;
}

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
        severity: "error",
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

      const exemptions = parseExemptions(file.content);
      const claimed = new Set<string>();

      for (const exemption of exemptions) {
        if (!EXEMPTABLE_RULES.includes(exemption.rule)) {
          findings.push({
            rule: "exemption/not-exemptable",
            severity: "error",
            file: file.relativePath,
            line: exemption.line,
            message: `"${exemption.rule}" cannot be exempted.`,
            hint: `Exemptable rules: ${EXEMPTABLE_RULES.join(", ")}. The others catch defects, not proxies for them.`
          });
          continue;
        }
        if (exemption.reason === "") {
          findings.push({
            rule: "exemption/no-reason",
            severity: "error",
            file: file.relativePath,
            line: exemption.line,
            message: `Exemption from "${exemption.rule}" states no reason, so it does not apply.`,
            hint: "Write: // @convention-exempt size/hard-cap: <why this file is the exception>"
          });
          continue;
        }
        claimed.add(exemption.rule);
      }

      /** Suppress an exempted finding, reporting the exemption in its place. */
      const record = (finding: GuardFinding): void => {
        const exemption = exemptions.find((e) => e.rule === finding.rule && claimed.has(e.rule));
        if (exemption === undefined) {
          findings.push(finding);
          return;
        }
        findings.push({
          rule: `exemption/${finding.rule}`,
          severity: "info",
          file: finding.file,
          line: exemption.line,
          message: `Exempted: ${finding.message} — ${exemption.reason}`
        });
      };

      if (file.lineCount > hardCap) {
        record({
          rule: "size/hard-cap",
          severity: severityOf("error"),
          file: file.relativePath,
          message: `${file.lineCount} lines exceeds the hard cap of ${hardCap}.`,
          hint: "Split along a cohesive boundary."
        });
        // Test files are exempt from the soft cap: length there reflects case
        // count, not production complexity. The hard cap above still applies.
      } else if (!file.isTest && file.lineCount > softCap) {
        record({
          rule: "size/soft-cap",
          severity: "warning",
          file: file.relativePath,
          message: `${file.lineCount} lines exceeds the soft cap of ${softCap}.`
        });
      }

      // An exemption that suppresses nothing has outlived its reason. Report it, so the pragma
      // gets deleted when the file is finally split, instead of sitting there implying a
      // constraint that no longer binds.
      for (const rule of claimed) {
        const applied = findings.some(
          (f) => f.file === file.relativePath && f.rule === `exemption/${rule}` && f.severity === "info"
        );
        if (!applied) {
          findings.push({
            rule: "exemption/stale",
            severity: "error",
            file: file.relativePath,
            message: `Exemption from "${rule}" is unused — the file no longer violates it.`,
            hint: "Delete the pragma."
          });
        }
      }

      if (!file.isTest && /^\s*export\s+default\b/m.test(file.content)) {
        findings.push({
          rule: "style/no-default-export",
          severity: "error",
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
