/**
 * The DDL planner: given the files, the ledger and a request, what would run, in what order, and
 * with which risks. It has no I/O, so every rule about ordering, drift and rollback is decided
 * here and tested without a database.
 *
 * Two inputs, one output:
 *  - file mode: `direction: "up"` applies pending migrations, everything or through `target`.
 *    `direction: "down"` reverts applied migrations newer than `target`, newest first, using their
 *    `.down.sql` files.
 *  - inline mode: one script passed as `sql`, applied as an unversioned migration. If a file with
 *    the same checksum is written later, the next up plan ADOPTS it (records it as applied without
 *    running it again) instead of running the same DDL twice.
 */

import { createHash } from "node:crypto";

import { validateDdlScript, type DdlExecutionMode, type DdlStatement } from "../../middleware/ddlGuardrails.js";
import { lintDdl, type LintContext, type RiskFinding } from "../../middleware/ddlRiskLint.js";
import { effectiveTimeouts, type DdlConfig, type EffectiveTimeouts } from "./ddlConfig.js";
import { checksumOf, type LoadedMigrations, type MigrationFile } from "./ddlFiles.js";
import type { HistoryState } from "./ddlHistory.js";

// ── status ───────────────────────────────────────────────────────────────────

export interface DdlStatusReport {
  applied: Array<{ version: string; name: string; kind: "file" | "adopted"; onDisk: boolean; checksumMatches: boolean | null }>;
  pending: Array<{ version: string; name: string; hasDown: boolean; outOfOrder: boolean }>;
  /** Applied, but the up file on disk has changed since. Blocks every file-mode plan. */
  checksumMismatch: Array<{ version: string; name: string }>;
  /** Applied, but no longer on disk. Up plans warn; a down plan cannot revert past it. */
  missingFiles: Array<{ version: string; name: string }>;
  /** Pending versions older than the newest applied one. */
  outOfOrder: string[];
  inlineApplied: Array<{ historyId: number; name: string }>;
}

export function computeStatus(files: readonly MigrationFile[], state: HistoryState): DdlStatusReport {
  const onDisk = new Map(files.map((f) => [f.version, f]));
  const appliedVersions = new Set(state.applied.map((a) => a.version));
  const newestApplied = state.applied.at(-1)?.version;

  const applied = state.applied.map((a) => {
    const file = onDisk.get(a.version);
    return {
      version: a.version,
      name: a.name,
      kind: a.kind,
      onDisk: file !== undefined,
      checksumMatches: file === undefined ? null : file.up.checksum === a.checksum
    };
  });
  const pending = files
    .filter((f) => !appliedVersions.has(f.version))
    .map((f) => ({
      version: f.version,
      name: f.name,
      hasDown: f.down !== undefined,
      outOfOrder: newestApplied !== undefined && f.version < newestApplied
    }));

  return {
    applied,
    pending,
    checksumMismatch: applied.filter((a) => a.checksumMatches === false).map(({ version, name }) => ({ version, name })),
    missingFiles: applied.filter((a) => !a.onDisk).map(({ version, name }) => ({ version, name })),
    outOfOrder: pending.filter((p) => p.outOfOrder).map((p) => p.version),
    inlineApplied: state.unadoptedInline.map(({ historyId, name }) => ({ historyId, name }))
  };
}

// ── plans ────────────────────────────────────────────────────────────────────

export type PlanRequest =
  | { mode: "file"; direction: "up" | "down"; target?: string; allowOutOfOrder?: boolean }
  | { mode: "inline"; sql: string; label?: string; noTransaction?: boolean };

export interface PlanStep {
  version: string | null;
  name: string;
  /** `apply` runs the script; `adopt` only records a file an inline apply already ran; `revert` runs the down script. */
  action: "apply" | "adopt" | "revert";
  /** File name, or null for an inline script. */
  file: string | null;
  mode: DdlExecutionMode;
  /** Checksum of the script this step runs: the up script, or for `revert` the down script. */
  checksum: string;
  /** For `revert`: the up checksum recorded when the version was applied. */
  upChecksum: string | null;
  sql: string;
  statements: DdlStatement[];
  timeouts: EffectiveTimeouts;
  risks: RiskFinding[];
  warnings: string[];
}

