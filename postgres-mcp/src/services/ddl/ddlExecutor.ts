/**
 * Runs DDL plans: the dry run, and the apply.
 *
 * Both run on a DEDICATED `pg.Client`, never on the pool, for three reasons:
 *  - The pool sets a 30 s `statement_timeout` on every connection. DDL needs its own timeouts, set
 *    per migration.
 *  - A session advisory lock only means something while the session that holds it stays open.
 *  - The non-transactional path sets session-level timeouts, and those must not leak back into a
 *    pooled connection.
 *
 * Execution rules:
 *  - **One transaction per migration.** A migration's statements commit together with its ledger
 *    row, or not at all. The plan stops at the first failure. Earlier migrations stay committed,
 *    which is Flyway's default.
 *  - **Non-transactional migrations are exactly one statement** (the guardrail guarantees it), so
 *    a failure never leaves a migration half applied. A failed `CREATE INDEX CONCURRENTLY` can
 *    still leave an INVALID index behind. That index is detected and reported, not hidden.
 *  - **Every statement runs over the extended protocol** (`queryMode: "extended"`). Postgres
 *    refuses more than one command in a Parse message. So even if the guardrail's tokenizer and
 *    the server ever disagreed about a statement boundary, the server would refuse rather than run
 *    a statement nobody classified.
 *  - **No write may reach `mcp_ops`** except the ledger insert. The tuple counters are read before
 *    a migration's statements and again after them, before its ledger row is written. A default
 *    expression, an index expression or a trigger cannot write there unnoticed.
 *  - **The ledger is whichever one is configured** (`ddlLedger.ts`): `mcp_ops.ddl_history`, or a
 *    repo's own table. Its row is written in the migration's transaction either way.
 *  - **POSTGRES_DDL_SESSION_SETTINGS are set before each migration's statements**, transaction-
 *    local, through `set_config` with bound values. They are never text in the migration.
 */

import os from "node:os";

import pg, { type PoolConfig, type QueryConfig } from "pg";

import { INTERNAL_SCHEMAS } from "../../middleware/internalSchemas.js";
import { PolicyViolationError } from "../../middleware/errors.js";
import { assertNoInternalWrites, internalState } from "../internalWriteGuard.js";
import { captureSchema, type SchemaSnapshot } from "../migration/schemaSnapshot.js";
import type { OwnerRoleAttributes } from "../../middleware/ddlRiskLint.js";
import { quoteQualified, requireMigrationsDir, type DdlConfig } from "./ddlConfig.js";
import { loadMigrations } from "./ddlFiles.js";
import { assertSessionPinned, tryTakeMigrationLock } from "../concurrency/migrationLock.js";
import { DDL_LOCK_KEY, type HistoryState, type Queryable } from "./ddlHistory.js";
import { ledgerFor, type DdlLedger } from "./ddlLedger.js";
import { buildPlan, planDigest, type DdlPlan, type PlanRequest, type PlanStep } from "./ddlPlanner.js";
import type { DryRunResult, DryRunStepResult, StepError } from "./ddlPreviewStore.js";

const HOST = os.hostname();
const INTERNAL_WRITE_MESSAGE = `This migration wrote to ${INTERNAL_SCHEMAS.join(", ")}, which is owned by this server — through a default, an index expression, a trigger or a function it ran. It was rolled back.`;

// ── planning against a live database ─────────────────────────────────────────

export interface LivePlan {
  plan: DdlPlan;
  snapshot: SchemaSnapshot;
  state: HistoryState;
  efHistoryTablePresent: boolean;
}

/**
 * Load the files, read the ledger and the schema, and plan `request`. Used by `ddl_preview`
 * (on the pool) and again by dry run and apply (on the locked session), so the plan they execute
 * is built the same way as the one that was approved.
 */
