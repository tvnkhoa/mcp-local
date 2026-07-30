import type Database from "better-sqlite3";

/**
 * ISSUE-022 — query-layer safety net cho interface-aware caller resolution.
 *
 * Mở rộng một tập symbolId thành các "interface sibling" để BFS callers nhìn xuyên
 * Clean-Architecture DI: caller gọi `_dep.Method()` qua interface nên CALLS edge trỏ vào
 * INTERFACE method, còn người dùng hỏi context của IMPLEMENTATION (hoặc ngược lại).
 *
 * - method có parent class IMPLEMENTS interface → method cùng tên phía interface (via:"interface")
 * - method của interface → methods cùng tên của implementors, cap 20 (via:"interface")
 * - class/struct/record/interface → child members qua parent_symbol_id (via:"member"),
 *   rồi đệ quy 1 cấp sang counterpart phía interface — fix "context pack trên class chỉ
 *   thấy test gọi `new`" (Bug E).
 *
 * Hoạt động cả trên index cũ/partial: match IMPLEMENTS theo to_id đã resolve LẪN
 * placeholder `iface:Name`; fallback file+name khi parent_symbol_id chưa được index.
 */

export type InterfaceSibling = { symbolId: string; via: "interface" | "member" };

const IMPLEMENTOR_CAP = 20;
const TYPE_KINDS = new Set(["class", "struct", "record", "record struct", "interface"]);

type SeedRow = {
  symbolId: string;
  name: string;
  kind: string;
  filePath: string;
  parentSymbolId: string | null;
};

export function expandInterfaceSiblingsImpl(
  db: Database.Database,
  repoId: string,
  seedIds: string[]
): InterfaceSibling[] {
  if (seedIds.length === 0) return [];
  const ph = seedIds.map(() => "?").join(",");
  const seeds = db
    .prepare(
      `select symbol_id as symbolId, name, kind, file_path as filePath, parent_symbol_id as parentSymbolId
       from symbols where repo_id = ? and symbol_id in (${ph})`
    )
    .all(repoId, ...seedIds) as SeedRow[];

  const seen = new Set<string>(seedIds);
  const out: InterfaceSibling[] = [];
  const add = (symbolId: string, via: "interface" | "member") => {
    if (seen.has(symbolId)) return;
    seen.add(symbolId);
    out.push({ symbolId, via });
  };

  const methodSeeds: SeedRow[] = [];
  for (const seed of seeds) {
    if (TYPE_KINDS.has(seed.kind)) {
      const children = db
        .prepare(
          `select symbol_id as symbolId, name, kind, file_path as filePath, parent_symbol_id as parentSymbolId
           from symbols where repo_id = ? and parent_symbol_id = ? and kind in ('method', 'constructor', 'property')`
        )
        .all(repoId, seed.symbolId) as SeedRow[];
      for (const child of children) {
        add(child.symbolId, "member");
        if (child.kind === "method") methodSeeds.push(child);
      }
    } else if (seed.kind === "method") {
      methodSeeds.push(seed);
    }
  }

  for (const method of methodSeeds) {
    const parent = resolveParentType(db, repoId, method);
    if (!parent) continue;

    if (parent.kind === "interface") {
      // interface method → implementing methods (mỗi implementor 1 method cùng tên).
      const implementors = db
        .prepare(
          `select s.symbol_id as symbolId, s.file_path as filePath
           from edges e
           inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
           where e.repo_id = ? and e.type = 'IMPLEMENTS' and (e.to_id = ? or e.to_id = ?)
             and s.kind in ('class', 'struct', 'record', 'record struct')
           -- Ordered before the cap: which implementors survive IMPLEMENTOR_CAP decided which
           -- sibling edges got created, and that was an arbitrary choice. MCP-ISSUE-032.
           order by s.symbol_id, s.file_path
           limit ?`
        )
        .all(repoId, parent.symbolId, `iface:${parent.name}`, IMPLEMENTOR_CAP) as { symbolId: string; filePath: string }[];
      for (const impl of implementors) {
        const sibling = findMemberMethod(db, repoId, impl.symbolId, impl.filePath, method.name);
        if (sibling) add(sibling, "interface");
      }
    } else {
      // implementation method → interface method cùng tên trên mỗi interface mà class implements.
      // `limit 10` with no ORDER BY: a class implementing more than 10 interfaces handed SQLite a free
      // choice of which 10, and it chose differently between runs as the table's physical layout
      // shifted. This was the single largest contributor to the run-to-run edge drift —
      // `interface-dispatch` accounted for 99 of the 120 edges present in one run and absent in the next.
      const ifaceEdges = db
        .prepare(
          `select to_id as toId from edges
           where repo_id = ? and from_id = ? and type = 'IMPLEMENTS'
           order by to_id
           limit 10`
        )
        .all(repoId, parent.symbolId) as { toId: string }[];
      for (const edge of ifaceEdges) {
        const iface = edge.toId.startsWith("iface:")
          ? // Name lookup, so more than one file can declare `IFoo`. Ordered by symbol_id to pick the
            // same one every time; unordered, `limit 1` meant the sibling edges pointed at a different
            // declaration from run to run.
            (db
              .prepare(
                `select symbol_id as symbolId, file_path as filePath from symbols
                 where repo_id = ? and name = ? and kind = 'interface'
                 order by symbol_id
                 limit 1`
              )
              .get(repoId, edge.toId.slice("iface:".length)) as { symbolId: string; filePath: string } | undefined)
          : // symbol_id is the primary key — at most one row, so no ordering is needed here.
            (db
              .prepare(`select symbol_id as symbolId, file_path as filePath from symbols where repo_id = ? and symbol_id = ? and kind = 'interface' limit 1`)
              .get(repoId, edge.toId) as { symbolId: string; filePath: string } | undefined);
        if (!iface) continue;
        const sibling = findMemberMethod(db, repoId, iface.symbolId, iface.filePath, method.name);
        if (sibling) add(sibling, "interface");
      }
    }
  }

  return out;
}

