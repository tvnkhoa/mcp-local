/**
 * Vue component tokens (MCP-ISSUE-074) — `component:<specifier>` and `component:<specifier>#<member>`.
 *
 * The template pass knows which import a tag came from but not which file that import names, because
 * resolving a specifier needs every file of the repo and its tsconfig aliases. So it emits the
 * specifier, and this pass binds it after the run with the same `resolveModuleSpecifier` the import
 * and call lanes use:
 *
 * - `USES_COMPONENT component:./AppCard.vue` → the target file's `component` symbol (or its module
 *   symbol when the specifier names a `.ts`/`.js` file — a `defineComponent` export or a barrel).
 * - `PROPERTY_WRITE component:./AppCard.vue#title` → the `title` member in that file (a `defineProps`
 *   prop, or an `on<Event>` listener member), preferring the one the component owns.
 *
 * Only rows labelled `unresolved component token` are read. The template pass labels its own gaps
 * (`<component :is>` branches it cannot follow, tags with no import) with a different reason, so they
 * are kept and visible but never "resolved" into something they are not. What this pass cannot bind
 * is labelled too, never dropped:
 *
 * | Case | `reason` | confidence |
 * |---|---|---|
 * | bare specifier (`vue-router`, a UI kit) | `external boundary` | 0.1 |
 * | path specifier naming no indexed file | stays `unresolved component token` | 0.5 |
 * | member the child does not declare | `vue binding not declared by child (fallthrough attribute)` | 0.2 |
 */

import type Database from "better-sqlite3";

import {
  EMPTY_ALIASES,
  isRelativeSpecifier,
  loadIndexedFilePaths,
  loadRepoPath,
  looksLikeModulePath,
  readTsconfigAliases,
  resolveModuleSpecifier
} from "./moduleResolution.js";

export const UNRESOLVED_COMPONENT_REASON = "unresolved component token";
export const COMPONENT_FALLTHROUGH_REASON = "vue binding not declared by child (fallthrough attribute)";

export function resolveComponentEdges(db: Database.Database, repoId: string): number {
  const rows = db
    .prepare(
      `select e.rowid as rowId, e.to_id as toId, sf.file_path as fromFile
       from edges e
       inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
       where e.repo_id = ? and e.to_id like 'component:%' and e.reason = ?
       order by e.rowid`
    )
    .all(repoId, UNRESOLVED_COMPONENT_REASON) as { rowId: number; toId: string; fromFile: string }[];
  if (rows.length === 0) return 0;

  const knownFiles = loadIndexedFilePaths(db, repoId);
  const repoPath = loadRepoPath(db, repoId);
  const aliases = repoPath ? readTsconfigAliases(repoPath) : EMPTY_ALIASES;

  const fileSymbols = db.prepare(
    `select symbol_id as symbolId, name, kind, parent_symbol_id as parentSymbolId
     from symbols where repo_id = ? and file_path in (?, ?)
     and kind in ('component', 'module', 'property')
     order by line, symbol_id`
  );
  const update = db.prepare(`update edges set to_id = ?, confidence = ?, reason = ? where rowid = ?`);

  type FileTargets = { owner: { symbolId: string; isComponent: boolean } | null; members: { symbolId: string; name: string; owned: boolean }[] };
  const targetsByFile = new Map<string, FileTargets>();
  const targetsFor = (file: string): FileTargets => {
    const cached = targetsByFile.get(file);
    if (cached) return cached;
    const symbols = fileSymbols.all(repoId, file, file.replace(/\//g, "\\")) as { symbolId: string; name: string; kind: string; parentSymbolId: string | null }[];
    const component = symbols.find((s) => s.kind === "component");
    const module = symbols.find((s) => s.kind === "module");
    const owner = component ? { symbolId: component.symbolId, isComponent: true } : module ? { symbolId: module.symbolId, isComponent: false } : null;
    const members = symbols
      .filter((s) => s.kind === "property")
      .map((s) => ({ symbolId: s.symbolId, name: s.name, owned: component !== undefined && s.parentSymbolId === component.symbolId }));
    const targets = { owner, members };
    targetsByFile.set(file, targets);
    return targets;
  };

  const resolveCache = new Map<string, string | null>();
  let resolved = 0;

  db.transaction(() => {
    for (const row of rows) {
      const token = row.toId.slice("component:".length);
      const hash = token.indexOf("#");
      const specifier = hash === -1 ? token : token.slice(0, hash);
      const member = hash === -1 ? null : token.slice(hash + 1);

      if (!isRelativeSpecifier(specifier) && !looksLikeModulePath(specifier)) {
        update.run(row.toId, 0.1, "external boundary", row.rowId);
        continue;
      }

      const fromFile = row.fromFile.replace(/\\/g, "/");
      const cacheKey = `${fromFile}\u0000${specifier}`;
      let targetFile = resolveCache.get(cacheKey);
      if (targetFile === undefined) {
        targetFile = resolveModuleSpecifier(fromFile, specifier, knownFiles, aliases);
        resolveCache.set(cacheKey, targetFile);
      }
      if (!targetFile) continue; // labelled already: `unresolved component token`

      const targets = targetsFor(targetFile);
      if (!targets.owner) continue;

      if (member === null) {
        update.run(
          targets.owner.symbolId,
          targets.owner.isComponent ? 0.95 : 0.8,
          targets.owner.isComponent ? "resolved vue component" : "resolved vue component module",
          row.rowId
        );
        resolved += 1;
        continue;
      }

      const named = targets.members.filter((m) => m.name === member);
      const match = named.find((m) => m.owned) ?? named[0];
      if (match) {
        update.run(match.symbolId, match.owned ? 0.95 : 0.85, "resolved vue component member", row.rowId);
        resolved += 1;
      } else {
        update.run(row.toId, 0.2, COMPONENT_FALLTHROUGH_REASON, row.rowId);
      }
    }
  })();

  return resolved;
}
