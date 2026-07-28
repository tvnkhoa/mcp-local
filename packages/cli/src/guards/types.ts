/**
 * Guard result types.
 *
 * Guards ship in warn mode first: they report, CI stays green, and the reported
 * count is the number the migration drives to zero. `--strict` flips them to
 * blocking once that number is zero.
 */

/**
 * `error` blocks always. `warning` blocks under `--strict`. `info` never blocks — it exists so
 * a guard can report something it deliberately is not failing on, such as an accepted
 * exemption, without that report becoming a blocker the moment `--strict` flips (S-41).
 */
export type FindingSeverity = "error" | "warning" | "info";

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
  readonly infos: number;
} {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const finding of findings) {
    // Explicit per-severity branches, not `else`. An `else` here would silently fold any
    // future severity into `warnings`, and warnings block under --strict.
    if (finding.severity === "error") {
      errors += 1;
    } else if (finding.severity === "warning") {
      warnings += 1;
    } else {
      infos += 1;
    }
  }
  return { errors, warnings, infos };
}
