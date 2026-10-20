/**
 * USES_CSS_VAR and USES_CSS_CLASS edges (MCP-ISSUE-075) — binding `cssvar:<name>` and
 * `cssclass:<.name>` tokens to the CSS symbols that define them, repo-wide, by name.
 *
 * By name is not a guess here: a custom property and a class are global names in CSS, so a
 * `var(--text-tertiary)` reference really does mean every definition of `--text-tertiary` the cascade
 * might pick (`:root`, a dark-theme override, a brand file). So a token is FANNED OUT to one edge per
 * definition, and the reason says how many — a caller asking "who uses" from any one definition sees
 * every user.
 *
 * The pass also re-fans edges it resolved on an earlier run. Without that, an incremental run that
 * adds a second definition in an unchanged position would leave existing users bound to the first
 * one only, while a full run binds them to both — the full-vs-incremental equality the
 * `incremental-indexing` conformance procedure checks.
 *
 * A token with no definition in the repo (a variable set from JS or by a library stylesheet outside
 * the index) is KEPT with its extraction label — `unresolved css variable token` /
 * `unresolved css class token` at 0.5 — never dropped and never dressed up as resolved.
 */

import type Database from "better-sqlite3";

type CssEdgeSpec = { type: "USES_CSS_VAR" | "USES_CSS_CLASS"; prefix: string; kind: string; label: string };

const CSS_EDGE_SPECS: readonly CssEdgeSpec[] = [
  { type: "USES_CSS_VAR", prefix: "cssvar:", kind: "css_variable", label: "css variable" },
  { type: "USES_CSS_CLASS", prefix: "cssclass:", kind: "css_class", label: "css class" }
];

export type CssResolutionStats = {
  /** Token edges bound to at least one definition this run. */
  tokensResolved: number;
  /** Token edges left as labelled tokens because nothing in the repo defines the name. */
  tokensUnresolved: number;
  /** Resolved edges written (one per definition, so ≥ tokensResolved). */
  edgesWritten: number;
};

export function resolveCssEdges(db: Database.Database, repoId: string): CssResolutionStats {
  const stats: CssResolutionStats = { tokensResolved: 0, tokensUnresolved: 0, edgesWritten: 0 };

  for (const spec of CSS_EDGE_SPECS) {
    const tokens = db
      .prepare(
        `select distinct from_id as fromId, to_id as toId from edges
         where repo_id = ? and type = ? and to_id like ?
         order by from_id, to_id`
      )
      .all(repoId, spec.type, `${spec.prefix}%`) as { fromId: string; toId: string }[];
    const resolvedPairs = db
      .prepare(
        `select distinct e.from_id as fromId, s.name as name from edges e
         join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.to_id
         where e.repo_id = ? and e.type = ?
         order by e.from_id, s.name`
      )
      .all(repoId, spec.type) as { fromId: string; name: string }[];
    if (tokens.length === 0 && resolvedPairs.length === 0) continue;

    const defsByName = new Map<string, string[]>();
    const defRows = db
      .prepare(`select name, symbol_id as symbolId from symbols where repo_id = ? and kind = ? order by name, symbol_id`)
      .all(repoId, spec.kind) as { name: string; symbolId: string }[];
    for (const row of defRows) {
      const list = defsByName.get(row.name) ?? [];
      list.push(row.symbolId);
      defsByName.set(row.name, list);
    }

    const deleteToken = db.prepare(`delete from edges where repo_id = ? and from_id = ? and to_id = ? and type = ?`);
    const deleteResolved = db.prepare(
      `delete from edges where repo_id = ? and from_id = ? and type = ? and to_id in (select value from json_each(?))`
    );
    const insertEdge = db.prepare(
      `insert into edges (repo_id, from_id, to_id, type, confidence, reason) values (?, ?, ?, ?, ?, ?)`
    );

    // (fromId, name) pairs to (re)write, from fresh tokens and from earlier resolutions alike.
    const pairs = new Map<string, { fromId: string; name: string }>();
    for (const row of resolvedPairs) pairs.set(`${row.fromId}\u0000${row.name}`, row);

    const tx = db.transaction(() => {
      for (const token of tokens) {
        const name = token.toId.slice(spec.prefix.length);
        if (!defsByName.has(name)) {
          stats.tokensUnresolved += 1;
          continue;
        }
        deleteToken.run(repoId, token.fromId, token.toId, spec.type);
        stats.tokensResolved += 1;
        pairs.set(`${token.fromId}\u0000${name}`, { fromId: token.fromId, name });
      }
      for (const { fromId, name } of pairs.values()) {
        const defs = (defsByName.get(name) ?? []).filter((id) => id !== fromId);
        if (defs.length === 0) continue;
        // Rewrite the whole set so confidence/reason always state the current definition count.
        deleteResolved.run(repoId, fromId, spec.type, JSON.stringify(defs));
        const confidence = defs.length === 1 ? 0.9 : 0.8;
        const reason = defs.length === 1
          ? `resolved ${spec.label} by name`
          : `resolved ${spec.label} by name (${String(defs.length)} definitions)`;
        for (const toId of defs) {
          insertEdge.run(repoId, fromId, toId, spec.type, confidence, reason);
          stats.edgesWritten += 1;
        }
      }
    });
    tx();
  }

  return stats;
}
