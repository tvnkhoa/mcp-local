/**
 * The guardrail for the data-write lane (`write_preview` / `write_apply`). ADR 0006.
 *
 * The read guardrail accepts one SELECT. This one accepts a *batch* — `DECLARE`, table variables,
 * `INSERT`/`UPDATE`/`DELETE`/`MERGE`, `IF`, `TRY/CATCH`, `THROW` and the batch's own transaction —
 * because that is the shape a real seed script has. What it must still keep out falls in two
 * classes, and they are checked differently:
 *
 *  1. **Things the lane never does** — DDL, permissions, dynamic SQL, reaching another server or
 *     catalog, instance administration. Tokens and shapes, as in ADR 0004.
 *  2. **Things that would make a preview persist.** The preview runs inside a transaction this
 *     server opens and rolls back. A `COMMIT` or `ROLLBACK` in the batch can end that transaction
 *     early, and every statement after it would then autocommit — during a *preview*. The rules
 *     in {@link checkTransactionControl} are what make "preview persists nothing" true; read them
 *     before relaxing anything here.
 */

import { findForbiddenToken, scanSql, startsWithAllowedKeyword, type SqlScanOptions } from "@mcp/shared";

import { hasFourPartName, type GuardrailResult } from "./sqlGuardrails.js";

const TSQL_SCAN: SqlScanOptions = {
  dollarQuotedStrings: false,
  escapeStrings: false,
  bracketQuotedIdentifiers: true
};

/**
 * What a batch may start with.
 *
 * Not decoration: T-SQL runs a bare procedure name as the FIRST statement of a batch without
 * `EXEC` — `xp_cmdshell 'dir'` on line one is a call. The forbidden-token list cannot see that,
 * because no token is involved, so the first word is pinned instead.
 */
const LEADING_KEYWORDS = ["begin", "declare", "set", "insert", "update", "delete", "merge", "with", "select", "if"];

/** At least one of these must appear, or there is nothing for the lane to do. */
const WRITE_VERBS = /\b(?:insert|update|delete|merge)\b/;

/**
 * Bare words refused anywhere outside a literal, comment or bracketed identifier.
 *
 * ADR 0004's read list minus the four data verbs (and `into`, handled by {@link checkInto}),
 * plus the words that only matter once statements may follow one another.
 */
const FORBIDDEN_TOKENS = [
  // Schema and permission change.
  "create",
  "alter",
  "drop",
  "truncate",
  "grant",
  "revoke",
  "deny",
  "trigger",
  // Running something else, or as someone else.
  "exec",
  "execute",
  "sp_executesql",
  "setuser",
  // Another server, or another catalog's context.
  "openquery",
  "openrowset",
  "opendatasource",
  "openxml",
  "use",
  // Instance administration and denial of service.
  "shutdown",
  "dbcc",
  "backup",
  "restore",
  "kill",
  "waitfor",
  "reconfigure",
  "sp_configure",
  "bulk",
  "writetext",
  "updatetext",
  // Transaction shapes the preview cannot contain — see checkTransactionControl.
  "save",
  "distributed",
  "goto"
] as const;

/** Any extended procedure, not only the famous one. */
const EXTENDED_PROCEDURE = /\bxp_\w+/;

/** `GO` is a client-side batch separator (sqlcmd, SSMS). The server sees it as a syntax error. */
const GO_LINE = /^[ \t]*go(?:[ \t]+\d+)?[ \t]*;?[ \t]*$/im;

export interface WriteGuardrailOk {
  readonly ok: true;
  readonly sanitizedSql: string;
  /**
   * `COMMIT` statements in the batch. The runner opens this many extra transaction levels before
   * the batch, so no sequence of them can take `@@TRANCOUNT` to zero. See checkTransactionControl.
   */
  readonly commitCount: number;
}

export type WriteGuardrailResult = WriteGuardrailOk | Extract<GuardrailResult, { ok: false }>;

function reject(code: string, message: string): WriteGuardrailResult {
  return { ok: false, error: { code, message } };
}

/**
 * Accept a write batch, or explain why not.
 *
 * Order: shape problems first (empty, unterminated, `GO`), then what the batch starts with, then
 * tokens, then transaction control — so the caller is told the most actionable thing first.
 */
