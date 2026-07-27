/**
 * Guard result types.
 *
 * Guards ship in warn mode first: they report, CI stays green, and the reported
 * count is the number the migration drives to zero. `--strict` flips them to
 * blocking once that number is zero.
 */

export type FindingSeverity = "error" | "warning";

export interface GuardFinding {
  readonly rule: string;
  readonly severity: FindingSeverity;
  /** Workspace-relative path, POSIX separators. */
  readonly file: string;
  readonly line?: number;
  readonly message: string;
  readonly hint?: string;
}

export interface GuardReport {
  readonly guard: string;
  readonly filesScanned: number;
  readonly findings: readonly GuardFinding[];
}

export function countBySeverity(findings: readonly GuardFinding[]): {
  readonly errors: number;
  readonly warnings: number;
} {
  let errors = 0;
  let warnings = 0;
  for (const finding of findings) {
    if (finding.severity === "error") {
      errors += 1;
    } else {
      warnings += 1;
    }
  }
  return { errors, warnings };
}
