/**
 * Risk lint for DDL migrations: what a statement will do to data and to locks, before it runs.
 *
 * It runs over statements that `validateDdlScript` has already accepted. The guardrail decides
 * what is ALLOWED, and it fails closed. The lint decides what needs a human to say yes, and it
 * fails open: a pattern it does not recognise produces no finding, never a refusal. So it is a
 * safety net for the common hazards, not a proof that a migration is safe.
 *
 * Levels:
 *  - `info` and `warning` are reported only.
 *  - `high` must be named in `acknowledgeRisks` at apply time.
 *  - `blocked` is refused at preview, whatever the caller acknowledges.
 *
 * Context matters. `ALTER COLUMN … TYPE` on a table created three statements earlier rewrites
 * nothing anyone depends on. The same statement on a populated table takes an ACCESS EXCLUSIVE
 * lock for the length of a rewrite. Table-scoped rules therefore fire only on tables that already
 * exist: in `context.existingTables`, and not created earlier in the same plan. With no context
 * at all, every table counts as existing, which is the safe reading.
 */

import { topLevelWords, type DdlStatement, type Token } from "./ddlGuardrails.js";

export type RiskLevel = "info" | "warning" | "high" | "blocked";

export interface RiskFinding {
  code: string;
  level: RiskLevel;
  /** 0-based, within the script the statement came from. */
  statementIndex: number;
  /** The object the finding is about, qualified as `schema.name`, when there is one. */
  target?: string;
  message: string;
}

export interface LintContext {
  /** `schema.table` for every table that exists before the plan runs (from the pre-snapshot). */
  existingTables?: ReadonlySet<string>;
  /** Estimated row count (`pg_class.reltuples`) for an existing table, when known. */
  rowEstimate?: (table: string) => number | undefined;
  /** Schema for unqualified names. Postgres would use search_path; `public` is its default. */
  defaultSchema?: string;
  /**
   * Tables created by earlier statements in the plan. A plan lints one migration at a time, so
   * the planner passes the same Set to every call and a table created in migration 1 does not
   * count as existing in migration 2. The lint adds to it. When omitted, a fresh Set is used.
   */
  createdInPlan?: Set<string>;
}

export interface LintResult {
  findings: RiskFinding[];
  /** Distinct `high` codes, in first-seen order: what `acknowledgeRisks` must contain. */
  requiredAcknowledgements: string[];
  blocked: RiskFinding[];
}

/** A non-concurrent index build on a table this large is `high` rather than `warning`. */
export const LARGE_TABLE_ROWS = 1_000_000;

/**
 * Functions whose value differs per row. A DEFAULT built on one of them makes ADD COLUMN
 * rewrite the table (PG11+ stores a non-volatile default once, in the catalog). `now()` is
 * stable, not volatile, and is deliberately absent.
 */
const VOLATILE_FUNCTIONS = new Set(["random", "gen_random_uuid", "clock_timestamp", "timeofday", "nextval", "txid_current", "uuid_generate_v1", "uuid_generate_v1mc", "uuid_generate_v4"]);

// ── token helpers ────────────────────────────────────────────────────────────

const isName = (t: Token | undefined): t is Token => t !== undefined && (t.type === "word" || t.type === "quoted");
const isPunct = (t: Token | undefined, value: string): boolean => t?.type === "punct" && t.value === value;

/** A possibly schema-qualified name starting at `k`, and the index just past it. */
function readName(tokens: Token[], k: number, defaultSchema: string): { name: string; next: number } | undefined {
  const first = tokens[k];
  if (!isName(first)) {
    return undefined;
  }
  if (isPunct(tokens[k + 1], ".") && isName(tokens[k + 2])) {
    return { name: `${first.value}.${(tokens[k + 2] as Token).value}`, next: k + 3 };
  }
  return { name: `${defaultSchema}.${first.value}`, next: k + 1 };
}