export function validateWriteBatch(inputSql: string, maxLength = 100_000): WriteGuardrailResult {
  const sql = typeof inputSql === "string" ? inputSql.trim() : "";
  if (sql === "") {
    return reject("validation_error", "SQL cannot be empty.");
  }
  if (sql.length > maxLength) {
    return reject("validation_error", `SQL exceeds the maximum length of ${maxLength} characters.`);
  }

  const scan = scanSql(sql, TSQL_SCAN);
  if (scan.unterminated) {
    return reject(
      "validation_error",
      "SQL contains an unterminated string literal, comment, or [bracketed identifier]."
    );
  }
  const cleaned = scan.cleaned.toLowerCase();
  if (cleaned.trim() === "") {
    return reject("validation_error", "SQL contains no executable statement.");
  }

  if (GO_LINE.test(cleaned)) {
    return reject(
      "validation_error",
      "GO is a client-side batch separator, not T-SQL. Submit one batch: remove the GO lines (and " +
        "any USE — the `database` argument names the catalog)."
    );
  }

  if (!startsWithAllowedKeyword(cleaned, LEADING_KEYWORDS)) {
    return reject(
      "validation_error",
      `A write batch must start with one of: ${LEADING_KEYWORDS.join(", ")}. ` +
        "A bare procedure name on the first line would be executed."
    );
  }

  if (!WRITE_VERBS.test(cleaned)) {
    return reject(
      "validation_error",
      "The batch contains no INSERT, UPDATE, DELETE or MERGE. Use run_read_query for reads."
    );
  }

  if (hasFourPartName(sql)) {
    return reject(
      "policy_violation",
      "Four-part names (server.database.schema.object) reach a linked server and are not allowed."
    );
  }

  const forbidden = findForbiddenToken(cleaned, FORBIDDEN_TOKENS);
  if (forbidden !== undefined) {
    return reject("validation_error", `Forbidden token in a write batch: ${forbidden}.`);
  }
  const extended = EXTENDED_PROCEDURE.exec(cleaned);
  if (extended !== null) {
    return reject("validation_error", `Forbidden token in a write batch: ${extended[0]}.`);
  }

  const into = checkInto(cleaned);
  if (into !== undefined) {
    return into;
  }

  const transaction = checkTransactionControl(cleaned);
  if (!transaction.ok) {
    return transaction;
  }

  return { ok: true, sanitizedSql: sql, commitCount: transaction.commitCount };
}

/**
 * `INTO` is a write verb's preposition or a table being created.
 *
 * `INSERT INTO`, `MERGE INTO` and `OUTPUT … INTO @t` are fine. `SELECT … INTO dbo.T` creates a
 * permanent table, which is DDL by another name. `SELECT … INTO #t` creates a temporary one, which
 * dies with the session and is allowed.
 */
function checkInto(cleaned: string): WriteGuardrailResult | undefined {
  for (const match of cleaned.matchAll(/\binto\b/g)) {
    const before = cleaned.slice(0, match.index).trimEnd();
    const after = cleaned.slice((match.index ?? 0) + match[0].length).trimStart();
    if (/\b(?:insert|merge)$/.test(before) || /^[@#]/.test(after)) {
      continue;
    }
    return reject(
      "validation_error",
      "SELECT … INTO a permanent table creates it, which the write lane does not do. " +
        "INSERT INTO an existing table, or SELECT INTO a #temporary table or @table variable."
    );
  }
  return undefined;
}

type TransactionCheck = { readonly ok: true; readonly commitCount: number } | Extract<WriteGuardrailResult, { ok: false }>;

/**
 * The rules that keep a preview from persisting anything.
 *
 * The runner wraps the batch in its own transaction and rolls it back. SQL Server transactions do
 * not nest — `BEGIN TRAN` only increments `@@TRANCOUNT` — so:
 *
 * - **`COMMIT`** decrements it, and commits for real only when it reaches zero. The runner opens
 *   one extra level per `COMMIT` in the text, so the batch's commits cannot reach zero *provided
 *   each runs at most once*. Hence `WHILE` and `GOTO` are refused in a batch that commits:
 *   without them T-SQL has no backward jump, and a statement runs once or not at all.
 * - **`ROLLBACK`** goes straight to zero, whatever the level. Anything after it autocommits. The
 *   one place that is harmless is the standard pattern — `ROLLBACK` then `THROW` at the end of a
 *   `CATCH` block that is not itself inside another `TRY`/`CATCH` — because that `THROW` ends the
 *   batch. Every other `ROLLBACK` is refused, as are `SAVE TRAN` and `ROLLBACK` to a savepoint.
 *
 * Works on literal- and comment-blanked text, so `'ROLLBACK'` in a string is not a statement.
 */
export function checkTransactionControl(cleaned: string): TransactionCheck {
  const commitCount = (cleaned.match(/\bcommit\b/g) ?? []).length;
  if (commitCount > 0) {
    const loop = /\b(while|goto)\b/.exec(cleaned);
    if (loop !== null) {
      return reject(
        "validation_error",
        `A batch that COMMITs may not use ${loop[1]!.toUpperCase()}: a COMMIT that can run twice ` +
          "could commit the preview's own transaction. Remove the COMMIT (the server supplies the " +
          "transaction) or the loop."
      );
    }
  }

  // Positions of TRY/CATCH block boundaries, to know what encloses each ROLLBACK.
  const blocks = [...cleaned.matchAll(/\b(begin|end)\s+(try|catch)\b/g)].map((m) => ({
    index: m.index ?? 0,
    opens: m[1] === "begin",
    kind: m[2] as "try" | "catch"
  }));

  for (const match of cleaned.matchAll(/\brollback\b/g)) {
    const at = match.index ?? 0;
    const stack: Array<"try" | "catch"> = [];
    for (const block of blocks) {
      if (block.index >= at) {
        break;
      }
      if (block.opens) {
        stack.push(block.kind);
      } else {
        stack.pop();
      }
    }
    const rest = cleaned.slice(at);
    const shape = /^rollback(?:\s+(?:tran|transaction))?\s*;?\s*throw\b[^;]*?;?\s*end\s+catch\b/;
    if (stack.length === 1 && stack[0] === "catch" && shape.test(rest)) {
      continue;
    }
    return reject(
      "validation_error",
      "ROLLBACK is allowed only as `ROLLBACK; THROW;` at the end of a top-level CATCH block. " +
        "Anywhere else it ends the preview's transaction early and the statements after it would " +
        "be committed. The server rolls back the preview itself, and write_apply rolls back on any error."
    );
  }

  return { ok: true, commitCount };
}
