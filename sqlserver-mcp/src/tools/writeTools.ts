/**
 * The data-write lane: `write_preview` → `write_apply`. ADR 0006.
 *
 * Off unless `SQLSERVER_WRITE_ENABLED=true`, and then only against an environment named in
 * `SQLSERVER_WRITABLE_ENVIRONMENTS` — never `prod` or `uat` — and a catalog not in
 * `SQLSERVER_READONLY_DATABASES`. Every gate is re-checked at apply, because configuration and the
 * stored preview are the only things apply trusts; the caller's arguments are not.
 *
 * There is no `write_rollback`. Postgres can restore captured rows because its lane accepts one
 * statement against one table; a batch can touch any number of tables through control flow, so
 * there is nothing general to capture. The preview is the safety mechanism here, and apply refuses
 * to commit when the data has moved since (`rowsAffected` differs).
 */

import { ok } from "@mcp/core";
import type { AnyToolDefinition } from "@mcp/sdk";
import { defineTool, featureFlagGuard, schema } from "@mcp/sdk";
import { describePreviewTokenRejection, issuePreviewToken, verifyPreviewToken } from "@mcp/shared";
import { z } from "zod";

import { NEVER_WRITABLE_ENVIRONMENTS } from "../config/index.js";
import { PolicyViolationError } from "../middleware/errors.js";
import { referencedCatalogCandidates } from "../middleware/sqlGuardrails.js";
import { validateWriteBatch } from "../middleware/writeGuardrails.js";
import type { ResolvedTarget } from "../repositories/connectionManager.js";
import { runWriteBatch, type WriteRunOutcome } from "../repositories/writeRunner.js";
import { recordWriteAudit, sqlHash, writeDigest, WritePreviewStore } from "../services/writePreviews.js";
import {
  clamp,
  databaseArg,
  databaseProp,
  environmentArg,
  environmentProp,
  profileArg,
  appliesWrite,
  previewsWrite,
  profileProp,
  type SqlserverDeps
} from "./common.js";

