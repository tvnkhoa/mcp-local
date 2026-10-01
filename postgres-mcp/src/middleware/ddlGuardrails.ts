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

/**
 * A psql backslash meta-command, from its `\` to the end of the line, as psql reads it. Only
 * collected in psql mode; elsewhere a backslash is an ordinary punctuation token, which no
 * statement can start with.
 */
interface MetaCommand {
  text: string;
  start: number;
  /** A token came after the last `;`, so psql would run this in the middle of a statement. */
  midStatement: boolean;
}

const IDENT_START = /[A-Za-z_\u0080-￿]/;
const IDENT_PART = /[A-Za-z0-9_$\u0080-￿]/;
/** A dollar-quote tag: like an identifier, but without `$`. */
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

function tokenize(sql: string, psql = false): DdlResult<{ tokens: Token[]; lineComments: LineComment[]; metaCommands: MetaCommand[] }> {
  const tokens: Token[] = [];
  const lineComments: LineComment[] = [];
  const metaCommands: MetaCommand[] = [];
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i] as string;
    const next = sql[i + 1] ?? "";

    if (/\s/.test(c)) {
      i += 1;
      continue;
    }

    // psql reads a backslash outside a literal or comment as a meta-command that runs to the end
    // of the line, wherever on the line it sits. Only reached at a token boundary, so a backslash
    // inside a string, a quoted identifier or a dollar-quoted body never gets here.
    if (psql && c === "\\") {
      const eol = sql.indexOf("\n", i);
      const end = eol === -1 ? n : eol;
      const last = tokens[tokens.length - 1];
      const midStatement = last !== undefined && !(last.type === "punct" && last.value === ";");
      metaCommands.push({ text: sql.slice(i, end).trim(), start: i, midStatement });
      i = end;
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

  return { ok: true, tokens, lineComments, metaCommands };
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

export type DdlVerb = "create" | "alter" | "drop" | "comment" | "grant" | "revoke";

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
  | "policy"
  | "comment"
  /** GRANT / REVOKE of privileges ON an object. Role membership is refused. */
  | "privilege";

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
  create: ["table", "index", "view", "materialized view", "sequence", "type", "domain", "schema", "function", "procedure", "trigger", "extension", "policy"],
  alter: ["table", "index", "view", "materialized view", "sequence", "type", "domain", "schema", "function", "procedure", "trigger", "policy"],
  drop: ["table", "index", "view", "materialized view", "sequence", "type", "domain", "schema", "function", "procedure", "trigger", "policy"]
};

/** What `ALTER … OWNER TO` may be applied to. Ownership of anything else stays out of the lane. */
const OWNER_KINDS: readonly DdlObjectKind[] = ["table", "view", "materialized view", "sequence", "type", "domain", "schema", "function", "procedure"];

/**
 * Object classes a GRANT / REVOKE may NOT name after ON, each with a reason. What is left is
 * TABLE, SEQUENCE, FUNCTION, PROCEDURE, ROUTINE and SCHEMA, or no class word, which is a table. `all` is `ALL TABLES IN SCHEMA`, which
 * reaches objects the migration never names; `parameter` grants SET / ALTER SYSTEM on a server
 * setting (PG15+).
 */
const REFUSED_GRANT_CLASSES: ReadonlyMap<string, string> = new Map([
  ["all", "ALL … IN SCHEMA reaches every object in the schema, including ones the migration never names. Grant on each object."],
  ["database", "Database-level privileges are not schema migrations."],
  ["tablespace", "Tablespace privileges are not schema migrations."],
  ["language", "Language privileges decide who may write untrusted code."],
  ["parameter", "ON PARAMETER grants SET / ALTER SYSTEM on a server setting."],
  ["foreign", "Foreign-data-wrapper and foreign-server privileges reach outside the database."],
  ["large", "Large-object privileges are not schema migrations."],
  ["type", "Grant on the table or function that uses the type instead."],
  ["domain", "Grant on the table or function that uses the domain instead."]
]);

/** Role specifications that name whoever runs the migration, not a role the file chose. */
const SESSION_ROLE_WORDS = new Set(["current_user", "session_user", "current_role"]);

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
    verbs: ["reassign", "security"],
    reason: "Bulk ownership changes and security labels are outside the migration lane. GRANT / REVOKE on a named object and ALTER … OWNER TO an allowlisted role are accepted."
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

  if (verb === "grant" || verb === "revoke") {
    return { ok: true, verb, kind: "privilege" };
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
        : kindWord === "role" || kindWord === "user" || kindWord === "group"
          ? " Role management is outside the migration lane."
          : kindWord === "default"
            ? " ALTER DEFAULT PRIVILEGES changes the privileges of objects created later, by anyone; it is outside the migration lane."
            : "";
    return fail(
      "DDL_STATEMENT_NOT_ALLOWED",
      `${where}: ${verb.toUpperCase()} ${(kindWord ?? "").toUpperCase()} is not allowed in a migration.${extra} Allowed: ${allowed.map((x) => x.toUpperCase()).join(", ")}.`
    );
  }
  return { ok: true, verb, kind: kindWord as DdlObjectKind };
}