export interface DdlPlan {
  direction: "up" | "down";
  kind: "file" | "inline";
  steps: PlanStep[];
  warnings: string[];
  /** Distinct `high` codes across every step. `ddl_apply` must be given all of them. */
  requiredAcknowledgements: string[];
}

export type PlanResult = { ok: true; plan: DdlPlan } | { ok: false; error: { code: string; message: string } };

export interface PlanInput {
  /** The loaded directory. Required for file mode; unused for inline. */
  files?: LoadedMigrations;
  state: HistoryState;
  request: PlanRequest;
  config: DdlConfig;
  lint?: LintContext;
}

function fail(code: string, message: string): PlanResult {
  return { ok: false, error: { code, message } };
}

/** Validate, time and lint one script into a step. `createdInPlan` carries across steps. */
function buildStep(
  base: Pick<PlanStep, "version" | "name" | "action" | "file" | "upChecksum">,
  sql: string,
  options: { noTransaction?: boolean },
  input: PlanInput,
  createdInPlan: Set<string>
): { ok: true; step: PlanStep } | { ok: false; error: { code: string; message: string } } {
  const label = base.file ?? `inline '${base.name}'`;
  const validated = validateDdlScript(sql, options);
  if (!validated.ok) {
    return { ok: false, error: { code: validated.error.code, message: `${label}: ${validated.error.message}` } };
  }
  const timed = effectiveTimeouts(input.config, validated.directives);
  if (!timed.ok) {
    return { ok: false, error: { code: timed.error.code, message: `${label}: ${timed.error.message}` } };
  }
  // An adoption runs nothing, so it carries no risk. Linting it would demand acknowledgement for
  // DDL that already ran.
  const lint =
    base.action === "adopt"
      ? { findings: [], blocked: [] }
      : lintDdl(validated.statements, { ...input.lint, createdInPlan });
  if (lint.blocked.length > 0) {
    const first = lint.blocked[0] as RiskFinding;
    return {
      ok: false,
      error: { code: "DDL_RISK_BLOCKED", message: `${label}, statement ${String(first.statementIndex + 1)}: ${first.message}` }
    };
  }
  return {
    ok: true,
    step: {
      ...base,
      mode: validated.mode,
      checksum: checksumOf(sql),
      sql,
      statements: validated.statements,
      timeouts: timed.timeouts,
      risks: lint.findings,
      warnings: validated.warnings.map((w) => `${label}: ${w}`)
    }
  };
}

function finish(direction: "up" | "down", kind: "file" | "inline", steps: PlanStep[], warnings: string[]): PlanResult {
  const requiredAcknowledgements = [
    ...new Set(steps.flatMap((s) => s.risks.filter((r) => r.level === "high").map((r) => r.code)))
  ];
  return {
    ok: true,
    plan: { direction, kind, steps, warnings: [...warnings, ...steps.flatMap((s) => s.warnings)], requiredAcknowledgements }
  };
}