/** Skip `if exists`, `if not exists`, `only`, `concurrently` — whichever sit at `k`. */
function skipNoise(tokens: Token[], k: number): number {
  let i = k;
  for (;;) {
    const w = tokens[i]?.type === "word" ? tokens[i]?.value : undefined;
    if (w === "if" && tokens[i + 1]?.value === "not" && tokens[i + 2]?.value === "exists") {
      i += 3;
    } else if (w === "if" && tokens[i + 1]?.value === "exists") {
      i += 2;
    } else if (w === "only" || w === "concurrently") {
      i += 1;
    } else {
      return i;
    }
  }
}

/** Split tokens into depth-0, comma-separated parts (ALTER TABLE actions, DROP name lists). */
function splitTopLevel(tokens: Token[]): Token[][] {
  const parts: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (isPunct(token, "(")) {
      depth += 1;
    } else if (isPunct(token, ")")) {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && isPunct(token, ",")) {
      parts.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}

const words = (tokens: Token[]): string[] => topLevelWords(tokens).map((t) => t.word);

// ── the lint ─────────────────────────────────────────────────────────────────

export function lintDdl(statements: readonly DdlStatement[], context: LintContext = {}): LintResult {
  const defaultSchema = context.defaultSchema ?? "public";
  const createdInPlan = context.createdInPlan ?? new Set<string>();
  const findings: RiskFinding[] = [];

  const exists = (table: string): boolean =>
    !createdInPlan.has(table) && (context.existingTables === undefined || context.existingTables.has(table));
  const add = (statement: DdlStatement, level: RiskLevel, code: string, message: string, target?: string): void => {
    findings.push({ code, level, statementIndex: statement.index, target, message });
  };

  for (const statement of statements) {
    const { tokens, verb, kind } = statement;
    const top = words(tokens);
    const has = (w: string): boolean => top.includes(w);

    // ── CREATE ──
    if (verb === "create") {
      if (kind === "table") {
        const tableWord = topLevelWords(tokens).find((t) => t.word === "table");
        const name = tableWord === undefined ? undefined : readName(tokens, skipNoise(tokens, tableWord.at + 1), defaultSchema);
        if (name !== undefined) {
          createdInPlan.add(name.name);
        }
      }
      if (kind === "extension") {
        add(statement, "high", "CREATE_EXTENSION", "CREATE EXTENSION installs objects the migration does not own, and dropping it later takes them all with it.");
      }
      if (kind === "index") {
        const onAt = topLevelWords(tokens).find((t) => t.word === "on");
        const table = onAt === undefined ? undefined : readName(tokens, skipNoise(tokens, onAt.at + 1), defaultSchema)?.name;
        if (table !== undefined && !has("concurrently") && exists(table)) {
          const rows = context.rowEstimate?.(table);
          const large = rows !== undefined && rows >= LARGE_TABLE_ROWS;
          add(
            statement,
            large ? "high" : "warning",
            "CREATE_INDEX_NON_CONCURRENT",
            `CREATE INDEX without CONCURRENTLY blocks writes to ${table} for the whole build${rows === undefined ? "" : ` (~${String(Math.round(rows))} rows)`}. Use CREATE INDEX CONCURRENTLY in its own -- mcp:no-transaction migration.`,
            table
          );
        }
      }
    }

    // SECURITY DEFINER can appear on CREATE or ALTER FUNCTION / PROCEDURE.
    if ((kind === "function" || kind === "procedure") && top.some((w, i) => w === "security" && top[i + 1] === "definer")) {
      add(statement, "high", "SECURITY_DEFINER", "SECURITY DEFINER runs the routine with its owner's privileges. Pin search_path in the definition (SET search_path = …).");
    }

    // ── DROP ──
    if (verb === "drop") {
      const cascade = has("cascade");
      if (kind === "schema" && cascade) {
        add(statement, "blocked", "DROP_SCHEMA_CASCADE", "DROP SCHEMA … CASCADE drops every object in the schema, whatever created it. Drop the objects explicitly.");
      } else if (cascade) {
        add(statement, "high", "DROP_CASCADE", "CASCADE also drops every object that depends on this one — views, foreign keys, triggers — and the migration does not list them.");
      }

      const kindWords = kind === "materialized view" ? 2 : 1;
      const names = splitTopLevel(tokens.slice(skipNoise(tokens, 1 + kindWords)))
        .map((part) => readName(part, 0, defaultSchema)?.name)
        .filter((n): n is string => n !== undefined);

      const hasIfExists = top.includes("if") && top.includes("exists");
      if (!hasIfExists) {
        add(statement, "info", "MISSING_IF_EXISTS", "DROP without IF EXISTS fails if the object is already gone, which makes a rerun of the migration fail.");
      }

      switch (kind) {
        case "table":
          if (names.length === 0 || names.some(exists)) {
            add(statement, "high", "DROP_TABLE", "DROP TABLE deletes the table and all of its data. The down migration cannot bring the rows back.", names.join(", ") || undefined);
          }
          break;
        case "type":
          add(statement, "high", "DROP_TYPE", "DROP TYPE fails, or with CASCADE drops the columns that use the type.");
          break;
        case "sequence":
          add(statement, "high", "DROP_SEQUENCE", "DROP SEQUENCE breaks every DEFAULT nextval() that still points at it.");
          break;
        case "schema":
          add(statement, "high", "DROP_SCHEMA", "DROP SCHEMA removes a namespace other code may still resolve names in.");
          break;
        case "view":
        case "materialized view":
          add(statement, "warning", "DROP_VIEW", "Queries and application code that read this view will fail.");
          break;
        case "function":
        case "procedure":
          add(statement, "warning", "DROP_FUNCTION", "Triggers, defaults and application code that call this routine will fail.");
          break;
        default:
          break;
      }
    }

    // ── ALTER TABLE ──
    if (verb === "alter" && kind === "table") {
      lintAlterTable(statement, defaultSchema, exists, add);
    }

    // ── ALTER TYPE … ADD VALUE ──
    if (verb === "alter" && kind === "type" && top.some((w, i) => w === "add" && top[i + 1] === "value")) {
      add(statement, "info", "ALTER_TYPE_ADD_VALUE", "The new enum value cannot be used until this migration's transaction commits.");
    }
  }

  const requiredAcknowledgements = [...new Set(findings.filter((f) => f.level === "high").map((f) => f.code))];
  return { findings, requiredAcknowledgements, blocked: findings.filter((f) => f.level === "blocked") };
}

function lintAlterTable(
  statement: DdlStatement,
  defaultSchema: string,
  exists: (table: string) => boolean,
  add: (statement: DdlStatement, level: RiskLevel, code: string, message: string, target?: string) => void
): void {
  const { tokens } = statement;
  // `alter table all in tablespace …` moves every table in a tablespace.
  if (tokens[2]?.value === "all" && tokens[3]?.value === "in") {
    add(statement, "high", "SET_TABLESPACE", "Moving tables between tablespaces rewrites them under an ACCESS EXCLUSIVE lock.");
    return;
  }
  const name = readName(tokens, skipNoise(tokens, 2), defaultSchema);
  if (name === undefined) {
    return;
  }
  const table = name.name;
  const existing = exists(table);
  let rest = tokens.slice(name.next);
  if (isPunct(rest[0], "*")) {
    rest = rest.slice(1);
  }

  for (const action of splitTopLevel(rest)) {
    const w = words(action);
    const first = w[0];

    if (first === "rename") {
      if (w[1] === "to") {
        add(statement, "high", "RENAME_TABLE", `Renaming ${table} breaks every query and ORM mapping that still uses the old name.`, table);
      } else if (w[1] !== "constraint") {
        add(statement, "high", "RENAME_COLUMN", `Renaming a column of ${table} breaks every query and ORM mapping that still uses the old name.`, table);
      }
      continue;
    }

    if (first === "set" && (w[1] === "logged" || w[1] === "unlogged")) {
      add(statement, "high", "SET_LOGGED_UNLOGGED", `SET ${w[1].toUpperCase()} rewrites ${table} under an ACCESS EXCLUSIVE lock.`, table);
      continue;
    }
    if (first === "set" && w[1] === "tablespace") {
      add(statement, "high", "SET_TABLESPACE", `SET TABLESPACE rewrites ${table} under an ACCESS EXCLUSIVE lock.`, table);
      continue;
    }

    if (first === "detach" && w[1] === "partition" && !w.includes("concurrently")) {
      add(statement, "warning", "DETACH_PARTITION_BLOCKING", "DETACH PARTITION without CONCURRENTLY locks the parent table. PG14+ supports DETACH … CONCURRENTLY in its own no-transaction migration.", table);
      continue;
    }

    // Everything below only matters for a table that already holds data.
    if (!existing) {
      continue;
    }

    if (first === "drop") {
      const what = w[1];
      if (what !== "constraint" && what !== "default" && what !== "not" && what !== "identity" && what !== "expression") {
        add(statement, "high", "DROP_COLUMN", `Dropping a column of ${table} deletes its data. The down migration cannot bring the values back.`, table);
      }
      continue;
    }

    if (first === "alter") {
      // ALTER [COLUMN] name <subcommand>. Read the subcommand by position, after the column
      // name, so a column that is itself called `type` does not read as a type change.
      let k = 1;
      if (action[k]?.type === "word" && action[k]?.value === "column") {
        k += 1;
      }
      k += 1;
      const sub = action.slice(k).filter((t) => t.type === "word").map((t) => t.value);
      const typeChange = sub[0] === "type" || (sub[0] === "set" && sub[1] === "data" && sub[2] === "type");
      if (typeChange) {
        add(statement, "high", "ALTER_COLUMN_TYPE", `Changing a column type on ${table} usually rewrites the table under an ACCESS EXCLUSIVE lock.`, table);
      } else if (sub[0] === "set" && sub[1] === "not" && sub[2] === "null") {
        add(statement, "high", "SET_NOT_NULL", `SET NOT NULL scans all of ${table} under an ACCESS EXCLUSIVE lock. Add CHECK (col IS NOT NULL) NOT VALID, VALIDATE it in a later migration, then SET NOT NULL.`, table);
      }
      continue;
    }

    if (first === "add") {
      const constraintWords = ["constraint", "primary", "unique", "check", "foreign", "exclude"];
      if (constraintWords.includes(w[1] ?? "")) {
        const validating = (w.includes("foreign") || w.includes("check")) && !(w.includes("not") && w.includes("valid"));
        if (validating) {
          add(statement, "warning", "ADD_CONSTRAINT_VALIDATING", `This constraint is checked against every row of ${table} while holding a lock. Add it NOT VALID, then VALIDATE CONSTRAINT in a later migration.`, table);
        }
        continue;
      }
      // ADD [COLUMN] …
      const defaultAt = action.findIndex((t) => t.type === "word" && t.value === "default");
      if (defaultAt >= 0) {
        const volatile = action.slice(defaultAt + 1).some((t, i, arr) => t.type === "word" && VOLATILE_FUNCTIONS.has(t.value) && isPunct(arr[i + 1], "("));
        if (volatile) {
          add(statement, "high", "ADD_COLUMN_VOLATILE_DEFAULT", `A volatile DEFAULT makes ADD COLUMN rewrite all of ${table}. Add the column without it, backfill, then SET DEFAULT.`, table);
        }
      }
      if (w.includes("generated") && w.includes("stored")) {
        add(statement, "high", "ADD_COLUMN_STORED_GENERATED", `A STORED generated column is computed for every existing row, rewriting ${table}.`, table);
      }
      const notNull = w.some((x, i) => x === "not" && w[i + 1] === "null");
      if (notNull && defaultAt < 0) {
        add(statement, "warning", "ADD_COLUMN_NOT_NULL_NO_DEFAULT", `ADD COLUMN … NOT NULL with no DEFAULT fails if ${table} has any rows.`, table);
      }
    }
  }
}