const hasTopLevelComma = (tokens: Token[]): boolean => {
  let depth = 0;
  for (const token of tokens) {
    if (token.type === "punct" && token.value === "(") {
      depth += 1;
    } else if (token.type === "punct" && token.value === ")") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && token.type === "punct" && token.value === ",") {
      return true;
    }
  }
  return false;
};

/** A role name as Postgres resolves it: an unquoted word folds to lower case, a quoted one does not. */
const roleName = (token: Token | undefined): string | undefined =>
  token !== undefined && (token.type === "word" || token.type === "quoted") ? token.value : undefined;

/**
 * `ALTER <kind> … OWNER TO <role>`, as the statement's ONLY action and only to a role the operator
 * listed. A SECURITY DEFINER function runs with its owner's privileges, so without this the owner
 * would be whoever connected — typically a personal admin login.
 */
function checkOwnerTo(tokens: Token[], verb: DdlVerb, kind: DdlObjectKind, where: string, ownerRoles: readonly string[]): DdlError | undefined {
  const refuse = (message: string): DdlError => ({ code: "DDL_STATEMENT_NOT_ALLOWED", message: `${where}: ${message}` });
  const n = tokens.length;
  const ownerAtEnd = n >= 3 && wordAt(tokens, n - 3) === "owner" && wordAt(tokens, n - 2) === "to";
  const ownerCount = topLevelWords(tokens).filter((t, k, all) => t.word === "owner" && all[k + 1]?.word === "to" && all[k + 1]?.at === t.at + 1).length;
  if (verb !== "alter" || !OWNER_KINDS.includes(kind)) {
    return refuse(`OWNER TO is accepted only on ALTER ${OWNER_KINDS.map((k) => k.toUpperCase()).join(" / ")}.`);
  }
  if (!ownerAtEnd || ownerCount !== 1 || hasTopLevelComma(tokens)) {
    return refuse("OWNER TO must be the statement's only action, at its end: ALTER … name OWNER TO role.");
  }
  const last = tokens[n - 1];
  const role = roleName(last);
  if (role === undefined || (last?.type === "word" && SESSION_ROLE_WORDS.has(role))) {
    return refuse("OWNER TO must name a role. CURRENT_USER / SESSION_USER / CURRENT_ROLE would make the owner whoever runs the migration.");
  }
  if (!ownerRoles.includes(role)) {
    return refuse(
      ownerRoles.length === 0
        ? `OWNER TO ${role} is refused: no owner role is allowlisted. An operator can allow it with POSTGRES_DDL_OWNER_ROLES.`
        : `OWNER TO ${role} is refused: it is not in POSTGRES_DDL_OWNER_ROLES (${ownerRoles.join(", ")}).`
    );
  }
  return undefined;
}

/**
 * GRANT / REVOKE privileges ON a named object, to or from named roles or PUBLIC. Refused: role
 * membership (no ON), `ALL … IN SCHEMA` and the non-schema object classes, WITH GRANT OPTION
 * (it lets the grantee grant further), GRANTED BY, and the session-role words.
 */
function checkPrivilege(tokens: Token[], verb: "grant" | "revoke", where: string): DdlError | undefined {
  const refuse = (message: string): DdlError => ({ code: "DDL_STATEMENT_NOT_ALLOWED", message: `${where}: ${message}` });
  const top = topLevelWords(tokens);
  const on = top.find((t) => t.word === "on");
  if (on === undefined) {
    return refuse(`${verb.toUpperCase()} without ON is role membership, which is outside the migration lane. Grant privileges ON an object instead.`);
  }
  const objectClass = wordAt(tokens, on.at + 1);
  if (objectClass !== undefined && REFUSED_GRANT_CLASSES.has(objectClass)) {
    return refuse(`${verb.toUpperCase()} … ON ${objectClass.toUpperCase()} is not allowed. ${REFUSED_GRANT_CLASSES.get(objectClass) ?? ""}`.trimEnd());
  }

  const keyword = verb === "grant" ? "to" : "from";
  const granteesAt = top.find((t) => t.at > on.at && t.word === keyword);
  if (granteesAt === undefined) {
    return refuse(`expected ${verb.toUpperCase()} … ON … ${keyword.toUpperCase()} role.`);
  }
  const after = top.filter((t) => t.at > granteesAt.at).map((t) => t.word);
  if (verb === "grant" && after.includes("with")) {
    return refuse("WITH GRANT OPTION lets the grantee pass the privilege on, past anything a migration reviews.");
  }
  if (after.includes("granted")) {
    return refuse("GRANTED BY records a different grantor than the role that ran the migration.");
  }
  const sessionRole = tokens.slice(granteesAt.at + 1).find((t) => t.type === "word" && SESSION_ROLE_WORDS.has(t.value));
  if (sessionRole !== undefined) {
    return refuse(`${sessionRole.value.toUpperCase()} names whoever runs the migration. Name the role.`);
  }
  return undefined;
}

