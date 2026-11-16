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
  signature: string | null;
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
      `select symbol_id as symbolId, name, kind, file_path as filePath, parent_symbol_id as parentSymbolId, signature
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
          `select symbol_id as symbolId, name, kind, file_path as filePath, parent_symbol_id as parentSymbolId, signature
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
           order by s.file_path, s.symbol_id
           limit ?`
        )
        .all(repoId, parent.symbolId, `iface:${parent.name}`, IMPLEMENTOR_CAP) as { symbolId: string; filePath: string }[];
      for (const impl of implementors) {
        const sibling = findMemberMethod(db, repoId, impl.symbolId, impl.filePath, method.name, method.signature)
          ?? findInheritedMemberMethod(db, repoId, impl.symbolId, method.name, method.signature);
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
          ? // Name lookup, so more than one file can declare `IFoo`. Ordered to pick the same one every
            // time; unordered, `limit 1` meant the sibling edges pointed at a different declaration from
            // run to run. File first (MCP-ISSUE-101 part 4): a line shift re-mints the id, not the path.
            (db
              .prepare(
                `select symbol_id as symbolId, file_path as filePath from symbols
                 where repo_id = ? and name = ? and kind = 'interface'
                 order by file_path, symbol_id
                 limit 1`
              )
              .get(repoId, edge.toId.slice("iface:".length)) as { symbolId: string; filePath: string } | undefined)
          : // symbol_id is the primary key — at most one row, so no ordering is needed here.
            (db
              .prepare(`select symbol_id as symbolId, file_path as filePath from symbols where repo_id = ? and symbol_id = ? and kind = 'interface' limit 1`)
              .get(repoId, edge.toId) as { symbolId: string; filePath: string } | undefined);
        if (!iface) continue;
        const sibling = findMemberMethod(db, repoId, iface.symbolId, iface.filePath, method.name, method.signature);
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

/** A same-named method row, as `pickOwnedMethod` weighs it. */
export type MemberCandidate = { symbolId: string; filePath: string; parentSymbolId: string | null; signature: string | null };

/**
 * The parameter count of `name`'s declaration in a stored signature, or null when it cannot be read.
 *
 * Counts top-level commas inside the parameter list, so `Dictionary<string, int>`, `(int, int)` tuples, array
 * and object literals in defaults, and strings do not add parameters. An arrow (`=>`) in a TypeScript default
 * is not a closing `>`.
 */
export function parameterCount(signature: string | null, name: string): number | null {
  if (!signature) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = new RegExp(`(?:^|[^\\w$])${escaped}\\s*(?:<[^()]*>)?\\s*\\(`).exec(signature);
  if (!head) return null;
  let i = head.index + head[0].length;
  let depth = 0;
  let commas = 0;
  let quote: string | null = null;
  let sawContent = false;
  for (; i < signature.length; i++) {
    const ch = signature[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      sawContent = true;
    } else if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ">" && signature[i - 1] === "=") continue;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") {
      if (depth === 0) {
        if (ch !== ")") return null;
        return sawContent ? commas + 1 : 0;
      }
      depth--;
    } else if (ch === "," && depth === 0) commas++;
    else if (!/\s/.test(ch)) sawContent = true;
  }
  return null;
}

/**
 * MCP-ISSUE-133: the method `name` that type `ownerId` declares — never another type's from the same file.
 *
 * `candidates` are same-named method rows in a stable order. The owner link decides; the owner's file is
 * consulted only for rows with NO owner link (an index written before `parent_symbol_id`), because a row
 * that names a different owner is that owner's method — a sibling class, a nested type — and binding to it
 * attributes the call to code the dispatch never runs. Among the owner's overloads, the first whose
 * parameter count equals `arity` wins; with no arity, or no fit, the first.
 */
export function pickOwnedMethod<T extends MemberCandidate>(
  candidates: readonly T[],
  ownerId: string,
  ownerFile: string,
  name: string,
  arity: number | null
): T | undefined {
  const owned = candidates.filter((c) => c.parentSymbolId === ownerId);
  const pool = owned.length > 0 ? owned : candidates.filter((c) => c.parentSymbolId === null && c.filePath === ownerFile);
  if (pool.length > 1 && arity !== null) {
    const fit = pool.find((c) => parameterCount(c.signature, name) === arity);
    if (fit) return fit;
  }
  return pool[0];
}

/** MCP-ISSUE-133 (row #10): a class's in-repo base class and the file that declares it. */
export type ClassBase = { baseId: string; filePath: string };

/** How far up a base chain dispatch looks — a guard against bad data, not a real hierarchy depth. */
const MAX_BASE_CHAIN = 16;

/**
 * MCP-ISSUE-133 (row #10): the method `name` an implementer RUNS — its own declaration, else the first one up its
 * in-repo base chain (`class Impl : Base, IFoo` where only `Base` declares the method). Walking upward from the
 * implementer, the most-derived declaration wins, so an override in the middle of the chain beats the abstract
 * root. Every step binds by owner exactly as `pickOwnedMethod` does; a cycle or a chain past MAX_BASE_CHAIN stops.
 */
export function pickInheritedMethod<T extends MemberCandidate>(
  candidates: readonly T[],
  baseOf: (typeId: string) => ClassBase | undefined,
  ownerId: string,
  ownerFile: string,
  name: string,
  arity: number | null
): T | undefined {
  const seen = new Set<string>();
  let type: ClassBase | undefined = { baseId: ownerId, filePath: ownerFile };
  for (let depth = 0; type && depth <= MAX_BASE_CHAIN && !seen.has(type.baseId); depth++) {
    seen.add(type.baseId);
    const own = pickOwnedMethod(candidates, type.baseId, type.filePath, name, arity);
    if (own) return own;
    type = baseOf(type.baseId);
  }
  return undefined;
}

/**
 * The first resolved in-repo base class of `classId` (rowid = extraction order), or undefined. Python classes
 * are skipped: their dispatch walks the C3 MRO in edgeResolverCalls, not this single chain.
 */
function classBaseOf(db: Database.Database, repoId: string, classId: string): ClassBase | undefined {
  return db
    .prepare(
      `select e.to_id as baseId, b.file_path as filePath
       from edges e
       inner join symbols c on c.repo_id = e.repo_id and c.symbol_id = e.from_id
       inner join symbols b on b.repo_id = e.repo_id and b.symbol_id = e.to_id
       where e.repo_id = ? and e.from_id = ? and e.type = 'EXTENDS' and e.to_id not like 'base:%'
         and b.kind in ('class', 'struct', 'record', 'record struct')
         and lower(c.file_path) not like '%.py' and lower(c.file_path) not like '%.pyi'
       order by e.rowid
       limit 1`
    )
    .get(repoId, classId) as ClassBase | undefined;
}

/** Method `name` thuộc type `typeSymbolId` — parent linkage; name+file only for rows with no parent (MCP-ISSUE-133). */
function findMemberMethod(
  db: Database.Database,
  repoId: string,
  typeSymbolId: string,
  typeFilePath: string,
  name: string,
  sourceSignature: string | null
): string | null {
  // Ordered so the choice among rows is the same every run (MCP-ISSUE-032); `pickOwnedMethod` then makes it
  // the right one: the owner's own method, the overload with the source method's arity.
  const rows = db
    .prepare(
      `select symbol_id as symbolId, file_path as filePath, parent_symbol_id as parentSymbolId, signature from symbols
       where repo_id = ? and name = ? and kind = 'method' and (parent_symbol_id = ? or (parent_symbol_id is null and file_path = ?))
       order by symbol_id`
    )
    .all(repoId, name, typeSymbolId, typeFilePath) as MemberCandidate[];
  return pickOwnedMethod(rows, typeSymbolId, typeFilePath, name, parameterCount(sourceSignature, name))?.symbolId ?? null;
}

/** MCP-ISSUE-133 (row #10): `name` declared up `typeSymbolId`'s in-repo base chain — what dispatch binds, too. */
function findInheritedMemberMethod(
  db: Database.Database,
  repoId: string,
  typeSymbolId: string,
  name: string,
  sourceSignature: string | null
): string | null {
  const first = classBaseOf(db, repoId, typeSymbolId);
  if (!first) return null;
  // Same row order as the dispatch rebuild's per-name list, so both pick the same overload.
  const rows = db
    .prepare(
      `select symbol_id as symbolId, file_path as filePath, parent_symbol_id as parentSymbolId, signature from symbols
       where repo_id = ? and name = ? and kind = 'method'
       order by file_path, symbol_id`
    )
    .all(repoId, name) as MemberCandidate[];
  const baseOf = (id: string) => classBaseOf(db, repoId, id);
  return pickInheritedMethod(rows, baseOf, first.baseId, first.filePath, name, parameterCount(sourceSignature, name))?.symbolId ?? null;
}
