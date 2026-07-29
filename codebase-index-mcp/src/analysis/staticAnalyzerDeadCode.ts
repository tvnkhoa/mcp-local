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
  const stmt = db.prepare(
    `
    select
      s.symbol_id as symbolId,
      s.name as name,
      s.kind as kind,
      s.file_path as filePath,
      s.line as line,
      s.signature as signature,
      f.language as language,
      (select count(*)
         from edges e
        where e.repo_id = s.repo_id
          and e.type = 'CALLS'
          and (
            e.to_id = s.symbol_id
            or e.to_id = ('callee:' || s.name)
          )) as incomingCalls,
      (select count(*)
         from edges e
        where e.repo_id = s.repo_id
          and e.type = 'TYPE_REF'
          and (
            e.to_id = s.symbol_id
            or e.to_id = ('type:' || s.name)
          )) as incomingTypeRefs,
      (select count(*) from edges e where e.repo_id = s.repo_id and e.to_id = s.symbol_id and e.type = 'IMPORTS') as incomingImports,
      (select count(*) from edges e where e.repo_id = s.repo_id and e.to_id = s.symbol_id and e.type = 'PUBLISHES') as incomingPublishes,
      (select count(*) from edges e where e.repo_id = s.repo_id and e.from_id = s.symbol_id and e.type = 'CALLS') as outgoingCalls
      -- fileIncomingUsages used to be selected here: a correlated subquery joining edges to symbols
      -- twice, per row. Nothing read it -- not the suppressors, not the response -- so the most
      -- expensive part of this statement computed a value that was then discarded.
      --
      -- It could not have been cheap to keep either: correlated only on s.file_path, it recomputed an
      -- identical answer for every symbol in the same file. Nobody noticed because MCP-ISSUE-033 meant
      -- the WHERE clause matched zero rows, so the subquery never ran at all. Fixing that filter made
      -- dead_code_scan exceed a 120s tool timeout on a 4442-symbol repo; removing this brought it back.
      -- If a per-file usage count is ever wanted, compute it once per file and join it in.
      -- (No backticks in here -- this is a template literal.)
    from symbols s
    left join files f on f.repo_id = s.repo_id and f.path = s.file_path
    where ${where}
    order by s.file_path, s.line
    limit ? offset ?
    `
  );
  const chunkSize = Math.max(limit * 3, 100);
  const rows: DeadCodeRow[] = [];
  for (let offset = 0; ; offset += chunkSize) {
    const batch = stmt.all(...params, chunkSize, offset) as DeadCodeRow[];
    if (batch.length === 0) {
      break;
    }
    rows.push(...batch);
    if (batch.length < chunkSize) {
      break;
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

  const fileContexts = buildFileContexts(rows);

  for (const row of rows) {
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

    // incomingPublishes: a consumer reached over the message bus (ISSUE-020) is live even with
    // no static CALLS edge — counting it prevents a false dead-code flag for IConsumer<T> types.
    if ((row.incomingCalls + row.incomingTypeRefs + row.incomingImports + row.incomingPublishes) > 0) {
      continue;
    }

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
      reasons: Object.fromEntries([...suppressedReasons.entries()].sort((a, b) => a[0].localeCompare(b[0])))
    },
    scanPolicy: {
      mode: "skip_low_confidence",
      note: "Suppressed symbols are excluded from dead-code candidates because they match low-confidence runtime/convention heuristics; exclusion does not prove the symbol is live."
    }
  };
}