export function buildWriteTools(deps: SqlserverDeps): AnyToolDefinition[] {
  const { config, connections, logger } = deps;
  const store = new WritePreviewStore();

  const enabledGuard = featureFlagGuard(
    "write-enabled",
    () => config.write.enabled,
    "Data writes are disabled. Set SQLSERVER_WRITE_ENABLED=true (and name the environment in " +
      "SQLSERVER_WRITABLE_ENVIRONMENTS) to enable them."
  );

  /**
   * The environment and catalog gates, in the order an operator would look for them. Each refusal
   * names its gate in the code and the message, so "why was this refused" never needs a log.
   */
  function assertWritable(target: ResolvedTarget): void {
    const environment = target.environment.name;
    if (NEVER_WRITABLE_ENVIRONMENTS.includes(environment)) {
      throw new PolicyViolationError(
        "environment_never_writable",
        `Environment "${environment}" is never writable by the write lane, whatever ` +
          "SQLSERVER_WRITABLE_ENVIRONMENTS says."
      );
    }
    if (!config.write.writableEnvironments.includes(environment)) {
      throw new PolicyViolationError(
        "environment_not_writable",
        `Environment "${environment}" is not in SQLSERVER_WRITABLE_ENVIRONMENTS.`
      );
    }
    if (connections.isReadOnlyDatabase(target.database)) {
      throw new PolicyViolationError(
        "database_readonly",
        `Database "${target.database}" is listed in SQLSERVER_READONLY_DATABASES.`
      );
    }
  }

  /**
   * A write batch addresses one catalog. A three-part name naming any other real catalog on the
   * instance is refused — reads from it included, since telling the write target of an
   * `INSERT … SELECT` from its source is not something a text check can do reliably.
   */
  async function assertSingleCatalog(target: ResolvedTarget, sql: string): Promise<void> {
    const candidates = referencedCatalogCandidates(sql);
    if (candidates.length === 0) {
      return;
    }
    const known = await connections.catalogNames(target);
    const own = target.database.toLowerCase();
    const others = candidates.filter((name) => known.has(name) && name !== own);
    if (others.length > 0) {
      throw new PolicyViolationError(
        "write_cross_catalog",
        `A write batch may reference only its own catalog (${target.database}); it names: ${others.join(", ")}.`
      );
    }
  }

  /** Map every non-success outcome to a refusal. Nothing below commits on these paths. */
  function refuseOutcome(outcome: Exclude<WriteRunOutcome, { status: "rolled_back" | "committed" }>): never {
    switch (outcome.status) {
      case "batch_failed": {
        const at = outcome.error.lineNumber !== undefined ? ` at line ${outcome.error.lineNumber}` : "";
        const number = outcome.error.number !== undefined ? ` ${outcome.error.number}` : "";
        throw new PolicyViolationError(
          "batch_failed",
          `SQL Server error${number}${at}: ${outcome.error.message} The transaction was rolled back; nothing was persisted.`
        );
      }
      case "timed_out":
        throw new PolicyViolationError(
          "timeout",
          `The batch did not finish within ${String(config.write.timeoutMs)} ms and was cancelled and rolled back.`
        );
      case "transaction_unbalanced":
        throw new PolicyViolationError(
          "transaction_unbalanced",
          `The batch left @@TRANCOUNT at ${String(outcome.actual)} where ${String(outcome.expected)} was ` +
            "expected — a BEGIN TRAN without its COMMIT, or the reverse. Rolled back; nothing was persisted."
        );
      case "drifted":
        throw new PolicyViolationError(
          "write_drift",
          `rowsAffected at apply [${outcome.result.rowsAffected.join(", ")}] differs from the preview ` +
            `[${outcome.expected.join(", ")}]: the data changed since the preview. Rolled back; run write_preview again.`
        );
    }
  }

  const writePreview = defineTool({
    name: "write_preview",
    title: "Preview write batch",
    description:
      "Run a T-SQL write batch (DECLARE, INSERT/UPDATE/DELETE/MERGE, IF, TRY/CATCH, THROW, its own " +
      "BEGIN TRAN/COMMIT) inside a transaction that is always rolled back, and return rowsAffected " +
      "per statement, any SELECT recordsets (end the batch with a verify SELECT to see the would-be " +
      "state), and a previewId + approvalToken for write_apply. DISABLED unless " +
      "SQLSERVER_WRITE_ENABLED=true; only environments in SQLSERVER_WRITABLE_ENVIRONMENTS, never " +
      "prod or uat. Refuses DDL, EXEC, USE, GO, cross-catalog names, and ROLLBACK except " +
      "`ROLLBACK; THROW;` closing a CATCH block.",
    annotations: previewsWrite,
    guards: [enabledGuard],
    inputSchema: schema.object(
      {
        sql: schema.string("One T-SQL batch. No GO, no USE — `database` names the catalog."),
        environment: environmentProp,
        database: databaseProp,
        maxRows: schema.integer("Row cap per returned recordset. Surplus rows are discarded, not cancelled."),
        profile: profileProp
      },
      { required: ["sql"] }
    ),
    input: z
      .object({
        sql: z.string().min(1).max(100_000),
        environment: environmentArg,
        database: databaseArg,
        maxRows: z.number().int().positive().optional(),
        profile: profileArg
      })
      .strict(),
    handler: async (input) => {
      const target = connections.resolve(input.environment, input.database);
      assertWritable(target);

      const guard = validateWriteBatch(input.sql);
      if (!guard.ok) {
        throw new PolicyViolationError(guard.error.code, guard.error.message);
      }
      await assertSingleCatalog(target, guard.sanitizedSql);

      const outcome = await runWriteBatch(await connections.pool(target), guard.sanitizedSql, {
        mode: "preview",
        commitCount: guard.commitCount,
        maxRows: clamp(input.maxRows, config.limits.defaultLimit, config.limits.maxLimit),
        timeoutMs: config.write.timeoutMs
      });
      if (outcome.status !== "rolled_back") {
        if (outcome.status === "committed") {
          throw new Error("write_preview: runner committed in preview mode");
        }
        refuseOutcome(outcome);
      }

      const { result } = outcome;
      const expiresAt = new Date(Date.now() + config.write.previewTtlMs).toISOString();
      const hash = sqlHash(guard.sanitizedSql);
      const digest = writeDigest({
        environment: target.environment.name,
        database: target.database,
        sql: guard.sanitizedSql,
        rowsAffected: result.rowsAffected
      });
      const preview = store.save({
        environment: target.environment.name,
        database: target.database,
        sql: guard.sanitizedSql,
        commitCount: guard.commitCount,
        rowsAffected: result.rowsAffected,
        digest,
        sqlHash: hash,
        expiresAt
      });

      logger.info("write_previewed", {
        environment: preview.environment,
        database: preview.database,
        previewId: preview.previewId,
        sqlHash: hash,
        rowsAffected: result.rowsAffected,
        elapsedMs: result.elapsedMs
      });

      return ok({
        environment: preview.environment,
        database: preview.database,
        persisted: false,
        previewId: preview.previewId,
        approvalToken: issuePreviewToken(
          { previewId: preview.previewId, digest, expiresAt },
          config.write.approvalSecret
        ),
        expiresAt,
        sqlHash: hash,
        rowsAffected: result.rowsAffected,
        recordsets: result.recordsets,
        truncated: result.truncated,
        elapsedMs: result.elapsedMs,
        note:
          "Rolled back. rowsAffected has one entry per statement that reports a count (SELECT " +
          "assignments and table-variable inserts included). write_apply re-runs this exact batch " +
          "and commits only if it reports the same rowsAffected."
      });
    }
  });

  const writeApply = defineTool({
    name: "write_apply",
    title: "Apply write batch",
    description:
      "Commit a batch previewed by write_preview, using its previewId + approvalToken. Re-runs the " +
      "exact previewed batch against the previewed environment and catalog, re-checks every gate, " +
      "and rolls back instead of committing if rowsAffected differs from the preview. Single-use; " +
      "no rollback tool exists, so read the preview first.",
    annotations: appliesWrite,
    guards: [enabledGuard],
    inputSchema: schema.object(
      {
        previewId: schema.string("From write_preview."),
        approvalToken: schema.string("From write_preview."),
        profile: profileProp
      },
      { required: ["previewId", "approvalToken"] }
    ),
    input: z
      .object({
        previewId: z.string().min(1).max(128),
        approvalToken: z.string().min(1).max(4096),
        profile: profileArg
      })
      .strict(),
    handler: async (input) => {
      const preview = store.get(input.previewId);
      if (preview === undefined) {
        throw new PolicyViolationError(
          "preview_not_found",
          "No pending preview with that previewId — it expired, was already applied, or the server restarted. Run write_preview again."
        );
      }
      const verdict = verifyPreviewToken(
        input.approvalToken,
        { previewId: preview.previewId, digest: preview.digest, expiresAt: preview.expiresAt },
        config.write.approvalSecret
      );
      if (!verdict.ok) {
        const rejection = describePreviewTokenRejection(verdict.reason);
        throw new PolicyViolationError(rejection.code, rejection.message);
      }

      // Configuration may have changed since the preview; the stored target is re-resolved and
      // re-gated, and the stored text re-validated, rather than trusted.
      const target = connections.resolve(preview.environment, preview.database);
      assertWritable(target);
      const guard = validateWriteBatch(preview.sql);
      if (!guard.ok) {
        throw new PolicyViolationError(guard.error.code, guard.error.message);
      }
      await assertSingleCatalog(target, guard.sanitizedSql);

      store.take(preview.previewId);
      const audit = {
        environment: preview.environment,
        database: preview.database,
        previewId: preview.previewId,
        sqlHash: preview.sqlHash
      };

      let outcome: WriteRunOutcome;
      try {
        outcome = await runWriteBatch(await connections.pool(target), guard.sanitizedSql, {
          mode: "apply",
          commitCount: guard.commitCount,
          maxRows: config.limits.defaultLimit,
          timeoutMs: config.write.timeoutMs,
          expectedRowsAffected: preview.rowsAffected
        });
      } catch (error) {
        await recordWriteAudit(logger, config.write.auditFile, {
          ...audit,
          status: "error",
          rowsAffected: null,
          elapsedMs: null
        });
        throw error;
      }

      const rowsAffected = "result" in outcome ? outcome.result.rowsAffected : null;
      const elapsedMs = "result" in outcome ? outcome.result.elapsedMs : null;
      await recordWriteAudit(logger, config.write.auditFile, {
        ...audit,
        status: outcome.status,
        rowsAffected,
        elapsedMs
      });

      if (outcome.status !== "committed") {
        if (outcome.status === "rolled_back") {
          throw new Error("write_apply: runner rolled back in apply mode");
        }
        refuseOutcome(outcome);
      }

      return ok({
        environment: preview.environment,
        database: preview.database,
        persisted: true,
        previewId: preview.previewId,
        sqlHash: preview.sqlHash,
        rowsAffected: outcome.result.rowsAffected,
        recordsets: outcome.result.recordsets,
        truncated: outcome.result.truncated,
        elapsedMs: outcome.result.elapsedMs
      });
    }
  });

  return [writePreview, writeApply];
}