export async function planAgainst(db: Queryable, request: PlanRequest, config: DdlConfig, environment?: string): Promise<LivePlan> {
  try {
    return await planAgainstUnguarded(db, request, config, environment);
  } catch (error) {
    if (stringProp(error, "code") === "55P03") {
      throw new PolicyViolationError(
        "DDL_LOCK_TIMEOUT",
        "Could not read the schema within lock_timeout: another session holds an exclusive lock on a table the snapshot reads. Retry once it finishes."
      );
    }
    throw error;
  }
}

/** `pg_roles` attributes for the allowlisted owner roles. A role absent from the map does not exist. */
async function ownerRoleAttributes(db: Queryable, roles: readonly string[]): Promise<Map<string, OwnerRoleAttributes>> {
  if (roles.length === 0) {
    return new Map();
  }
  const result = await db.query<{ rolname: string; rolsuper: boolean; rolcreaterole: boolean; rolbypassrls: boolean; rolreplication: boolean }>(
    "select rolname, rolsuper, rolcreaterole, rolbypassrls, rolreplication from pg_roles where rolname = any($1::text[])",
    [roles]
  );
  return new Map(
    result.rows.map((r) => [r.rolname, { superuser: r.rolsuper, createRole: r.rolcreaterole, bypassRls: r.rolbypassrls, replication: r.rolreplication }])
  );
}

/**
 * Which of `roles` the acting role (`acting`, else the login) may SET ROLE to: the SET option on
 * PG16+, membership before it. Only roles that exist are asked about, since pg_has_role errors on
 * an unknown name.
 */
async function settableRoles(db: Queryable, acting: string | undefined, roles: readonly string[]): Promise<Set<string>> {
  if (roles.length === 0) {
    return new Set();
  }
  const result = await db.query<{ rolname: string }>(
    `select rolname from pg_roles
     where rolname = any($1::text[])
       and pg_has_role(coalesce($2::name, session_user), oid,
                       case when current_setting('server_version_num')::int >= 160000 then 'SET' else 'MEMBER' end)`,
    [roles, acting ?? null]
  );
  return new Set(result.rows.map((r) => r.rolname));
}

/**
 * POSTGRES_DDL_SESSION_ROLE, checked against the target database before anything is planned: it
 * exists, has none of the attributes refused for an owner role, and the login may SET ROLE to it.
 * The config already required it to be in POSTGRES_DDL_OWNER_ROLES, so `ownerRoles` holds it.
 */
async function assertSessionRole(db: Queryable, role: string, ownerRoles: ReadonlyMap<string, OwnerRoleAttributes>): Promise<void> {
  const attributes = ownerRoles.get(role);
  if (attributes === undefined) {
    throw new PolicyViolationError("DDL_SESSION_ROLE_UNKNOWN", `POSTGRES_DDL_SESSION_ROLE ${role}: no such role exists in this database.`);
  }
  const reaching = [
    attributes.superuser ? "SUPERUSER" : undefined,
    attributes.createRole ? "CREATEROLE" : undefined,
    attributes.bypassRls ? "BYPASSRLS" : undefined,
    attributes.replication ? "REPLICATION" : undefined
  ].filter((a): a is string => a !== undefined);
  if (reaching.length > 0) {
    throw new PolicyViolationError(
      "DDL_SESSION_ROLE_PRIVILEGED",
      `POSTGRES_DDL_SESSION_ROLE ${role} is refused: it has ${reaching.join(", ")}, and every statement of every migration would run with it.`
    );
  }
  if (!(await settableRoles(db, undefined, [role])).has(role)) {
    throw new PolicyViolationError(
      "DDL_SESSION_ROLE_NOT_MEMBER",
      `POSTGRES_DDL_SESSION_ROLE ${role}: the login cannot SET ROLE ${role}. Grant ${role} to the login (outside the lane), or unset the variable.`
    );
  }
}

/** Why an environment without the external ledger is refused, naming it when known. */
export function missingLedgerMessage(label: string, environment?: string): string {
  const where = environment === undefined ? "This environment" : `Environment '${environment}'`;
  return `${where} has no ${label}. POSTGRES_DDL_EXTERNAL_LEDGER, with the migrations directory and session role, describes one repo's database: if this is not it, pass that database's environment. If it is, create the ledger with the repo's own runner first; the lane never creates it.`;
}

