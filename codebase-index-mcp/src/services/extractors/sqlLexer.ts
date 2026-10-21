/**
 * The SQL lexer and statement splitter for the SQL lane (MCP-ISSUE-082).
 *
 * PostgreSQL text is split into statements BEFORE anything parses it, for two reasons: a migration
 * file routinely holds a statement `pgsql-ast-parser` cannot read (`GRANT`, `CREATE POLICY`, a psql
 * meta-command), and one unreadable statement must cost that statement — named, with its line — not
 * the file. A `;` only ends a statement outside every quoting form, so the splitter has to know them
 * all:
 *
 * - `-- line` and `/* block *\/` comments, block comments nested as PostgreSQL nests them;
 * - `'string'` with `''` doubling, and `E'…'` with backslash escapes;
 * - `"quoted identifier"` with `""` doubling;
 * - `$$ … $$` and `$tag$ … $tag$` dollar quoting — a function or `DO` body, full of `;`;
 * - psql meta-commands (`\set ON_ERROR_STOP on`): a backslash at the start of a statement runs to
 *   the end of its line and is a statement of its own kind, never SQL;
 * - `COPY … FROM stdin;` data, which runs to a line holding `\.`;
 * - `BEGIN ATOMIC … END` SQL-standard function bodies, whose inner `;` do not end the CREATE.
 *
 * The same lexer feeds the TS query scanner (`sqlQueryScan.ts`), so a table name inside a string
 * literal or a comment of a query is never read as a reference.
 */

export type SqlTokenKind = "word" | "qident" | "string" | "dollar" | "number" | "param" | "punct";

export type SqlToken = {
  kind: SqlTokenKind;
  /**
   * `word`: lowercased (PostgreSQL folds unquoted identifiers). `qident`: the identifier as quoted,
   * case kept, quotes removed. `string`: the literal's content. `dollar`: the body between the tags.
   * `punct`: the character(s).
   */
  value: string;
  start: number;
  end: number;
  /** Offset of a dollar body's first character (`dollar` only). */
  bodyStart?: number;
};

export type SqlStatement = {
  kind: "sql" | "meta";
  /** Source text of the statement, terminator excluded, leading comments excluded. */
  text: string;
  start: number;
  end: number;
  /** 1-based line of the statement's first token. */
  line: number;
  /** 1-based line of its last token. */
  endLine: number;
  tokens: SqlToken[];
};

