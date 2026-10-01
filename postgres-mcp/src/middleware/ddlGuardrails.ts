/**
 * The DDL lane's guardrail: what a migration script may contain, and how it splits into
 * statements.
 *
 * An ALLOWLIST, where the read and write guardrails use a leading-keyword check. A migration is
 * many statements of many shapes, so "starts with CREATE" is not enough: `create role`,
 * `create table … as select` and a `create schema` carrying a GRANT all start that way.
 *
 * ## Why this has its own tokenizer
 *
 * `@mcp/shared`'s `scanSql` is right for the read and write lanes and wrong for this one. It
 * differs from Postgres's own lexer in three places, and here each difference matters:
 *
 *  - It blanks double-quoted identifiers, so `"mcp_ops".t` is invisible to the reserved-schema
 *    check.
 *  - It ends a block comment at the first `*\/`. Postgres nests them.
 *  - It opens a dollar quote at any `$tag$`, including one that continues an identifier.
 *    Postgres reads `foo$x$` as ONE identifier (identifiers may contain `$`), so in
 *    `create table foo$x$ (a int); drop table y; $x$` the scanner blanks the `drop` that
 *    Postgres would run.
 *
 * The tokenizer below follows the Postgres rules for all three. Where it still cannot match the
 * server exactly (`U&` literals, `BEGIN ATOMIC` bodies) it refuses the script. It does not guess.
 *
 * It also assumes `standard_conforming_strings = on`, the default since PG 9.1. On a server with
 * that setting off, a backslash would escape a quote, and this tokenizer would then see a string
 * end EARLIER than Postgres does. That means more statement boundaries than the server sees,
 * never fewer, so the worst case is a syntax error, never a hidden statement.
 *
 * Policy (the allowlist, reserved schemas, what needs a non-transactional run) is Postgres-only and
 * stays in this file, as ADR 0002 requires. The tokenizer is mechanism, and it can move to
 * `@mcp/shared` if a second consumer ever appears.
 */

import { isInternalSchema } from "./internalSchemas.js";

// ── limits ───────────────────────────────────────────────────────────────────

/** Per script, file or inline. Matches the DDL lane's input cap. */
export const MAX_DDL_SCRIPT_BYTES = 262_144;
export const MAX_DDL_STATEMENTS = 200;
/** Upper bound for a timeout directive's value; the lane applies its own, tighter caps. */
const MAX_DIRECTIVE_MS = 86_400_000;

// ── result shape ─────────────────────────────────────────────────────────────

export interface DdlError {
  code: string;
  message: string;
}

export type DdlResult<T> = ({ ok: true } & T) | { ok: false; error: DdlError };

function fail(code: string, message: string): { ok: false; error: DdlError } {
  return { ok: false, error: { code, message } };
}

// ── tokenizer ────────────────────────────────────────────────────────────────

export type TokenType = "word" | "quoted" | "string" | "number" | "punct";

export interface Token {
  type: TokenType;
  /**
   * `word`: the identifier or keyword, folded to lower case as Postgres folds unquoted names.
   * `quoted`: the identifier verbatim, with `""` unescaped. `string`: the literal's content.
   * `number` / `punct`: the source text.
   */
  value: string;
  start: number;
  end: number;
}

interface LineComment {
  text: string;
  start: number;
}

const IDENT_START = /[A-Za-z_\u0080-￿]/;
const IDENT_PART = /[A-Za-z0-9_$\u0080-￿]/;
/** A dollar-quote tag: like an identifier, but without `$`. */
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

