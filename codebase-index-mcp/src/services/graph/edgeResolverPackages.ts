/**
 * Workspace-package edges (MCP-ISSUE-076): `package.json` → the `package.json` of a package in the
 * SAME repo that it depends on.
 *
 * The JSON lane emits one `DEPENDS_ON npm:<name>` token per dependency and stamps each package.json's
 * module symbol with `signature = npm:<its name>`. This pass joins the two: for every token whose name
 * a package of this repo declares, a second `DEPENDS_ON` straight to that package's module — whether
 * the range is pnpm/yarn's `workspace:*` or a plain semver range a workspace links locally anyway. The
 * `npm:` token stays: it is still the dependency as declared, and the version lives in its reason.
 *
 * Recomputed from scratch on every run (delete, then insert): the edges are a pure function of the
 * tokens and the declared names, so an incremental run that renames a package lands exactly where a
 * full run would — the full-vs-incremental equality the `incremental-indexing` conformance checks.
 * Cheap: one row per dependency.
 */

import type Database from "better-sqlite3";

export const WORKSPACE_EDGE_REASON_PREFIX = "workspace package";

export function resolveWorkspacePackageEdges(db: Database.Database, repoId: string): number {
  const packages = db
    .prepare(
      `select signature, symbol_id as symbolId from symbols
       where repo_id = ? and kind = 'module' and signature like 'npm:%'
       order by signature, file_path`
    )
    .all(repoId) as { signature: string; symbolId: string }[];
  // Two package.json files declaring one name (a fixture copy) — the first by path wins, deterministically.
  const moduleByName = new Map<string, string>();
  for (const row of packages) {
    const name = row.signature.slice("npm:".length);
    if (!moduleByName.has(name)) moduleByName.set(name, row.symbolId);
  }

  const tokens = db
    .prepare(
      `select distinct from_id as fromId, to_id as toId, reason from edges
       where repo_id = ? and type = 'DEPENDS_ON' and to_id like 'npm:%'
       order by from_id, to_id`
    )
    .all(repoId) as { fromId: string; toId: string; reason: string | null }[];

  const remove = db.prepare(`delete from edges where repo_id = ? and type = 'DEPENDS_ON' and reason like ?`);
  const insert = db.prepare(
    `insert into edges (repo_id, from_id, to_id, type, confidence, reason) values (?, ?, ?, 'DEPENDS_ON', ?, ?)`
  );

  let written = 0;
  db.transaction(() => {
    remove.run(repoId, `${WORKSPACE_EDGE_REASON_PREFIX}%`);
    for (const token of tokens) {
      const target = moduleByName.get(token.toId.slice("npm:".length));
      if (!target || target === token.fromId) continue;
      const range = /\(([^)]*)\)\s*$/.exec(token.reason ?? "")?.[1] ?? null;
      const reason = range ? `${WORKSPACE_EDGE_REASON_PREFIX} ${token.toId.slice(4)} (${range})` : `${WORKSPACE_EDGE_REASON_PREFIX} ${token.toId.slice(4)}`;
      insert.run(repoId, token.fromId, target, range?.startsWith("workspace:") ? 1.0 : 0.95, reason);
      written += 1;
    }
  })();
  return written;
}