async function planAgainstUnguarded(db: Queryable, request: PlanRequest, config: DdlConfig, environment?: string): Promise<LivePlan> {
  const ledger = ledgerFor(config);
  // The ledger first. With an external ledger, the lane's whole configuration (the ledger, the
  // migrations directory, the session role) describes ONE repo's database, while every environment
  // of the server can be named. An environment without that ledger is almost always the wrong one,
  // and saying so beats a session-role or schema error that hides it. The lane never creates the
  // table, so nothing could be applied there anyway.
  const read = await ledger.read(db);
  if (ledger.external && !read.present) {
    throw new PolicyViolationError("DDL_LEDGER_MISSING", missingLedgerMessage(ledger.label, environment));
  }
  const ownerRoles = await ownerRoleAttributes(db, config.ownerRoles ?? []);
  if (config.sessionRole !== undefined) {
    await assertSessionRole(db, config.sessionRole, ownerRoles);
  }
  const actingRole = {
    name: config.sessionRole ?? (await db.query<{ u: string }>("select session_user as u")).rows[0]?.u ?? "the login",
    canBecome: await settableRoles(db, config.sessionRole, [...ownerRoles.keys()])
  };
  const loaded = request.mode === "file" ? await loadMigrations(requireMigrationsDir(config), ledger.format) : undefined;
  const snapshot = await captureSchema(db);
  const state = read.state;
  const sentinel = config.adoptionSentinel;
  const adoption =
    sentinel === undefined
      ? undefined
      : {
          sentinel: `${sentinel.schema}.${sentinel.name}`,
          sentinelPresent: (await db.query<{ p: boolean }>("select to_regclass($1) is not null as p", [quoteQualified(sentinel)])).rows[0]?.p === true,
          ledgerRowCount: read.rowCount
        };
  const extra = await db.query<{ ef: boolean }>(`select to_regclass('public."__EFMigrationsHistory"') is not null as ef`);
  const estimates = await db.query<{ name: string; rows: number }>(
    `select n.nspname || '.' || c.relname as name, c.reltuples::float8 as rows
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p') and n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'`
  );
  const rowEstimates = new Map(estimates.rows.map((r) => [r.name, Number(r.rows)]));

  const result = buildPlan({
    files: loaded,
    state,
    request,
    config,
    ...(adoption === undefined ? {} : { adoption }),
    lint: {
      ownerRoles,
      actingRole,
      existingTables: new Set(snapshot.tables.map((t) => `${t.schema}.${t.table}`)),
      // reltuples is -1 for a table never vacuumed or analyzed: "unknown", not "empty".
      rowEstimate: (table) => {
        const rows = rowEstimates.get(table);
        return rows === undefined || rows < 0 ? undefined : rows;
      }
    }
  });
  if (!result.ok) {
    throw new PolicyViolationError(result.error.code, result.error.message);
  }
  return { plan: result.plan, snapshot, state, efHistoryTablePresent: extra.rows[0]?.ef === true };
}

/**
 * Re-plan inside the locked session and prove that it is the plan that was approved. The digest
 * covers the snapshot, the ledger and every step, so equality is the whole proof. The separate
 * comparisons only exist to name what moved.
 */
export async function replanForExecution(
  db: Queryable,
  approved: { request: PlanRequest; environment: string; digest: string; preSnapshotId: string; historyStateId: string },
  config: DdlConfig
): Promise<LivePlan> {
  const fresh = await planAgainst(db, approved.request, config, approved.environment);
  // The ledger first: when another apply ran, the schema moved too, and "another apply ran" is
  // the answer that tells the caller what happened.
  if (fresh.state.stateId !== approved.historyStateId) {
    throw new PolicyViolationError("DDL_DRIFT", "The migration ledger changed since ddl_preview (another apply ran). Run ddl_preview again.");
  }
  if (fresh.snapshot.snapshotId !== approved.preSnapshotId) {
    throw new PolicyViolationError("DDL_DRIFT", "The schema changed since ddl_preview. Run ddl_preview again.");
  }
  const digest = planDigest({
    environment: approved.environment,
    preSnapshotId: fresh.snapshot.snapshotId,
    historyStateId: fresh.state.stateId,
    plan: fresh.plan
  });
  if (digest !== approved.digest) {
    throw new PolicyViolationError("DDL_DRIFT", "The migration files changed since ddl_preview. Run ddl_preview again.");
  }
  return fresh;
}