function tokenize(sql: string): DdlResult<{ tokens: Token[]; lineComments: LineComment[] }> {
  const tokens: Token[] = [];
  const lineComments: LineComment[] = [];
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i] as string;
    const next = sql[i + 1] ?? "";

    if (/\s/.test(c)) {
      i += 1;
      continue;
    }

    if (c === "-" && next === "-") {
      const eol = sql.indexOf("\n", i);
      const end = eol === -1 ? n : eol;
      lineComments.push({ text: sql.slice(i + 2, end).trim(), start: i });
      i = end;
      continue;
    }

    // Block comments NEST in Postgres: `/* a /* b */ still comment */`.
    if (c === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth += 1;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      if (depth > 0) {
        return fail("DDL_UNTERMINATED_SQL", "A block comment is never closed.");
      }
      i = j;
      continue;
    }

    // Reached only at a token boundary. A `$` that continues an identifier was already
    // consumed by the word branch below, which is the Postgres rule.
    if (c === "$") {
      const tag = DOLLAR_TAG.exec(sql.slice(i))?.[0];
      if (tag !== undefined) {
        const close = sql.indexOf(tag, i + tag.length);
        if (close === -1) {
          return fail("DDL_UNTERMINATED_SQL", `A dollar-quoted string opened with ${tag} is never closed.`);
        }
        tokens.push({ type: "string", value: sql.slice(i + tag.length, close), start: i, end: close + tag.length });
        i = close + tag.length;
        continue;
      }
      tokens.push({ type: "punct", value: "$", start: i, end: i + 1 });
      i += 1;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      let value = "";
      let closed = false;
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') {
          value += '"';
          j += 2;
        } else if (sql[j] === '"') {
          closed = true;
          j += 1;
          break;
        } else {
          value += sql[j];
          j += 1;
        }
      }
      if (!closed) {
        return fail("DDL_UNTERMINATED_SQL", "A double-quoted identifier is never closed.");
      }
      tokens.push({ type: "quoted", value, start: i, end: j });
      i = j;
      continue;
    }

    if (c === "'") {
      const read = readString(sql, i, false);
      if (read === null) {
        return fail("DDL_UNTERMINATED_SQL", "A string literal is never closed.");
      }
      tokens.push({ type: "string", value: read.value, start: i, end: read.end });
      i = read.end;
      continue;
    }

    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(sql[j] as string)) {
        j += 1;
      }
      const word = sql.slice(i, j).toLowerCase();
      // `E'…'` is an escape string ONLY as a standalone E; `abcE'…'` is an identifier and
      // then an ordinary string. Greedy word matching gets that right on its own.
      if (word === "e" && sql[j] === "'") {
        const read = readString(sql, j, true);
        if (read === null) {
          return fail("DDL_UNTERMINATED_SQL", "An escape string literal is never closed.");
        }
        tokens.push({ type: "string", value: read.value, start: i, end: read.end });
        i = read.end;
        continue;
      }
      // U&'…' / U&"…" carry their own escape syntax (`\0041`, UESCAPE), which could spell
      // `mcp_ops` without the letters appearing. Not decoded, so not accepted.
      if (word === "u" && sql[j] === "&") {
        return fail(
          "DDL_UNSUPPORTED_SYNTAX",
          "Unicode-escaped literals and identifiers (U&'…', U&\"…\") are not accepted in migrations. Write the characters directly."
        );
      }
      tokens.push({ type: "word", value: word, start: i, end: j });
      i = j;
      continue;
    }

    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9._]/.test(sql[j] as string)) {
        j += 1;
      }
      tokens.push({ type: "number", value: sql.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }

    tokens.push({ type: "punct", value: c, start: i, end: i + 1 });
    i += 1;
  }

  return { ok: true, tokens, lineComments };
}

/** A quoted string from the opening `'` at `open`. `escapes`: backslash escapes too (E'…'). */
function readString(sql: string, open: number, escapes: boolean): { value: string; end: number } | null {
  let j = open + 1;
  let value = "";
  while (j < sql.length) {
    const ch = sql[j] as string;
    if (escapes && ch === "\\" && j + 1 < sql.length) {
      value += sql[j + 1];
      j += 2;
    } else if (ch === "'" && sql[j + 1] === "'") {
      value += "'";
      j += 2;
    } else if (ch === "'") {
      return { value, end: j + 1 };
    } else {
      value += ch;
      j += 1;
    }
  }
  return null;
}

// ── directives ───────────────────────────────────────────────────────────────

export interface DdlDirectives {
  noTransaction: boolean;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
}

/**
 * `-- mcp:` comment lines ahead of the first statement.
 *
 * An unknown directive is an error, not a no-op: a typo in `-- mcp:no-transacton` must not
 * silently run a `CREATE INDEX CONCURRENTLY` inside a transaction. A directive AFTER the first
 * statement is an error for the same reason. It looks as if it applies and does not.
 */