/** Maps an offset to a 1-based line by binary search over the line starts. */
export class LineIndex {
  private readonly starts: number[] = [0];
  constructor(source: string) {
    for (let i = 0; i < source.length; i += 1) if (source.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  lineAt(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}

const IDENT_START = /[A-Za-z_\u0080-￿]/;
const IDENT_PART = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

/**
 * Lex `source` from `from` to `to`. Comments and whitespace produce no token. An unterminated
 * quote runs to `to` — the lexer never throws, because its caller must always be able to name the
 * statement it could not read.
 */
export function lexSql(source: string, from = 0, to = source.length): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = from;
  while (i < to) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f") {
      i += 1;
      continue;
    }
    if (c === "-" && next === "-") {
      const nl = source.indexOf("\n", i);
      i = nl < 0 || nl > to ? to : nl + 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i = skipBlockComment(source, i, to);
      continue;
    }
    if ((c === "E" || c === "e") && next === "'") {
      const end = scanQuoted(source, i + 1, to, "'", true);
      tokens.push({ kind: "string", value: unescapeQuoted(source.slice(i + 2, end.contentEnd), "'"), start: i, end: end.end });
      i = end.end;
      continue;
    }
    if (c === "'") {
      const end = scanQuoted(source, i, to, "'", false);
      tokens.push({ kind: "string", value: unescapeQuoted(source.slice(i + 1, end.contentEnd), "'"), start: i, end: end.end });
      i = end.end;
      continue;
    }
    if (c === '"') {
      const end = scanQuoted(source, i, to, '"', false);
      tokens.push({ kind: "qident", value: unescapeQuoted(source.slice(i + 1, end.contentEnd), '"'), start: i, end: end.end });
      i = end.end;
      continue;
    }
    if (c === "$") {
      const tag = DOLLAR_TAG.exec(source.slice(i, Math.min(to, i + 64)));
      if (tag) {
        const open = tag[0];
        const bodyStart = i + open.length;
        const close = source.indexOf(open, bodyStart);
        const bodyEnd = close < 0 || close + open.length > to ? to : close;
        const end = close < 0 || close + open.length > to ? to : close + open.length;
        tokens.push({ kind: "dollar", value: source.slice(bodyStart, bodyEnd), start: i, end, bodyStart });
        i = end;
        continue;
      }
      const param = /^\$\d+/.exec(source.slice(i, Math.min(to, i + 12)));
      if (param) {
        tokens.push({ kind: "param", value: param[0], start: i, end: i + param[0].length });
        i += param[0].length;
        continue;
      }
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < to && IDENT_PART.test(source[j]!)) j += 1;
      tokens.push({ kind: "word", value: source.slice(i, j).toLowerCase(), start: i, end: j });
      i = j;
      continue;
    }
    if (c >= "0" && c <= "9") {
      let j = i + 1;
      while (j < to && /[0-9.eE_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: "number", value: source.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    if (c === ":" && next === ":") {
      tokens.push({ kind: "punct", value: "::", start: i, end: i + 2 });
      i += 2;
      continue;
    }
    tokens.push({ kind: "punct", value: c, start: i, end: i + 1 });
    i += 1;
  }
  return tokens;
}

function skipBlockComment(source: string, at: number, to: number): number {
  let depth = 0;
  let i = at;
  while (i < to) {
    if (source[i] === "/" && source[i + 1] === "*") {
      depth += 1;
      i += 2;
    } else if (source[i] === "*" && source[i + 1] === "/") {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
    } else {
      i += 1;
    }
  }
  return to;
}

/** `at` is the opening quote. Returns the offset after the closing quote and where the content ends. */
function scanQuoted(source: string, at: number, to: number, quote: string, backslash: boolean): { end: number; contentEnd: number } {
  let i = at + 1;
  while (i < to) {
    const ch = source[i]!;
    if (backslash && ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) {
      if (source[i + 1] === quote) {
        i += 2;
        continue;
      }
      return { end: i + 1, contentEnd: i };
    }
    i += 1;
  }
  return { end: to, contentEnd: to };
}

function unescapeQuoted(text: string, quote: string): string {
  return text.split(quote + quote).join(quote);
}

/** Offset of the first non-space, non-comment character at or after `from`, or `to`. */
function skipTrivia(source: string, from: number, to: number): number {
  let i = from;
  while (i < to) {
    const c = source[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f") {
      i += 1;
    } else if (c === "-" && source[i + 1] === "-") {
      const nl = source.indexOf("\n", i);
      i = nl < 0 ? to : nl + 1;
    } else if (c === "/" && source[i + 1] === "*") {
      i = skipBlockComment(source, i, to);
    } else {
      return i;
    }
  }
  return to;
}

/**
 * Split `source` into statements. Never throws; an unterminated last statement runs to the end of
 * the text. Empty statements (`;;`) produce nothing.
 */
export function splitSqlStatements(source: string, lines: LineIndex = new LineIndex(source)): SqlStatement[] {
  const out: SqlStatement[] = [];
  const to = source.length;
  let pos = 0;
  while (pos < to) {
    const start = skipTrivia(source, pos, to);
    if (start >= to) break;

    if (source[start] === "\\") {
      // psql meta-command: to the end of the line.
      const nl = source.indexOf("\n", start);
      const end = nl < 0 ? to : nl;
      const text = source.slice(start, end).replace(/\r$/, "");
      const line = lines.lineAt(start);
      out.push({ kind: "meta", text, start, end, line, endLine: line, tokens: [] });
      pos = end;
      continue;
    }

    // Lex forward token by token until a `;` that is not inside a BEGIN ATOMIC body.
    const tokens: SqlToken[] = [];
    let i = start;
    let end = to;
    let next = to;
    let atomicDepth = 0;
    let caseDepth = 0;
    for (;;) {
      const lexed = lexOne(source, i, to);
      if (!lexed) {
        end = to;
        next = to;
        break;
      }
      const tok = lexed;
      i = tok.end;
      if (tok.kind === "punct" && tok.value === ";" && atomicDepth === 0) {
        end = tok.start;
        next = tok.end;
        break;
      }
      tokens.push(tok);
      const n = tokens.length;
      if (tok.kind === "word" && tok.value === "atomic" && n >= 2 && tokens[n - 2]!.kind === "word" && tokens[n - 2]!.value === "begin") {
        atomicDepth += 1;
      } else if (atomicDepth > 0 && tok.kind === "word" && tok.value === "case") {
        caseDepth += 1;
      } else if (atomicDepth > 0 && tok.kind === "word" && tok.value === "end") {
        // A CASE inside the body closes with END too; only an unmatched END closes the body.
        if (caseDepth > 0) caseDepth -= 1;
        else atomicDepth -= 1;
      }
    }
    if (tokens.length > 0) {
      const last = tokens[tokens.length - 1]!;
      out.push({
        kind: "sql",
        text: source.slice(start, last.end),
        start,
        end: last.end,
        line: lines.lineAt(start),
        endLine: lines.lineAt(Math.max(start, last.end - 1)),
        tokens
      });
      if (isCopyFromStdin(tokens)) {
        // The data block runs to a line that is exactly `\.`.
        const dataEnd = /^\\\.\s*$/m.exec(source.slice(next));
        next = dataEnd ? next + dataEnd.index + dataEnd[0].length : to;
      }
    }
    pos = Math.max(next, end, start + 1);
  }
  return out;
}

function lexOne(source: string, from: number, to: number): SqlToken | null {
  const at = skipTrivia(source, from, to);
  if (at >= to) return null;
  // Lex just enough text to get one token: a quote or dollar body may be long, so lex to the end
  // and take the first token. lexSql stops at nothing, so bound the work by lexing from `at` and
  // returning the first token only.
  const c = source[at]!;
  if (c === "'" || c === '"' || c === "$" || ((c === "E" || c === "e") && source[at + 1] === "'")) {
    return lexSql(source, at, to)[0] ?? null;
  }
  // A short window is enough for words, numbers and punctuation.
  let windowEnd = at + 1;
  while (windowEnd < to && windowEnd - at < 256 && IDENT_PART.test(source[windowEnd]!)) windowEnd += 1;
  return lexSql(source, at, Math.min(to, windowEnd + 1))[0] ?? null;
}

function isCopyFromStdin(tokens: SqlToken[]): boolean {
  if (tokens[0]?.kind !== "word" || tokens[0].value !== "copy") return false;
  for (let k = 1; k + 1 < tokens.length; k += 1) {
    if (tokens[k]!.value === "from" && tokens[k + 1]!.value === "stdin") return true;
  }
  return false;
}

/** The first `n` words of a statement, single-spaced, for naming it — `create policy`, `grant select on`. */
export function firstWords(statement: SqlStatement, n = 4): string {
  if (statement.kind === "meta") return statement.text.split(/\s+/).slice(0, n).join(" ");
  return statement.tokens
    .slice(0, n)
    .map((t) => (t.kind === "word" ? t.value : t.kind === "qident" ? `"${t.value}"` : t.kind === "string" || t.kind === "dollar" ? "'…'" : t.value))
    .join(" ");
}