// ── the locked session ───────────────────────────────────────────────────────

export interface SessionTimeouts {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

/**
 * The session's own timeouts, for everything that is not a migration step: re-planning and the
 * snapshots on either side of the apply.
 *
 * The lock wait is the SHORTEST any step of the approved plan asked for. Reading the schema can
 * itself queue behind a lock (the catalog functions the snapshot calls take AccessShareLock on the
 * tables they read). An operator who wrote `-- mcp:lock-timeout-ms=500` asked to fail fast on a
 * busy table, so the planning phase must not wait the full default either.
 */
export function sessionTimeouts(config: DdlConfig, plan?: DdlPlan): SessionTimeouts {
  const stepLocks = plan?.steps.map((s) => s.timeouts.lockTimeoutMs) ?? [];
  return { lockTimeoutMs: Math.min(config.lockTimeoutMs, ...stepLocks), statementTimeoutMs: config.statementTimeoutMs };
}

async function setSessionTimeouts(client: pg.Client, timeouts: SessionTimeouts): Promise<void> {
  await client.query("select set_config('lock_timeout', $1, false), set_config('statement_timeout', $2, false)", [
    String(timeouts.lockTimeoutMs),
    String(timeouts.statementTimeoutMs)
  ]);
}

/**
 * Open a dedicated session, take the DDL advisory lock without waiting, run `fn`, and always
 * release both. `DDL_LOCKED` means another session holds the lock: another server process, or an
 * operator who took it on purpose.
 *
 * The session's timeouts are set before anything else runs. Without them, re-planning waited
 * forever behind an ACCESS EXCLUSIVE lock: the snapshot reads `information_schema.columns`, whose
 * `pg_get_expr` takes AccessShareLock on every table it reads, and this session has no
 * statement_timeout of its own. Found by `N/lock-timeout`, which hung until the request timed out.
 */
export async function withDdlSession<T>(
  poolConfig: PoolConfig,
  timeouts: SessionTimeouts,
  fn: (client: pg.Client, session: { pid: number }) => Promise<T>
): Promise<T> {
  const client = new pg.Client({
    ...poolConfig,
    application_name: "communicationhub-postgres-mcp:ddl",
    statement_timeout: 0
  });
  // A connection lost between statements is emitted as an `error` event, which crashes the process
  // when nothing listens. The failure is not lost by ignoring the event: the query in flight, or the
  // next one, rejects with it, and that is where the plan stops and reports.
  client.on("error", () => undefined);
  await client.connect();
  try {
    await setSessionTimeouts(client, timeouts);
    const locked = await tryTakeMigrationLock(client);
    if (!locked.ok) {
      throw new PolicyViolationError(
        "DDL_LOCKED",
        "Another session holds the DDL migration lock for this database. Wait for it to finish, then retry. If nothing is applying, a lock may have been left behind by a pooled connection (B-16.1): look for it with select pid, application_name from pg_locks join pg_stat_activity using (pid) where locktype = 'advisory'."
      );
    }
    try {
      // B-16.1: refuse a pooled session before relying on the lock or the timeouts it carries.
      await assertSessionPinned(client, locked.pid, "DDL_POOLED_CONNECTION");
      return await fn(client, { pid: locked.pid });
    } finally {
      await client.query("select pg_advisory_unlock($1, $2)", [...DDL_LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

// ── statement execution ──────────────────────────────────────────────────────

async function runStatement(client: pg.Client, text: string): Promise<number | null> {
  // QueryConfig's typings predate queryMode; pg 8.11+ honours it.
  const result = await client.query({ text, queryMode: "extended" } as QueryConfig);
  return result.rowCount;
}

/**
 * The plan's session role, through `set_config('role', …)` with a bound value: `SET LOCAL ROLE`
 * when `local`, `SET ROLE` on the non-transactional path. `null` (no role configured) is a no-op.
 * Only the migration's own statements run under it. Baselines, the internal-write check and the
 * ledger row run as the login, as they did before the role existed.
 */
async function setRole(client: pg.Client, role: string | null, local: boolean): Promise<void> {
  if (role !== null) {
    await client.query("select set_config('role', $1, $2)", [role, local]);
  }
}

async function resetRole(client: pg.Client, role: string | null, local: boolean): Promise<void> {
  if (role !== null) {
    await client.query("select set_config('role', 'none', $1)", [local]);
  }
}

async function setTimeouts(client: pg.Client, step: PlanStep, local: boolean, config: DdlConfig): Promise<void> {
  await client.query("select set_config('lock_timeout', $1, $3), set_config('statement_timeout', $2, $3)", [
    String(step.timeouts.lockTimeoutMs),
    String(step.timeouts.statementTimeoutMs),
    local
  ]);
  // A repo's migrations may read settings its runner provides (wec.aria's aria.expected_market).
  // The session is this lane's own and closes after the plan, so a session-level value in the
  // non-transactional path does not outlive it.
  for (const setting of config.sessionSettings ?? []) {
    await client.query("select set_config($1, $2, $3)", [setting.name, setting.value, local]);
  }
}

function stringProp(value: unknown, key: string): string | undefined {
  const v = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  return typeof v === "string" ? v : undefined;
}

function toStepError(error: unknown, step: PlanStep, statementIndex: number | null): StepError {
  const where = { version: step.version, name: step.name, statementIndex };
  if (error instanceof PolicyViolationError) {
    return { ...where, code: error.code, message: error.message };
  }
  const sqlState = stringProp(error, "code");
  const detail = stringProp(error, "message");
  const label = `${step.file ?? `inline '${step.name}'`}${statementIndex === null ? "" : `, statement ${String(statementIndex + 1)}`}`;
  if (sqlState === "55P03") {
    return {
      ...where,
      code: "DDL_LOCK_TIMEOUT",
      message: `${label}: could not acquire a lock within ${String(step.timeouts.lockTimeoutMs)} ms. Something else holds a conflicting lock; retry off-peak, or raise the wait with -- mcp:lock-timeout-ms (up to POSTGRES_DDL_LOCK_TIMEOUT_MS).`,
      sqlState,
      detail
    };
  }
  if (sqlState === "57014") {
    return {
      ...where,
      code: "DDL_STATEMENT_TIMEOUT",
      message: `${label}: exceeded statement_timeout (${String(step.timeouts.statementTimeoutMs)} ms).`,
      sqlState,
      detail
    };
  }
  return {
    ...where,
    code: "DDL_APPLY_FAILED",
    message: `${label} failed${sqlState === undefined ? "" : ` (SQLSTATE ${sqlState})`}. See detail.`,
    ...(sqlState === undefined ? {} : { sqlState }),
    ...(detail === undefined ? {} : { detail })
  };
}

export interface RowsAffected {
  statementIndex: number;
  rows: number;
}

/**
 * Run a step's statements in order, as `role`; on failure, report which one and why. Returns the
 * row count of every data change (INSERT / UPDATE / DELETE), which is what a backfill's reviewer
 * needs to see.
 *
 * On the transactional path a failure leaves the role for the rollback to undo, since an aborted
 * transaction accepts no further command. On the non-transactional path nothing would undo it, so
 * it is reset here.
 */
async function runStatements(
  client: pg.Client,
  step: PlanStep,
  role: string | null,
  local: boolean
): Promise<{ failure?: StepError; rowsAffected: RowsAffected[] }> {
  const rowsAffected: RowsAffected[] = [];
  try {
    await setRole(client, role, local);
  } catch (error) {
    return { failure: toStepError(error, step, null), rowsAffected };
  }
  for (const statement of step.statements) {
    try {
      const rows = await runStatement(client, statement.text);
      if (statement.kind === "data") {
        rowsAffected.push({ statementIndex: statement.index, rows: rows ?? 0 });
      }
    } catch (error) {
      if (!local) {
        await resetRole(client, role, false).catch(() => undefined);
      }
      return { failure: toStepError(error, step, statement.index), rowsAffected };
    }
  }
  try {
    await resetRole(client, role, local);
  } catch (error) {
    return { failure: toStepError(error, step, null), rowsAffected };
  }
  return { rowsAffected };
}

const withRows = (rowsAffected: RowsAffected[]): { rowsAffected?: RowsAffected[] } => (rowsAffected.length === 0 ? {} : { rowsAffected });

async function invalidIndexes(client: pg.Client): Promise<Set<string>> {
  const result = await client.query<{ name: string }>("select indexrelid::regclass::text as name from pg_index where not indisvalid");
  return new Set(result.rows.map((r) => r.name));
}

// ── dry run ──────────────────────────────────────────────────────────────────

/**
 * Run every transactional migration inside ONE transaction, each under its own savepoint, then
 * roll the whole thing back. Later migrations see earlier ones' effects, as they will at apply.
 * Non-transactional migrations cannot run inside a transaction at all, so they are skipped and
 * reported as skipped, never as passed.
 */
export async function dryRunPlan(client: pg.Client, plan: DdlPlan, session: { pid: number }, config: DdlConfig): Promise<DryRunResult> {
  const steps: DryRunStepResult[] = [];
  let error: StepError | undefined;
  /** Why a later failure may not be real: the first kind of step the dry run could not run. */
  let skippedBefore: string | undefined;
  /** An earlier step that added an enum value, which stays unusable until that step commits. */
  let addedEnumValue: string | undefined;

  await client.query("begin");
  // Inside the transaction: a transaction pins one backend even through a pooler, so one check
  // here covers every step that follows.
  await assertSessionPinned(client, session.pid, "DDL_POOLED_CONNECTION");
  try {
    for (const step of plan.steps) {
      const base = { version: step.version, name: step.name, action: step.action };
      if (error !== undefined) {
        steps.push({ ...base, status: "not_run" });
        continue;
      }
      if (step.action === "adopt") {
        steps.push({ ...base, status: "ok", reason: "adopt: nothing runs; the ledger records that an inline apply already ran this file" });
        continue;
      }
      if (step.mode === "non_transactional") {
        skippedBefore ??= "a non-transactional migration the dry run skipped";
        steps.push({ ...base, status: "skipped", reason: "NON_TRANSACTIONAL: cannot run inside the dry run's transaction" });
        continue;
      }
      const started = Date.now();
      await client.query("savepoint ddl_step");
      await setTimeouts(client, step, true, config);
      const baseline = await internalState(client);
      const ran = await runStatements(client, step, plan.sessionRole, true);
      let failure = ran.failure;
      if (failure === undefined) {
        try {
          await assertNoInternalWrites(client, baseline, "DDL_RESERVED_SCHEMA", INTERNAL_WRITE_MESSAGE);
        } catch (guard) {
          failure = toStepError(guard, step, null);
        }
      }
      if (failure !== undefined) {
        await client.query("rollback to savepoint ddl_step");
        // 55P04: "unsafe use of new value" of an enum. Postgres refuses to use a value added in the
        // same transaction, and the dry run runs every step in one. At apply, each migration
        // commits first, so this is the dry run's own limit, not the step's. It is reported as
        // skipped, never as passed, and the run goes on. A value added and used in ONE migration
        // fails at apply too, which is why only an earlier step's ADD VALUE counts.
        if (failure.sqlState === "55P04" && addedEnumValue !== undefined) {
          skippedBefore ??= `${addedEnumValue}, which the dry run could not commit`;
          steps.push({
            ...base,
            status: "skipped",
            durationMs: Date.now() - started,
            reason: `ENUM_VALUE_UNCOMMITTED: uses an enum value ${addedEnumValue} adds. Postgres allows that only after ${addedEnumValue} commits, as it will at apply; the dry run keeps every step in one transaction, so it cannot check this one. Dry-run again once ${addedEnumValue} is applied.`
          });
          continue;
        }
        error = skippedBefore === undefined ? failure : { ...failure, message: `${failure.message} It may depend on ${skippedBefore}.` };
        steps.push({ ...base, status: "failed", durationMs: Date.now() - started });
        continue;
      }
      await client.query("release savepoint ddl_step");
      if (step.risks.some((r) => r.code === "ALTER_TYPE_ADD_VALUE")) {
        addedEnumValue ??= step.file ?? `inline '${step.name}'`;
      }
      steps.push({ ...base, status: "ok", durationMs: Date.now() - started, ...withRows(ran.rowsAffected) });
    }
  } finally {
    await client.query("rollback").catch(() => undefined);
  }

  return { status: error === undefined ? "ok" : "failed", ranAt: new Date().toISOString(), steps, ...(error === undefined ? {} : { error }) };
}

// ── apply ────────────────────────────────────────────────────────────────────

export interface ApplyStepResult {
  version: string | null;
  name: string;
  action: "apply" | "adopt" | "revert";
  status: "applied" | "adopted" | "reverted" | "failed" | "not_run";
  /** Row counts of the step's INSERT / UPDATE / DELETE statements, when it has any. */
  rowsAffected?: RowsAffected[];
  durationMs?: number;
  historyId?: number;
}

export interface ApplyResult {
  status: "applied" | "partial" | "failed";
  steps: ApplyStepResult[];
  error?: StepError & { invalidIndexesLeft?: string[] };
}

function historyKind(plan: DdlPlan, step: PlanStep): "file" | "inline" | "adopted" {
  if (step.action === "adopt") {
    return "adopted";
  }
  return plan.kind === "inline" ? "inline" : "file";
}

/** The ledger row for a step, minus the outcome fields. */
function ledgerRow(plan: DdlPlan, step: PlanStep, meta: { environment: string; previewId: string }) {
  return {
    version: step.version,
    name: step.name,
    kind: historyKind(plan, step),
    direction: step.action === "revert" ? ("down" as const) : ("up" as const),
    checksum: step.checksum,
    upChecksum: step.upChecksum,
    executionMode: step.mode,
    statementCount: step.statements.length,
    environment: meta.environment,
    previewId: meta.previewId
  };
}

async function recordFailure(client: pg.Client, plan: DdlPlan, step: PlanStep, meta: ApplyMeta, error: StepError, durationMs: number): Promise<void> {
  // Outside the rolled-back transaction, so the attempt is on record. Best effort: losing the
  // failed row must not hide the failure itself from the caller.
  await meta.ledger
    .recordFailure(
      client,
      { ...ledgerRow(plan, step, meta), status: "failed", failedStatement: error.statementIndex, errorSqlstate: error.sqlState ?? null, durationMs },
      HOST
    )
    .catch(() => undefined);
}

export interface ApplyMeta {
  environment: string;
  previewId: string;
  session: SessionTimeouts;
  pid: number;
  ledger: DdlLedger;
  config: DdlConfig;
}

export async function applyPlan(client: pg.Client, plan: DdlPlan, meta: ApplyMeta): Promise<ApplyResult> {
  const steps: ApplyStepResult[] = [];
  let error: ApplyResult["error"];

  for (const step of plan.steps) {
    const base = { version: step.version, name: step.name, action: step.action };
    if (error !== undefined) {
      steps.push({ ...base, status: "not_run" });
      continue;
    }
    const started = Date.now();
    // Between steps the session is outside a transaction, which is exactly where a pooler may
    // move it to another backend. A move stops the plan before the next step runs.
    try {
      await assertSessionPinned(client, meta.pid, "DDL_POOLED_CONNECTION");
    } catch (pinError) {
      error = toStepError(pinError, step, null);
      steps.push({ ...base, status: "not_run" });
      continue;
    }

    if (step.action === "adopt") {
      const historyId = await meta.ledger.recordApplied(
        client,
        { ...ledgerRow(plan, step, meta), status: "applied", failedStatement: null, errorSqlstate: null, durationMs: 0 },
        step.ledgerFile ?? step.file,
        HOST
      );
      steps.push({ ...base, status: "adopted", durationMs: 0, ...(historyId === undefined ? {} : { historyId }) });
      continue;
    }

    const done = step.action === "revert" ? ("reverted" as const) : ("applied" as const);

    if (step.mode === "transactional") {
      await client.query("begin");
      let failure: StepError | undefined;
      let historyId: number | undefined;
      let rowsAffected: RowsAffected[] = [];
      try {
        await setTimeouts(client, step, true, meta.config);
        const baseline = await internalState(client);
        const ran = await runStatements(client, step, plan.sessionRole, true);
        failure = ran.failure;
        rowsAffected = ran.rowsAffected;
        if (failure === undefined) {
          // Before the ledger insert, which is the one write to mcp_ops that belongs here.
          await assertNoInternalWrites(client, baseline, "DDL_RESERVED_SCHEMA", INTERNAL_WRITE_MESSAGE);
          historyId = await meta.ledger.recordApplied(
            client,
            { ...ledgerRow(plan, step, meta), status: "applied", failedStatement: null, errorSqlstate: null, durationMs: Date.now() - started },
            step.ledgerFile ?? step.file,
            HOST
          );
          await client.query("commit");
        }
      } catch (unexpected) {
        failure = toStepError(unexpected, step, null);
      }
      if (failure !== undefined) {
        await client.query("rollback").catch(() => undefined);
        error = failure;
        await recordFailure(client, plan, step, meta, failure, Date.now() - started);
        steps.push({ ...base, status: "failed", durationMs: Date.now() - started });
        continue;
      }
      steps.push({ ...base, status: done, durationMs: Date.now() - started, ...(historyId === undefined ? {} : { historyId }), ...withRows(rowsAffected) });
      continue;
    }

    // Non-transactional: one statement, session-level timeouts, no surrounding transaction.
    const invalidBefore = await invalidIndexes(client);
    await setTimeouts(client, step, false, meta.config);
    const { failure } = await runStatements(client, step, plan.sessionRole, false);
    // Back to the session's own timeouts, not to the server default: RESET would mean "no
    // lock_timeout" for the post-apply snapshot that follows.
    await setSessionTimeouts(client, meta.session).catch(() => undefined);
    if (failure !== undefined) {
      const invalidAfter = await invalidIndexes(client).catch(() => new Set<string>());
      const left = [...invalidAfter].filter((name) => !invalidBefore.has(name));
      error = {
        ...failure,
        ...(left.length === 0
          ? {}
          : {
              invalidIndexesLeft: left,
              message: `${failure.message} The failed build left INVALID index(es) ${left.join(", ")}; drop them (DROP INDEX CONCURRENTLY IF EXISTS …) before retrying.`
            })
      };
      await recordFailure(client, plan, step, meta, failure, Date.now() - started);
      steps.push({ ...base, status: "failed", durationMs: Date.now() - started });
      continue;
    }
    const historyId = await meta.ledger.recordApplied(
      client,
      { ...ledgerRow(plan, step, meta), status: "applied", failedStatement: null, errorSqlstate: null, durationMs: Date.now() - started },
      step.ledgerFile ?? step.file,
      HOST
    );
    steps.push({ ...base, status: done, durationMs: Date.now() - started, ...(historyId === undefined ? {} : { historyId }) });
  }

  const succeeded = steps.filter((s) => s.status === "applied" || s.status === "adopted" || s.status === "reverted").length;
  const status = error === undefined ? "applied" : succeeded > 0 ? "partial" : "failed";
  return { status, steps, ...(error === undefined ? {} : { error }) };
}