function readDirectives(lineComments: LineComment[], firstTokenStart: number): DdlResult<{ directives: DdlDirectives }> {
  const directives: DdlDirectives = { noTransaction: false };
  for (const comment of lineComments) {
    const match = /^mcp:(\S*)$/.exec(comment.text);
    if (!/^mcp:/.test(comment.text)) {
      continue;
    }
    if (comment.start > firstTokenStart) {
      return fail(
        "DDL_MISPLACED_DIRECTIVE",
        `'-- ${comment.text}' comes after the first statement. Directives apply to the whole migration and must be at the top.`
      );
    }
    const body = match?.[1] ?? "";
    if (body === "no-transaction") {
      directives.noTransaction = true;
      continue;
    }
    const timeout = /^(lock-timeout-ms|statement-timeout-ms)=(\d+)$/.exec(body);
    if (timeout) {
      const value = Number(timeout[2]);
      if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_DIRECTIVE_MS) {
        return fail("DDL_INVALID_DIRECTIVE", `'-- ${comment.text}' needs a whole number of milliseconds between 1 and ${String(MAX_DIRECTIVE_MS)}.`);
      }
      if (timeout[1] === "lock-timeout-ms") {
        directives.lockTimeoutMs = value;
      } else {
        directives.statementTimeoutMs = value;
      }
      continue;
    }
    return fail(
      "DDL_UNKNOWN_DIRECTIVE",
      `Unknown directive '-- ${comment.text}'. Known: mcp:no-transaction, mcp:lock-timeout-ms=N, mcp:statement-timeout-ms=N.`
    );
  }
  return { ok: true, directives };
}

// ── classification ───────────────────────────────────────────────────────────

export type DdlVerb = "create" | "alter" | "drop" | "comment";

export type DdlObjectKind =
  | "table"
  | "index"
  | "view"
  | "materialized view"
  | "sequence"
  | "type"
  | "domain"
  | "schema"
  | "function"
  | "procedure"
  | "trigger"
  | "extension"
  | "comment";

export interface DdlStatement {
  index: number;
  /** The statement as written, without its terminating `;`. */
  text: string;
  verb: DdlVerb;
  kind: DdlObjectKind;
  /** Postgres refuses to run it inside a transaction block (the CONCURRENTLY forms). */
  needsNoTransaction: boolean;
  tokens: Token[];
}

const KINDS_BY_VERB: Record<"create" | "alter" | "drop", readonly DdlObjectKind[]> = {
  create: ["table", "index", "view", "materialized view", "sequence", "type", "domain", "schema", "function", "procedure", "trigger", "extension"],
  alter: ["table", "index", "view", "materialized view", "sequence", "type", "domain", "schema", "function", "procedure", "trigger"],
  drop: ["table", "index", "view", "materialized view", "sequence", "type", "domain", "schema", "function", "procedure", "trigger"]
};

/** Verbs that are refused outright, grouped by the reason a migration may not use them. */
const REFUSED_VERBS: ReadonlyArray<{ verbs: readonly string[]; reason: string }> = [
  {
    verbs: ["insert", "update", "delete", "merge", "truncate", "copy", "with", "select", "values", "table"],
    reason:
      "Data changes go through write_preview, which previews row counts and can roll back. The usual shape: add the column nullable (ddl), backfill it (write_preview), then SET NOT NULL (ddl)."
  },
  {
    verbs: ["do", "call", "execute", "prepare", "load", "import"],
    reason: "It runs code the guardrail cannot see into. For conditional DDL use IF [NOT] EXISTS."
  },
  {
    verbs: ["grant", "revoke", "reassign", "security"],
    reason: "Privilege and ownership management is outside the migration lane."
  },
  {
    verbs: ["set", "reset", "begin", "start", "commit", "end", "rollback", "abort", "savepoint", "release", "discard", "lock"],
    reason:
      "The server owns transaction control, locks and timeouts. Use the -- mcp:no-transaction / -- mcp:lock-timeout-ms / -- mcp:statement-timeout-ms directives."
  },
  {
    verbs: ["vacuum", "analyze", "analyse", "reindex", "cluster", "refresh", "checkpoint", "listen", "notify", "unlisten", "explain"],
    reason: "Operational and maintenance commands are not schema migrations."
  }
];