export interface ShapeOptions {
  /** Roles `ALTER … OWNER TO` may name (POSTGRES_DDL_OWNER_ROLES). Empty refuses every OWNER TO. */
  ownerRoles?: readonly string[];
}

/** Checks that depend on the statement's shape beyond its first words. */
function checkShape(tokens: Token[], verb: DdlVerb, kind: DdlObjectKind, index: number, options: ShapeOptions = {}): DdlError | undefined {
  const where = `Statement ${String(index + 1)}`;
  const top = topLevelWords(tokens);

  if (verb === "grant" || verb === "revoke") {
    return checkPrivilege(tokens, verb, where);
  }

  if (hasTopLevelSequence(tokens, ["owner", "to"])) {
    const ownerError = checkOwnerTo(tokens, verb, kind, where, options.ownerRoles ?? []);
    if (ownerError !== undefined) {
      return ownerError;
    }
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

export interface ValidateOptions extends ShapeOptions {
  /** The inline form of the `-- mcp:no-transaction` directive. Either one turns it on. */
  noTransaction?: boolean;
  /**
   * A file written for psql, as a repo's own runner applies it (POSTGRES_DDL_EXTERNAL_LEDGER):
   * `\set ON_ERROR_STOP …` is dropped, any other meta-command is refused, and a BEGIN; … COMMIT;
   * that wraps the whole file is dropped because the server opens that transaction itself.
   */
  psql?: boolean;
}

/** `\set ON_ERROR_STOP on`: the server already stops at the first error, so it changes nothing. */
const ON_ERROR_STOP = /^\\set\s+ON_ERROR_STOP(?:\s+(?:on|1|true))?$/i;

/** `begin` / `begin work` / `start transaction` with no isolation level or other option. */
const isBareBegin = (group: Token[]): boolean => {
  const w = group.every((t) => t.type === "word") ? group.map((t) => t.value).join(" ") : "";
  return w === "begin" || w === "begin transaction" || w === "begin work" || w === "start transaction";
};

/** `commit` / `end`, optionally followed by WORK or TRANSACTION, and nothing else (no AND CHAIN). */
const isBareCommit = (group: Token[]): boolean => {
  const w = group.every((t) => t.type === "word") ? group.map((t) => t.value).join(" ") : "";
  return /^(commit|end)( work| transaction)?$/.test(w);
};

/**
 * psql mode: refuse every meta-command but `\set ON_ERROR_STOP`, and drop a BEGIN / COMMIT pair
 * that is exactly the file's first and last statement. Groups keep their original positions, so
 * "Statement N" still counts from the top of the file.
 */
function unwrapPsql(metaCommands: readonly MetaCommand[], groups: Token[][], directives: DdlDirectives): DdlResult<{ kept: Array<{ index: number; group: Token[] }> }> {
  for (const meta of metaCommands) {
    if (!ON_ERROR_STOP.test(meta.text)) {
      return fail(
        "DDL_PSQL_META_COMMAND",
        `psql meta-command '${meta.text.slice(0, 40)}' is not accepted. Only \\set ON_ERROR_STOP is, because the server already stops at the first error; anything else (\\i, \\c, \\gexec, …) changes what runs.`
      );
    }
    if (meta.midStatement) {
      return fail("DDL_PSQL_META_COMMAND", `'${meta.text}' sits inside a statement. Put it on its own line between statements.`);
    }
  }

  const all = groups.map((group, index) => ({ index, group }));
  const first = groups[0];
  const last = groups[groups.length - 1];
  const wrapped = groups.length >= 2 && first !== undefined && last !== undefined && isBareBegin(first) && isBareCommit(last);
  if (!wrapped) {
    return { ok: true, kept: all };
  }
  if (directives.noTransaction) {
    return fail("DDL_INVALID_DIRECTIVE", "-- mcp:no-transaction contradicts the file's own BEGIN; … COMMIT;. Remove one of them.");
  }
  return { ok: true, kept: all.slice(1, -1) };
}

/** Validate one migration script (a file's text or an inline `sql` argument). */
export function validateDdlScript(sql: string, options: ValidateOptions = {}): DdlResult<ValidatedDdl> {
  if (Buffer.byteLength(sql, "utf8") > MAX_DDL_SCRIPT_BYTES) {
    return fail("DDL_TOO_LARGE", `A migration may be at most ${String(MAX_DDL_SCRIPT_BYTES)} bytes.`);
  }

  const lexed = tokenize(sql, options.psql === true);
  if (!lexed.ok) {
    return lexed;
  }
  const { tokens, lineComments, metaCommands } = lexed;
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

  let kept = groups.map((group, index) => ({ index, group }));
  if (options.psql === true) {
    const unwrapped = unwrapPsql(metaCommands, groups, directives);
    if (!unwrapped.ok) {
      return unwrapped;
    }
    kept = unwrapped.kept;
    if (kept.length === 0) {
      return fail("DDL_EMPTY", "The migration contains no statements inside its BEGIN; … COMMIT;.");
    }
  }

  const statements: DdlStatement[] = [];
  for (const { index, group } of kept) {
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
    const shapeError = checkShape(group, classified.verb, classified.kind, index, options);
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
