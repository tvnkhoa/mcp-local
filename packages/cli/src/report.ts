/**
 * Guard reporting.
 *
 * Output goes to stderr with a summary line on stdout, so a caller can pipe the
 * summary without the detail.
 */

import type { GuardFinding, GuardReport } from "./guards/types.js";
import { countBySeverity } from "./guards/types.js";

export interface RenderOptions {
  /** Treat warnings as failures too. */
  readonly strict?: boolean;
  readonly maxFindings?: number;
}

function renderFinding(finding: GuardFinding): string {
  const location = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
  const marker = finding.severity === "error" ? "ERROR" : finding.severity === "warning" ? "warn " : "info ";
  const hint = finding.hint === undefined ? "" : `\n        hint: ${finding.hint}`;
  return `  ${marker}  ${location}\n        [${finding.rule}] ${finding.message}${hint}`;
}

export function renderReport(report: GuardReport, options: RenderOptions = {}): string {
  const { errors, warnings, infos } = countBySeverity(report.findings);
  const max = options.maxFindings ?? 100;
  const lines: string[] = [];

  lines.push(`guard:${report.guard} — ${report.filesScanned} files scanned`);

  if (report.findings.length === 0) {
    lines.push("  no findings");
    return lines.join("\n");
  }

  const shown = report.findings.slice(0, max);
  for (const finding of shown) {
    lines.push(renderFinding(finding));
  }
  if (report.findings.length > shown.length) {
    lines.push(`  … and ${report.findings.length - shown.length} more`);
  }
  const infoNote = infos === 0 ? "" : `, ${infos} accepted exemption(s)`;
  lines.push(`  ${errors} error(s), ${warnings} warning(s)${infoNote}`);

  return lines.join("\n");
}

/** Exit code for a set of reports: 0 unless a blocking finding exists. */
export function exitCodeFor(reports: readonly GuardReport[], options: RenderOptions = {}): number {
  for (const report of reports) {
    const { errors, warnings } = countBySeverity(report.findings);
    if (errors > 0) {
      return 1;
    }
    if (options.strict === true && warnings > 0) {
      return 1;
    }
  }
  return 0;
}

export function renderSummary(reports: readonly GuardReport[]): string {
  const totals = reports.reduce(
    (accumulator, report) => {
      const { errors, warnings, infos } = countBySeverity(report.findings);
      return {
        errors: accumulator.errors + errors,
        warnings: accumulator.warnings + warnings,
        infos: accumulator.infos + infos,
        files: accumulator.files + report.filesScanned
      };
    },
    { errors: 0, warnings: 0, infos: 0, files: 0 }
  );
  const infoNote = totals.infos === 0 ? "" : `, ${totals.infos} accepted exemption(s)`;
  return `guards: ${totals.errors} error(s), ${totals.warnings} warning(s)${infoNote} across ${totals.files} file(s)`;
}