function refusedVerbReason(verb: string): string | undefined {
  return REFUSED_VERBS.find((group) => group.verbs.includes(verb))?.reason;
}

const wordAt = (tokens: Token[], k: number): string | undefined =>
  tokens[k]?.type === "word" ? tokens[k].value : undefined;

/** Words at parenthesis depth 0, with their positions in `tokens`. */
export function topLevelWords(tokens: Token[]): Array<{ word: string; at: number }> {
  const out: Array<{ word: string; at: number }> = [];
  let depth = 0;
  tokens.forEach((token, at) => {
    if (token.type === "punct" && token.value === "(") {
      depth += 1;
    } else if (token.type === "punct" && token.value === ")") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && token.type === "word") {
      out.push({ word: token.value, at });
    }
  });
  return out;
}

function hasTopLevelSequence(tokens: Token[], words: readonly string[]): boolean {
  const top = topLevelWords(tokens);
  return top.some((_, k) => words.every((w, offset) => top[k + offset]?.word === w && top[k + offset].at === top[k].at + offset));
}

function classify(tokens: Token[], index: number): DdlResult<{ verb: DdlVerb; kind: DdlObjectKind }> {
  const where = `Statement ${String(index + 1)}`;
  const first = tokens[0];
  if (first?.type !== "word") {
    return fail("DDL_STATEMENT_NOT_ALLOWED", `${where} does not start with a keyword.`);
  }
  const verb = first.value;

  if (verb === "comment") {
    return wordAt(tokens, 1) === "on"
      ? { ok: true, verb: "comment", kind: "comment" }
      : fail("DDL_STATEMENT_NOT_ALLOWED", `${where}: expected COMMENT ON.`);
  }

  if (verb !== "create" && verb !== "alter" && verb !== "drop") {
    const reason = refusedVerbReason(verb);
    return fail(
      "DDL_STATEMENT_NOT_ALLOWED",
      `${where}: ${verb.toUpperCase()} is not allowed in a migration.${reason === undefined ? " Only CREATE, ALTER, DROP and COMMENT ON are." : ` ${reason}`}`
    );
  }

  let k = 1;
  if (verb === "create") {
    // Modifiers that may sit between CREATE and the object kind.
    for (;;) {
      const w = wordAt(tokens, k);
      if (w === "or" && wordAt(tokens, k + 1) === "replace") {
        k += 2;
      } else if (w === "unique" || w === "unlogged" || w === "recursive" || w === "constraint") {
        k += 1;
      } else if (w === "temporary" || w === "temp" || w === "global" || w === "local") {
        return fail("DDL_STATEMENT_NOT_ALLOWED", `${where}: temporary objects do not outlive the migration's session.`);
      } else {
        break;
      }
    }
  }

  let kindWord = wordAt(tokens, k);
  if (kindWord === "materialized" && wordAt(tokens, k + 1) === "view") {
    kindWord = "materialized view";
  }
  const allowed = KINDS_BY_VERB[verb];
  if (kindWord === undefined || !(allowed as readonly string[]).includes(kindWord)) {
    const extra =
      kindWord === "extension"
        ? " Upgrading or dropping an extension changes objects the migration never created."
        : kindWord === "role" || kindWord === "user" || kindWord === "group" || kindWord === "default"
          ? " Privilege management is outside the migration lane."
          : "";
    return fail(
      "DDL_STATEMENT_NOT_ALLOWED",
      `${where}: ${verb.toUpperCase()} ${(kindWord ?? "").toUpperCase()} is not allowed in a migration.${extra} Allowed: ${allowed.map((x) => x.toUpperCase()).join(", ")}.`
    );
  }
  return { ok: true, verb, kind: kindWord as DdlObjectKind };
}