export function buildPlan(input: PlanInput): PlanResult {
  const { request, state } = input;
  const createdInPlan = new Set<string>();

  if (request.mode === "inline") {
    const checksum = checksumOf(request.sql);
    const warnings: string[] = [];
    if (state.unadoptedInline.some((i) => i.checksum === checksum) || state.applied.some((a) => a.checksum === checksum)) {
      warnings.push("An identical script has already been applied to this environment.");
    }
    const built = buildStep(
      { version: null, name: request.label ?? "inline", action: "apply", file: null, upChecksum: null },
      request.sql,
      { noTransaction: request.noTransaction === true },
      input,
      createdInPlan
    );
    return built.ok ? finish("up", "inline", [built.step], warnings) : built;
  }

  const loaded = input.files;
  if (loaded === undefined) {
    return fail("DDL_MIGRATIONS_DIR_UNCONFIGURED", "File-mode plans need the migrations directory.");
  }
  const status = computeStatus(loaded.migrations, state);
  const warnings = [...loaded.warnings, ...loaded.ignoredFiles.map((f) => `${f} does not follow V<14 digits>__<name>.(up|down).sql and is ignored.`)];

  // An edited applied file means the directory no longer describes the database. Every file-mode
  // plan stops until the file is restored, because both directions read from it.
  if (status.checksumMismatch.length > 0) {
    return fail(
      "DDL_CHECKSUM_MISMATCH",
      `Applied migration(s) changed on disk since they ran: ${status.checksumMismatch.map((m) => m.version).join(", ")}. Restore the original files; write a new migration for the change.`
    );
  }

  const byVersion = new Map(loaded.migrations.map((m) => [m.version, m]));

  if (request.direction === "up") {
    if (request.target !== undefined && !byVersion.has(request.target)) {
      return fail("DDL_UNKNOWN_TARGET", `No migration file has version ${request.target}.`);
    }
    for (const missing of status.missingFiles) {
      warnings.push(`Applied migration ${missing.version} (${missing.name}) is no longer on disk.`);
    }
    const selected = status.pending.filter((p) => request.target === undefined || p.version <= request.target);
    const outOfOrder = selected.filter((p) => p.outOfOrder).map((p) => p.version);
    if (outOfOrder.length > 0 && request.allowOutOfOrder !== true) {
      return fail(
        "DDL_OUT_OF_ORDER",
        `Pending migration(s) ${outOfOrder.join(", ")} are older than the newest applied one (${state.applied.at(-1)?.version ?? "?"}). Pass allowOutOfOrder: true if that is intended.`
      );
    }

    const inline = [...state.unadoptedInline];
    const steps: PlanStep[] = [];
    for (const pending of selected) {
      const file = byVersion.get(pending.version) as MigrationFile;
      const adoptAt = inline.findIndex((i) => i.checksum === file.up.checksum);
      const action = adoptAt >= 0 ? "adopt" : "apply";
      if (adoptAt >= 0) {
        inline.splice(adoptAt, 1);
      }
      const built = buildStep(
        { version: file.version, name: file.name, action, file: file.up.file, upChecksum: null },
        file.up.text,
        {},
        input,
        createdInPlan
      );
      if (!built.ok) {
        return built;
      }
      steps.push(built.step);
    }
    return finish("up", "file", steps, warnings);
  }

  // ── down ──
  const target = request.target;
  if (target === undefined) {
    return fail("DDL_INVALID_ARGS", "A down plan needs target: the version to revert back to, or \"0\" to revert everything.");
  }
  if (target !== "0" && !state.applied.some((a) => a.version === target)) {
    // A bound that matches nothing is almost always a typo, and a typo here would revert
    // everything newer than it.
    return fail("DDL_UNKNOWN_TARGET", `Version ${target} is not applied. Pass an applied version, or "0" to revert everything.`);
  }

  const toRevert = state.applied.filter((a) => target === "0" || a.version > target).reverse();
  const steps: PlanStep[] = [];
  for (const applied of toRevert) {
    const file = byVersion.get(applied.version);
    if (file?.down === undefined) {
      return fail(
        "DDL_NO_DOWN_SCRIPT",
        `Migration ${applied.version} (${applied.name}) has no ${file === undefined ? "file on disk" : ".down.sql"}, so it cannot be reverted. Revert to a later target, or write the down script.`
      );
    }
    const built = buildStep(
      { version: applied.version, name: applied.name, action: "revert", file: file.down.file, upChecksum: applied.checksum },
      file.down.text,
      {},
      input,
      createdInPlan
    );
    if (!built.ok) {
      return built;
    }
    steps.push(built.step);
  }
  return finish("down", "file", steps, warnings);
}

/**
 * What a preview's approval token binds: the environment, both freshness ids, and every step's
 * identity and timeouts. Anything that would make apply run something other than what was
 * previewed changes this.
 */
export function planDigest(args: { environment: string; preSnapshotId: string; historyStateId: string; plan: DdlPlan }): string {
  const steps = args.plan.steps.map((s) =>
    [s.version ?? "inline", s.action, s.mode, s.checksum, String(s.timeouts.lockTimeoutMs), String(s.timeouts.statementTimeoutMs)].join(":")
  );
  return createHash("sha256")
    .update([args.environment, args.preSnapshotId, args.historyStateId, args.plan.direction, args.plan.kind, ...steps].join("::"))
    .digest("hex");
}