/** Parent type của method — ưu tiên parent_symbol_id, fallback type gần nhất phía trên trong cùng file (index cũ chưa có linkage). */
function resolveParentType(
  db: Database.Database,
  repoId: string,
  method: SeedRow
): { symbolId: string; name: string; kind: string } | null {
  if (method.parentSymbolId) {
    const parent = db
      .prepare(`select symbol_id as symbolId, name, kind from symbols where repo_id = ? and symbol_id = ? limit 1`)
      .get(repoId, method.parentSymbolId) as { symbolId: string; name: string; kind: string } | undefined;
    if (parent && TYPE_KINDS.has(parent.kind)) return parent;
  }
  const fallback = db
    .prepare(
      // `line desc` alone is not a total order: two types can be declared on the same line (nested
      // generic declarations, single-line records), and then the winner was arbitrary.
      `select symbol_id as symbolId, name, kind from symbols
       where repo_id = ? and file_path = ? and kind in ('class', 'struct', 'record', 'record struct', 'interface')
       order by line desc, symbol_id
       limit 1`
    )
    .get(repoId, method.filePath) as { symbolId: string; name: string; kind: string } | undefined;
  return fallback ?? null;
}

/** Method `name` thuộc type `typeSymbolId` — ưu tiên parent linkage, fallback name+file. */
function findMemberMethod(
  db: Database.Database,
  repoId: string,
  typeSymbolId: string,
  typeFilePath: string,
  name: string
): string | null {
  // Both lookups are name-based, and C# permits OVERLOADS — several methods with this exact name under
  // the same parent. `limit 1` therefore picks one of several valid rows, and unordered it picked
  // differently between runs. Ordering does not make the choice *correct* (see the note below), but it
  // makes it the same choice every time, which is the difference between a wrong edge and a wrong edge
  // that also moves.
  const byParent = db
    .prepare(
      `select symbol_id as symbolId from symbols
       where repo_id = ? and parent_symbol_id = ? and name = ? and kind = 'method'
       order by symbol_id
       limit 1`
    )
    .get(repoId, typeSymbolId, name) as { symbolId: string } | undefined;
  if (byParent) return byParent.symbolId;
  const byFile = db
    .prepare(
      `select symbol_id as symbolId from symbols
       where repo_id = ? and file_path = ? and name = ? and kind = 'method'
       order by symbol_id
       limit 1`
    )
    .get(repoId, typeFilePath, name) as { symbolId: string } | undefined;
  return byFile?.symbolId ?? null;
}
