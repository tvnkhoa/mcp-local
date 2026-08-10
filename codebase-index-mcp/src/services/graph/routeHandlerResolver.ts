/**
 * MCP-ISSUE-055 — bind a minimal-API route to the handler it actually dispatches to, when that
 * handler is declared in a different file of the same partial class.
 *
 * Extraction sees one file at a time. `Customers.cs` registers
 * `groupBuilder.MapGet("{customerId:int}/notes", GetNotes)`, but `GetNotes` is declared in
 * `Customers.Notes.cs` — a sibling part of the same `partial class`. The in-file symbol lookup missed,
 * every route fell back to the enclosing registration method, and all 13 endpoints in the group came
 * back as `handlerName: "Map"` sharing one symbolId. That is precisely the addressability
 * MCP-ISSUE-044 set out to deliver, so 044 was only half-fixed — its re-verification happened to
 * sample `Conversations.cs`, a single non-partial class whose handlers are all in-file.
 *
 * This runs after every file is indexed, when sibling parts ARE in the graph, and joins on the pair
 * that identifies a partial-class member: the handler's name plus its declaring type's name. Only
 * routes whose current handler symbol does not match the recorded delegate name are touched, so the
 * pass is idempotent and never overwrites a binding extraction already got right.
 *
 * **Why this is not one UPDATE statement (code review, 2026-08-10).** The declaring type's *simple*
 * name is not unique: a multi-project solution can hold two `Customers` endpoint groups in different
 * assemblies, and the pure-SQL form joined on `p.name = c.name` alone — `order by m.file_path, m.line
 * limit 1` then made the wrong pick deterministic rather than correct. The discriminator we actually
 * have is the file path (there is no namespace column on `symbols`), and SQLite has no `reverse`, so
 * ranking candidates by how much of their directory path they share with the controller is far
 * clearer in JS. Route counts are in the hundreds, so the per-route query is not a cost worth
 * contorting SQL to avoid.
 */

import type Database from "better-sqlite3";

/** Directory segments of a file path, forward-slash normalized, filename dropped. */
function directorySegments(filePath: string): string[] {
  const segments = filePath.replace(/\\/g, "/").split("/");
  segments.pop(); // the filename itself is never a directory
  return segments.filter((s) => s.length > 0);
}

/** How many leading directory segments two files share — 0 means unrelated trees. */
function sharedDirectoryDepth(a: string, b: string): number {
  const left = directorySegments(a);
  const right = directorySegments(b);
  let depth = 0;
  while (depth < left.length && depth < right.length && left[depth].toLowerCase() === right[depth].toLowerCase()) {
    depth += 1;
  }
  return depth;
}

type RouteRow = { rowid: number; handlerName: string; controllerFilePath: string; controllerName: string };
type CandidateRow = { symbolId: string; filePath: string; line: number };

export function resolveRouteHandlersImpl(db: Database.Database, repoId: string): number {
  // Rows that are currently WRONG: the bound symbol is not the delegate that was written at the
  // registration site. A row whose binding already matches is left untouched, which is what makes
  // repeated runs idempotent.
  const rows = db
    .prepare(
      `
      select
        r.rowid as rowid,
        r.handler_name as handlerName,
        c.file_path as controllerFilePath,
        c.name as controllerName
      from routes r
      inner join symbols c on c.repo_id = r.repo_id and c.symbol_id = r.controller_symbol_id
      where r.repo_id = @repoId
        and r.handler_name is not null
        and not exists (
          select 1 from symbols h
          where h.repo_id = r.repo_id
            and h.symbol_id = r.handler_symbol_id
            and h.name = r.handler_name
        )
      `
    )
    .all({ repoId }) as RouteRow[];

  if (rows.length === 0) return 0;

  const candidatesStmt = db.prepare(
    `
    select m.symbol_id as symbolId, m.file_path as filePath, m.line as line
    from symbols m
    inner join symbols p on p.repo_id = m.repo_id and p.symbol_id = m.parent_symbol_id
    where m.repo_id = @repoId
      and m.kind = 'method'
      and m.name = @handlerName
      and p.name = @controllerName
    `
  );
  const updateStmt = db.prepare(`update routes set handler_symbol_id = @symbolId where rowid = @rowid`);

  let changed = 0;
  for (const row of rows) {
    const candidates = candidatesStmt.all({
      repoId,
      handlerName: row.handlerName,
      controllerName: row.controllerName
    }) as CandidateRow[];

    if (candidates.length === 0) {
      // A genuinely unresolvable delegate — a lambda, or a handler in an unindexed file. Keep the
      // fallback binding rather than nulling it out.
      continue;
    }

    // Parts of one partial class live in one project, so the right candidate is the one sharing the
    // longest directory prefix with the file that registered the route. `Customers.Notes.cs` beside
    // `Customers.cs` shares its whole directory; a same-named group in another project shares only
    // the solution root. Ties break on (file_path, line) — MCP-ISSUE-032's rule: never an arbitrary
    // row.
    let best: CandidateRow | null = null;
    let bestDepth = -1;
    for (const candidate of candidates) {
      const depth = sharedDirectoryDepth(row.controllerFilePath, candidate.filePath);
      const better =
        depth > bestDepth ||
        (depth === bestDepth &&
          best !== null &&
          (candidate.filePath < best.filePath ||
            (candidate.filePath === best.filePath && candidate.line < best.line)));
      if (better) {
        best = candidate;
        bestDepth = depth;
      }
    }

    // Nothing in common but the repo root, with more than one namesake to choose from: the simple
    // name genuinely does not identify a handler here. Guessing would cross-bind two projects'
    // endpoint groups, so leave the fallback and let `handler_name` carry the answer.
    if (!best || (bestDepth === 0 && candidates.length > 1)) continue;

    updateStmt.run({ symbolId: best.symbolId, rowid: row.rowid });
    changed += 1;
  }

  return changed;
}