/** Checks that depend on the statement's shape beyond its first words. */
function checkShape(tokens: Token[], verb: DdlVerb, kind: DdlObjectKind, index: number): DdlError | undefined {
  const where = `Statement ${String(index + 1)}`;
  const top = topLevelWords(tokens);

  if (hasTopLevelSequence(tokens, ["owner", "to"])) {
    return { code: "DDL_STATEMENT_NOT_ALLOWED", message: `${where}: OWNER TO is ownership management, outside the migration lane.` };
  }

  if (verb === "create" && kind === "table" && top.some((t) => t.word === "as")) {
    return {
      code: "DDL_STATEMENT_NOT_ALLOWED",
      message: `${where}: CREATE TABLE … AS writes data. Create the table, then fill it with write_preview.`
    };
  }

  if (verb === "create" && kind === "schema") {
    // Exactly `create schema [if not exists] name`. The long form can embed further
    // statements — CREATE TABLE, CREATE VIEW, and GRANT — as schema elements.
    let k = 2;
    if (wordAt(tokens, k) === "if" && wordAt(tokens, k + 1) === "not" && wordAt(tokens, k + 2) === "exists") {
      k += 3;
    }
    const rest = tokens.slice(k);
    const nameOnly = rest.length === 1 && (rest[0]?.type === "word" || rest[0]?.type === "quoted");
    if (!nameOnly) {
      return {
        code: "DDL_STATEMENT_NOT_ALLOWED",
        message: `${where}: only CREATE SCHEMA [IF NOT EXISTS] name is allowed — no AUTHORIZATION, and no embedded schema elements (they can carry GRANT).`
      };
    }
  }

  if ((kind === "function" || kind === "procedure") && verb === "create") {
    const at = top.findIndex((t) => t.word === "language");
    if (at >= 0) {
      const langToken = tokens[top[at].at + 1];
      const lang = langToken === undefined ? "" : langToken.value.toLowerCase();
      if (lang !== "sql" && lang !== "plpgsql") {
        return {
          code: "DDL_STATEMENT_NOT_ALLOWED",
          message: `${where}: LANGUAGE ${lang || "?"} is not allowed. Only sql and plpgsql bodies are accepted.`
        };
      }
    }
  }

  return undefined;
}

function needsNoTransaction(tokens: Token[], verb: DdlVerb, kind: DdlObjectKind): boolean {
  const top = topLevelWords(tokens);
  const has = (w: string): boolean => top.some((t) => t.word === w);
  if (kind === "index" && (verb === "create" || verb === "drop")) {
    return has("concurrently");
  }
  // ALTER TABLE … DETACH PARTITION … CONCURRENTLY (PG14+).
  return verb === "alter" && kind === "table" && has("detach") && has("concurrently");
}

// ── splitting ────────────────────────────────────────────────────────────────

/**
 * Split tokens on `;`. The tokenizer has already consumed every `;` inside a literal or comment,
 * so what is left is a real boundary — except inside a `BEGIN ATOMIC` body, whose `;` cannot be
 * told from a statement end without a real parser. A dollar-quoted body says the same thing and
 * splits cleanly, so that form is refused.
 */
