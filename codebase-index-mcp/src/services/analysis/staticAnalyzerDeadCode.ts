/**
 * `dead_code_scan`: the query, and the loop that applies the suppression policy to its rows.
 *
 * The edge counts are computed in SQL rather than by walking the graph because the scan is
 * unbounded by design - it looks at every public symbol matching the filters - and one query
 * with correlated sub-selects beats N round trips. `incomingPublishes` is counted alongside the
 * static edge types so an `IConsumer<T>` reached over the message bus is not reported dead
 * (ISSUE-020).
 *
 * The C# heuristics live in `staticAnalyzerDeadCodeCSharp.ts` (S-41).
 */

import type Database from "better-sqlite3";
import {
  buildFileContexts,
  getCSharpSuppressionReason,
  isLikelyEntryPoint,
  type DeadCodeRow
} from "./staticAnalyzerDeadCodeCSharp.js";

/** A symbol declared in one of these is wired by the runtime; never a dead-code candidate. */
const BOOTSTRAP_FILE_NAMES = [
  "Program.cs", "Startup.cs", "main.ts", "main.js", "index.ts", "index.js",
  "App.tsx", "App.ts", "server.ts", "server.js"
];

export function getDeadCodeCandidates(
  db: Database.Database,
  repoId: string,
  filePathPrefix: string | null,
  language: string | null,
  kind: string | null,
  includePrivate: boolean,
  limit: number
): {
  candidates: {
    symbolId: string;
    name: string;
    kind: string;
    filePath: string;
    line: number;
    signature: string | null;
    language: string | null;
    incomingCalls: number;
    incomingTypeRefs: number;
    incomingImports: number;
    deadReason: string;
  }[];
  suppressed: {
    total: number;
    reasons: Record<string, number>;
    /** True when the candidate scan stopped at its examine cap, so `total` covers only rows examined. */
    truncated?: boolean;
  };
  scanPolicy: {
    mode: "skip_low_confidence";
    note: string;
  };
} {
  const conditions: string[] = [
    "s.repo_id = ?",
    "s.kind not in ('module', 'property', 'constructor', 'type', 'interface')"
  ];
  const params: unknown[] = [repoId];

  if (filePathPrefix) {
    conditions.push("replace(s.file_path, char(92), '/') like ?");
    params.push(`${filePathPrefix.replace(/\\/g, "/")}%`);
  }
  if (language) {
    conditions.push("coalesce(f.language, '') = ?");
    params.push(language.toLowerCase());
  }
  if (kind) {
    conditions.push("s.kind = ?");
    params.push(kind);
  }
  if (!includePrivate) {
    conditions.push("coalesce(s.signature, '') not like 'private %'");
    // ESCAPE is mandatory here, not stylistic. In SQL LIKE, `_` is a single-character wildcard, so
    // `'_%'` matches every name of length >= 1 and `NOT LIKE '_%'` therefore excluded EVERY symbol.
    // Since `includePrivate` defaults to false, `dead_code_scan` returned an empty result for every
    // repo, always — 0 candidates and 0 suppressed, which reads as "nothing dead" rather than as a
    // broken filter. Measured on wec.communication-hub: 2760 rows survive the kind filter, and this
    // one condition took it to 0. Escaped, the intended convention check keeps all 2760.
    conditions.push("s.name not like '\\_%' escape '\\'");
  }

  const where = conditions.join(" and ");

  /**
   * Split into two queries on purpose.
   *
   * The old single statement selected five correlated counting subqueries for EVERY symbol in the
   * repo, then threw away all but the rows whose counts were zero. Four of those five existed only to
   * find zeros — a reported candidate has no incoming edges by definition — so they belong in the
   * WHERE clause as NOT EXISTS predicates, which short-circuit on the first match and use
   * `idx_edges_repo_type_to` instead of counting every matching edge.
   *
   * They cannot simply be moved, though: `buildFileContexts` needs EVERY row of a file to collect its
   * evidence ("does this file contain a validator class?"), and that class usually does have incoming
   * edges, so it would vanish from a filtered row set and silently change which symbols get
   * suppressed.
   *
   * So: candidates first (NOT EXISTS, cheap, few rows), then context rows for just those candidates'
   * files. `outgoingCalls` is the only count still selected — the one value still read, by
   * `isLikelyEntryPoint`.
   */
  // The candidacy test, expressed in SQL. `callee:`/`type:` token forms are kept because an
  // unresolved edge still counts as a reference — dropping them would report referenced symbols as
  // dead whenever resolution failed.
  const candidateStmt = db.prepare(
    `
    select
      s.symbol_id as symbolId,
      s.name as name,
      s.kind as kind,
      s.file_path as filePath,
      s.line as line,
      s.signature as signature,
      f.language as language,
      (select count(*) from edges e where e.repo_id = s.repo_id and e.from_id = s.symbol_id and e.type = 'CALLS') as outgoingCalls
    from symbols s
    left join files f on f.repo_id = s.repo_id and f.path = s.file_path
    where ${where}
      and not exists (
        select 1 from edges e where e.repo_id = s.repo_id and e.type = 'CALLS'
          and (e.to_id = s.symbol_id or e.to_id = ('callee:' || s.name))
      )
      and not exists (
        select 1 from edges e where e.repo_id = s.repo_id and e.type = 'TYPE_REF'
          and (e.to_id = s.symbol_id or e.to_id = ('type:' || s.name))
      )
      and not exists (
        select 1 from edges e where e.repo_id = s.repo_id and e.type = 'IMPORTS' and e.to_id = s.symbol_id
      )
      and not exists (
        select 1 from edges e where e.repo_id = s.repo_id and e.type = 'PUBLISHES' and e.to_id = s.symbol_id
      )
      -- Keyset pagination, not OFFSET. With OFFSET, SQLite re-evaluates and discards the skipped rows
      -- on every page, so the NOT EXISTS predicates above were re-run for the whole prefix each time —
      -- quadratic in the number of candidates, which is what kept a 67k-symbol repo past the request
      -- timeout. The cursor matches the ORDER BY exactly, so paging cannot skip or repeat a row.
      and (s.file_path > ? or (s.file_path = ? and s.line > ?))
    order by s.file_path, s.line
    limit ?
    `
  );

  const rows: DeadCodeRow[] = [];
  const chunkSize = Math.max(limit * 3, 100);
  const examineCap = Math.max(limit * 20, 300);
  let truncated = false;
  let cursorFile = "";
  let cursorLine = -1;
  for (;;) {
    const batch = candidateStmt.all(...params, cursorFile, cursorFile, cursorLine, chunkSize) as Omit<
      DeadCodeRow,
      "incomingCalls" | "incomingTypeRefs" | "incomingImports" | "incomingPublishes"
    >[];
    if (batch.length === 0) break;
    for (const row of batch) {
      // Zero by construction: the NOT EXISTS predicates above are exactly the old
      // `sum(incoming) > 0 -> skip` test, so every row reaching here had all four at zero anyway.
      rows.push({ ...row, incomingCalls: 0, incomingTypeRefs: 0, incomingImports: 0, incomingPublishes: 0 });
    }
    const last = batch[batch.length - 1];
    cursorFile = last.filePath;
    cursorLine = last.line;
    if (batch.length < chunkSize) break;
    // The suppression loop below rejects rows, so more than `limit` candidates may be needed — but not
    // unboundedly. Paging the entire candidate set costs 40s on a 67k-symbol repo against 0.6s with
    // this bound, and the tool returns at most `limit` rows either way.
    //
    // The bound is REPORTED, not silent (`suppressed.truncated`): it makes `suppressed.total` a count
    // over the rows examined rather than over the repo, and a capped number that looks total is worse
    // than a smaller number that says so.
    if (rows.length >= examineCap) {
      truncated = true;
      break;
    }
  }

  // Contexts are only ever consulted for a candidate's OWN file (`fileContexts.get(row.filePath)`),
  // so fetching every symbol in the repo was wasted work — and it is what kept the scan slow after the
  // NOT EXISTS change: a 67k-symbol repo paged through all of it to build contexts nobody read.
  // Scoped to the candidate files, which is behaviour-identical and turns the dominant cost into a
  // function of the candidate count rather than the repo size.
  const candidateFiles = [...new Set(rows.map((r) => r.filePath))];
  const contextRows: DeadCodeRow[] = [];

  if (candidateFiles.length > 0) {
    // Chunked to stay clear of SQLite's parameter limit (999 by default).
    const FILE_CHUNK = 400;
    for (let i = 0; i < candidateFiles.length; i += FILE_CHUNK) {
      const chunk = candidateFiles.slice(i, i + FILE_CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");
      const contextStmt = db.prepare(
        `
        select
          s.symbol_id as symbolId,
          s.name as name,
          s.kind as kind,
          s.file_path as filePath,
          s.line as line,
          s.signature as signature,
          f.language as language
        from symbols s
        left join files f on f.repo_id = s.repo_id and f.path = s.file_path
        where s.repo_id = ? and s.file_path in (${placeholders})
        order by s.file_path, s.line
        `
      );
      // NOTE: deliberately NOT filtered by the caller's `kind`/`includePrivate` conditions. The
      // evidence a file carries comes from its class-like declarations, and a private or
      // kind-filtered-out class still tells us the file holds a validator — narrowing this would
      // silently weaken suppression.
      const batch = contextStmt.all(repoId, ...chunk) as Omit<
        DeadCodeRow,
        "incomingCalls" | "incomingTypeRefs" | "incomingImports" | "incomingPublishes" | "outgoingCalls"
      >[];
      for (const row of batch) {
        contextRows.push({
          ...row,
          incomingCalls: 0,
          incomingTypeRefs: 0,
          incomingImports: 0,
          incomingPublishes: 0,
          outgoingCalls: 0
        });
      }
    }
  }

  const results: {
    symbolId: string;
    name: string;
    kind: string;
    filePath: string;
    line: number;
    signature: string | null;
    language: string | null;
    incomingCalls: number;
    incomingTypeRefs: number;
    incomingImports: number;
    deadReason: string;
  }[] = [];
  const suppressedReasons = new Map<string, number>();
  const recordSuppressed = (reason: string) => {
    suppressedReasons.set(reason, (suppressedReasons.get(reason) ?? 0) + 1);
  };

  // From the UNFILTERED set — see the note on the two queries above.
  const fileContexts = buildFileContexts(contextRows);

  const callBlindLanguages = languagesWithoutCallEdges(db, repoId);

  for (const row of rows) {
    // MCP-ISSUE-060: a language whose extractor emits no CALLS edges at all cannot support the claim
    // "nothing calls this". Measured on `wec.rag` (95 of 140 files Python): every edge from a `.py`
    // symbol is an IMPORT — 449 of them, and zero CALLS, TYPE_REF or PROPERTY_REF — because
    // `pythonExtractor.ts` is a ~89-line regex stub. `dead_code_scan` duly reported the program's own
    // `main` as a candidate, with `suppressed.total: 0` beside it, because every existing heuristic
    // here is C#-shaped. A filename allowlist would not have caught it either: that `main` lives in
    // `chat.py`, not `main.py`.
    //
    // Derived from the index rather than from a hardcoded language list, so a lane that gains call
    // extraction later stops being suppressed without anyone editing this file, and a lane added as a
    // stub is covered the day it appears.
    if (row.language != null && callBlindLanguages.has(row.language)) {
      recordSuppressed("language_lane_has_no_call_edges");
      continue;
    }

    const normalizedPath = row.filePath.replace(/\\/g, "/");
    const isBootstrap = BOOTSTRAP_FILE_NAMES.some((f) => normalizedPath.endsWith(`/${f}`) || normalizedPath === f);
    if (isBootstrap) {
      recordSuppressed("bootstrap_file");
      continue;
    }

    if (isLikelyEntryPoint(row, fileContexts)) {
      recordSuppressed("heuristic_entry_point");
      continue;
    }

    const csharpSuppressionReason = getCSharpSuppressionReason(row, fileContexts);
    if (csharpSuppressionReason) {
      recordSuppressed(csharpSuppressionReason);
      continue;
    }

    // The old `sum(incoming) > 0 -> skip` test lived here. It is now four NOT EXISTS predicates in the
    // candidate query, including PUBLISHES: a consumer reached over the message bus (ISSUE-020) is live
    // even with no static CALLS edge, so it must keep counting as a reference.

    results.push({
      ...row,
      deadReason: "no_incoming_calls_typerefs_imports"
    });

    if (results.length >= limit) {
      break;
    }
  }

  return {
    candidates: results,
    suppressed: {
      total: [...suppressedReasons.values()].reduce((sum, count) => sum + count, 0),
      reasons: Object.fromEntries([...suppressedReasons.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
      // Omitted rather than `false` so the common case adds nothing to the wire, and present only when
      // the count really is partial.
      ...(truncated ? { truncated: true } : {})
    },
    scanPolicy: {
      mode: "skip_low_confidence",
      note: "Suppressed symbols are excluded from dead-code candidates because they match low-confidence runtime/convention heuristics; exclusion does not prove the symbol is live."
    }
  };
}

/**
 * Languages in this repo from whose symbols the graph holds no CALLS edge at all.
 *
 * The distinction the candidate query cannot draw: "this symbol has no callers" and "this language's
 * extractor does not record callers" both produce zero incoming edges, and only one of them means
 * anything. See the suppression above for the measurement that motivated it.
 */
function languagesWithoutCallEdges(db: Database.Database, repoId: string): Set<string> {
  // Only meaningful RELATIVE to the rest of the repo. A repo with no CALLS edges anywhere is not
  // evidence that one lane is blind — it is a repo that has not been indexed, or a small fixture, and
  // suppressing everything there would replace a wrong answer with no answer. The signal worth acting
  // on is narrower and much stronger: extraction demonstrably produces call edges HERE, and produces
  // none at all for this one language.
  const repoHasAnyCalls = db
    .prepare(`select 1 as ok from edges where repo_id = ? and type = 'CALLS' limit 1`)
    .get(repoId);
  if (!repoHasAnyCalls) return new Set<string>();

  const languages = db
    .prepare(`select distinct language from files where repo_id = ? and language is not null`)
    .all(repoId) as { language: string }[];

  const hasCalls = db.prepare(
    `select 1 as ok
     from edges e
     join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
     join files f on f.repo_id = s.repo_id and f.path = s.file_path
     where e.repo_id = ? and e.type = 'CALLS' and f.language = ?
     limit 1`
  );

  const blind = new Set<string>();
  for (const { language } of languages) {
    if (!hasCalls.get(repoId, language)) blind.add(language);
  }
  return blind;
}
