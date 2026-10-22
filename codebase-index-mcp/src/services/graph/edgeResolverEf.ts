import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import { EF_ENTITY_TOKEN_PREFIX, EF_PROPERTY_TOKEN_PREFIX, EF_TOKEN_CONFIDENCE, EF_UNRESOLVED_REASON_PREFIX } from "../extractors/csharpEfSnapshot.js";

/**
 * Release L3 (MCP-ISSUE-092): bind the EF snapshot lane's `EF_MAPS` tokens — `efentity:<Ns.Type>` from a
 * `sql_table`, `efprop:<Ns.Type>#<Prop>` from a `sql_column` — to the CLR class and property.
 *
 * The class binds by NAMESPACE-QUALIFIED name: a class (or record / struct) named like the type's last segment
 * whose file declares that namespace. C# file-scoped namespaces (`namespace X;`) are not symbols in this graph,
 * so the namespace is read from the class's file — the few files whose classes share an entity's simple name.
 * One match binds at 0.95; none, or several, leaves the token with its reason. A property binds on the class or,
 * through resolved `EXTENDS` edges, its bases (`Created` lives on `BaseAuditableEntity`); a property the CLR
 * type does not declare (an EF shadow property such as a FK `ConversationId`) stays a token, labelled.
 *
 * Every run re-decides every edge from its token (kept in `reason`), like the SQL resolver: a scoped run and a
 * full one cannot disagree, and a renamed property or a moved namespace rebinds or unbinds on the next run.
 */

export const EF_RESOLVED_REASON_PREFIX = "ef_resolved ";
export const EF_RESOLVED_CONFIDENCE = 0.95;
const MAX_BASE_HOPS = 5;
const CLASS_KINDS = ["class", "record", "struct", "record struct"];

export type EfResolutionStats = { resolved: number; unresolved: number; ambiguous: number };

function tokenOf(toId: string, reason: string | null): string | null {
  if (toId.startsWith(EF_ENTITY_TOKEN_PREFIX) || toId.startsWith(EF_PROPERTY_TOKEN_PREFIX)) return toId;
  const r = reason ?? "";
  const m = /^(?:ef_resolved |unresolved ef token: |ambiguous ef token: )(ef(?:entity|prop):\S+)/.exec(r);
  return m ? m[1]! : null;
}

/** Namespace declarations of a C# file, by line: `namespace X;` covers the file, `namespace X {` what follows. */
function namespacesOf(text: string): { line: number; name: string }[] {
  const out: { line: number; name: string }[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*namespace\s+([A-Za-z_][\w.]*)\s*[;{]?/.exec(lines[i]!);
    if (m) out.push({ line: i + 1, name: m[1]! });
  }
  return out;
}

export function resolveEfMapEdges(db: Database.Database, repoId: string, repoPath: string): EfResolutionStats {
  const stats: EfResolutionStats = { resolved: 0, unresolved: 0, ambiguous: 0 };
  const rows = db
    .prepare(`select rowid as rid, to_id as toId, reason from edges where repo_id = ? and type = 'EF_MAPS' order by rowid`)
    .all(repoId) as { rid: number; toId: string; reason: string | null }[];
  if (rows.length === 0) return stats;

  const classesByName = db.prepare(
    `select symbol_id as symbolId, file_path as filePath, line from symbols
     where repo_id = ? and name = ? and kind in (select value from json_each(?)) order by file_path, line, symbol_id`
  );
  const memberOf = db.prepare(
    `select symbol_id as symbolId from symbols where repo_id = ? and parent_symbol_id = ? and name = ? and kind in ('property', 'variable') order by line, symbol_id limit 1`
  );
  const baseOf = db.prepare(
    `select to_id as toId from edges where repo_id = ? and from_id = ? and type = 'EXTENDS' and to_id not like '%:%' order by to_id limit 1`
  );
  const fileNamespaces = new Map<string, { line: number; name: string }[]>();
  const namespaceAt = (filePath: string, line: number): string | null => {
    let list = fileNamespaces.get(filePath);
    if (!list) {
      try {
        list = namespacesOf(fs.readFileSync(path.join(repoPath, filePath), "utf8"));
      } catch {
        list = [];
      }
      fileNamespaces.set(filePath, list);
    }
    let found: string | null = null;
    for (const n of list) if (n.line <= line) found = n.name;
    return found;
  };
  const classCache = new Map<string, { id: string } | { ambiguous: number } | null>();
  const resolveClass = (fullName: string): { id: string } | { ambiguous: number } | null => {
    const hit = classCache.get(fullName);
    if (hit !== undefined) return hit;
    const cut = Math.max(fullName.lastIndexOf("."), fullName.lastIndexOf("+"));
    const ns = cut >= 0 ? fullName.slice(0, cut) : "";
    const simple = fullName.slice(cut + 1);
    const nested = fullName.includes("+");
    const matches = (classesByName.all(repoId, simple, JSON.stringify(CLASS_KINDS)) as { symbolId: string; filePath: string; line: number }[]).filter((c) => {
      const declared = namespaceAt(c.filePath, c.line);
      // `Outer+Inner`: the namespace is the outer type's; compare the part before the outer type's name.
      return nested ? declared !== null && ns.startsWith(`${declared}.`) : declared === ns;
    });
    const answer = matches.length === 1 ? { id: matches[0]!.symbolId } : matches.length > 1 ? { ambiguous: matches.length } : null;
    classCache.set(fullName, answer);
    return answer;
  };

  const update = db.prepare(`update edges set to_id = ?, confidence = ?, reason = ? where rowid = ?`);
  const tx = db.transaction(() => {
    for (const row of rows) {
      const token = tokenOf(row.toId, row.reason);
      if (!token) continue;
      let target: string | null = null;
      let why = "";
      if (token.startsWith(EF_ENTITY_TOKEN_PREFIX)) {
        const cls = resolveClass(token.slice(EF_ENTITY_TOKEN_PREFIX.length));
        if (cls && "id" in cls) target = cls.id;
        else why = cls ? ` (${String(cls.ambiguous)} classes in that namespace)` : " (no class with that name declares that namespace)";
        if (cls && "ambiguous" in cls) stats.ambiguous += 1;
      } else {
        const rest = token.slice(EF_PROPERTY_TOKEN_PREFIX.length);
        const hash = rest.lastIndexOf("#");
        const cls = resolveClass(rest.slice(0, hash));
        const prop = rest.slice(hash + 1);
        if (cls && "id" in cls) {
          let owner: string | null = cls.id;
          for (let hop = 0; owner && hop <= MAX_BASE_HOPS && !target; hop++) {
            target = (memberOf.get(repoId, owner, prop) as { symbolId: string } | undefined)?.symbolId ?? null;
            owner = target ? null : ((baseOf.get(repoId, owner) as { toId: string } | undefined)?.toId ?? null);
          }
          if (!target) why = " (not declared on the CLR type or its bases: an EF shadow property)";
        } else {
          why = cls ? ` (${String(cls.ambiguous)} classes in that namespace)` : " (the CLR type did not resolve)";
          if (cls) stats.ambiguous += 1;
        }
      }
      if (target) {
        stats.resolved += 1;
        update.run(target, EF_RESOLVED_CONFIDENCE, `${EF_RESOLVED_REASON_PREFIX}${token}`, row.rid);
      } else {
        stats.unresolved += 1;
        const prefix = why.includes("classes in that namespace") ? "ambiguous ef token: " : EF_UNRESOLVED_REASON_PREFIX;
        update.run(token, EF_TOKEN_CONFIDENCE, `${prefix}${token}${why}`, row.rid);
      }
    }
  });
  tx();
  return stats;
}