function splitTokens(tokens: Token[]): DdlResult<{ groups: Token[][] }> {
  for (let k = 0; k + 1 < tokens.length; k += 1) {
    if (wordAt(tokens, k) === "begin" && wordAt(tokens, k + 1) === "atomic") {
      return fail("DDL_UNSUPPORTED_SYNTAX", "BEGIN ATOMIC function bodies are not accepted. Use a dollar-quoted body: AS $$ … $$.");
    }
  }
  const groups: Token[][] = [];
  let current: Token[] = [];
  for (const token of tokens) {
    if (token.type === "punct" && token.value === ";") {
      if (current.length > 0) {
        groups.push(current);
      }
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return { ok: true, groups };
}

export interface SplitStatement {
  index: number;
  text: string;
  tokens: Token[];
}

/**
 * Split any Postgres script into statements, with the same tokenizer and the same refusals as
 * `validateDdlScript`, but WITHOUT its allowlist, directives or size caps.
 *
 * For callers that must run a script statement by statement and decide per statement what to do,
 * where the allowlist would be wrong: the EF Core lane's dry run runs EF-generated scripts, and
 * those legitimately contain `INSERT INTO "__EFMigrationsHistory"` and `DO $EF$` blocks.
 */
export function splitSqlStatements(sql: string): DdlResult<{ statements: SplitStatement[] }> {
  const lexed = tokenize(sql);
  if (!lexed.ok) {
    return lexed;
  }
  const split = splitTokens(lexed.tokens);
  if (!split.ok) {
    return split;
  }
  return {
    ok: true,
    statements: split.groups.map((group, index) => ({
      index,
      text: sql.slice((group[0] as Token).start, (group[group.length - 1] as Token).end),
      tokens: group
    }))
  };
}

// ── the entry point ──────────────────────────────────────────────────────────

export type DdlExecutionMode = "transactional" | "non_transactional";

export interface ValidatedDdl {
  statements: DdlStatement[];
  directives: DdlDirectives;
  mode: DdlExecutionMode;
  warnings: string[];
}

/**
 * Validate one migration script (a file's text or an inline `sql` argument).
 *
 * `options.noTransaction` is the inline form of the `-- mcp:no-transaction` directive. Either one
 * turns non-transactional mode on.
 */
export function validateDdlScript(sql: string, options: { noTransaction?: boolean } = {}): DdlResult<ValidatedDdl> {
  if (Buffer.byteLength(sql, "utf8") > MAX_DDL_SCRIPT_BYTES) {
    return fail("DDL_TOO_LARGE", `A migration may be at most ${String(MAX_DDL_SCRIPT_BYTES)} bytes.`);
  }

  const lexed = tokenize(sql);
  if (!lexed.ok) {
    return lexed;
  }
  const { tokens, lineComments } = lexed;
  if (tokens.length === 0) {
    return fail("DDL_EMPTY", "The migration contains no statements.");
  }

  const read = readDirectives(lineComments, tokens[0]?.start ?? 0);
  if (!read.ok) {
    return read;
  }
  const directives: DdlDirectives = { ...read.directives, noTransaction: read.directives.noTransaction || options.noTransaction === true };

  const split = splitTokens(tokens);
  if (!split.ok) {
    return split;
  }
  const { groups } = split;
  if (groups.length > MAX_DDL_STATEMENTS) {
    return fail("DDL_TOO_MANY_STATEMENTS", `A migration may hold at most ${String(MAX_DDL_STATEMENTS)} statements; this one has ${String(groups.length)}. Split it.`);
  }

  const statements: DdlStatement[] = [];
  for (const [index, group] of groups.entries()) {
    // The reserved-schema check reads identifiers, quoted or not — anywhere in the statement,
    // not just in the target position. Referring to the server's schema at all is refused:
    // there is no migration that legitimately needs to.
    const reserved = group.find((t) => (t.type === "word" || t.type === "quoted") && isInternalSchema(t.value));
    if (reserved !== undefined) {
      return fail(
        "DDL_RESERVED_SCHEMA",
        `Statement ${String(index + 1)} refers to '${reserved.value}', which is owned by this server (audit log, migration history).`
      );
    }

    const classified = classify(group, index);
    if (!classified.ok) {
      return classified;
    }
    const shapeError = checkShape(group, classified.verb, classified.kind, index);
    if (shapeError !== undefined) {
      return { ok: false, error: shapeError };
    }
    const first = group[0] as Token;
    const last = group[group.length - 1] as Token;
    statements.push({
      index,
      text: sql.slice(first.start, last.end),
      verb: classified.verb,
      kind: classified.kind,
      needsNoTransaction: needsNoTransaction(group, classified.verb, classified.kind),
      tokens: group
    });
  }

  const warnings: string[] = [];
  const needing = statements.filter((s) => s.needsNoTransaction);
  if (needing.length > 0 && !directives.noTransaction) {
    return fail(
      "DDL_NEEDS_NO_TRANSACTION",
      `Statement ${String((needing[0] as DdlStatement).index + 1)} uses CONCURRENTLY, which Postgres refuses inside a transaction. Mark the migration with -- mcp:no-transaction (or noTransaction: true) and keep that statement on its own.`
    );
  }
  if (directives.noTransaction && statements.length > 1) {
    // One statement means a failure cannot leave the migration half-applied, so there is no
    // "dirty" state to recover from.
    return fail(
      "DDL_NO_TRANSACTION_MULTI_STATEMENT",
      `A non-transactional migration must be exactly one statement; this one has ${String(statements.length)}. Split it into separate migrations.`
    );
  }
  if (directives.noTransaction && needing.length === 0) {
    warnings.push("Marked no-transaction, but nothing in it requires that. It will run without a transaction's protection.");
  }

  return {
    ok: true,
    statements,
    directives,
    mode: directives.noTransaction ? "non_transactional" : "transactional",
    warnings
  };
}
