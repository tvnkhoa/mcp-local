import type Parser from "tree-sitter";

import type { EdgeRecord, SymbolRecord } from "../../types/index.js";
import type { ExtractInput } from "./extractorTypes.js";
import { makeSymbolId } from "./extractorPrimitives.js";
import { SQL_SIGNATURE_SEPARATOR, SQL_TOKEN_CONFIDENCE, SQL_TOKEN_PREFIX, SQL_UNRESOLVED_REASON_PREFIX } from "./sqlExtractor.js";

/**
 * Release L3 (MCP-ISSUE-092): the EF Core lane. An EF repo keeps its CURRENT relational model in one file per
 * DbContext, `<Context>ModelSnapshot.cs` — `BuildModel` re-states every table, column, key, index and FK after
 * each migration. wec.communication-hub has 62 migration `.cs` files and no `.sql`, so before this lane the
 * graph had no table at all there.
 *
 * ## What defines, and what never does
 *
 * Only a class that derives from `ModelSnapshot` and carries `[DbContext(typeof(X))]` — decided from the AST,
 * not the file name. Migrations (`: Migration`, `Up`/`Down`) are history and `*.Designer.cs`
 * (`[Migration]`, `BuildTargetModel`) is a per-migration snapshot: both stay plain C# and never emit a
 * `sql_*` symbol, so neither can compete with the snapshot as "current".
 *
 * ## The output — the SQL lane's kinds, so every SQL reader works unchanged
 *
 * - `sql_table` per mapped table, `sql_column` per column (owned types' columns join the table they split
 *   into), `sql_index` per `HasIndex`, `sql_sequence` per `HasSequence`, a `sql_statement` per check constraint.
 *   Signatures end `[EF <Context>: <CLR type>]`.
 * - `SQL_REFERENCES` from a FK column to the principal's table, `SQL_USES` from an index / check to its table:
 *   `sql*:` tokens `resolveSqlEdges` binds like any other.
 * - `EF_MAPS` from the table to its CLR type and from a column to its property, as `efentity:` / `efprop:`
 *   tokens `resolveEfMapEdges` binds by namespace-qualified name.
 * - A construct CommHub does not use (owned collections, TPH, views, table splitting by `SplitToTable`, seed
 *   data, alternate / principal keys, comments, a default schema) becomes a `sql_gap` naming it — never a
 *   silent drop.
 */

export const EF_ENTITY_TOKEN_PREFIX = "efentity:";
export const EF_PROPERTY_TOKEN_PREFIX = "efprop:";
/** Reason prefix of an `EF_MAPS` edge no CLR symbol has (yet) matched; the token follows it. */
export const EF_UNRESOLVED_REASON_PREFIX = "unresolved ef token: ";
export const EF_TOKEN_CONFIDENCE = 0.5;

/** Builder calls that state nothing about the relational model (navigations, the owned type's back-link, annotations). */
const IGNORED_HEADS = new Set(["Navigation", "WithOwner", "HasAnnotation"]);

const UNSUPPORTED = new Set([
  "OwnsMany", "HasDiscriminator", "HasBaseType", "ToView", "ToSqlQuery", "ToFunction", "SplitToTable", "HasData",
  "HasAlternateKey", "HasPrincipalKey", "HasComment", "HasDefaultSchema", "HasNoKey", "HasQueryFilter"
]);

type Call = { name: string; args: Parser.SyntaxNode[]; node: Parser.SyntaxNode };
type Chain = { root: string; calls: Call[] };

type EfColumn = { property: string; column: string; type: string | null; required: boolean; maxLength: string | null; defaultValue: string | null; concurrency: boolean; row: number; ownerType: string };
type EfIndex = { columns: string[]; name: string | null; unique: boolean; filter: string | null; method: string | null; row: number };
type EfForeignKey = { principalType: string; properties: string[]; constraintName: string | null; row: number };
type EfEntity = {
  type: string;
  row: number;
  table: string | null;
  schema: string | null;
  tableRow: number;
  columns: EfColumn[];
  keys: string[];
  indexes: EfIndex[];
  checks: { name: string; expression: string; row: number }[];
  fks: EfForeignKey[];
  /** Owned types split into a table: their columns, and the table they name. */
  owned: { type: string; table: string | null; columns: EfColumn[]; row: number }[];
  gaps: { construct: string; row: number }[];
};

/** `a.B<T>("x").C(1).D()` → root `a`, calls B, C, D in order. */
function flattenChain(node: Parser.SyntaxNode): Chain | null {
  const calls: Call[] = [];
  let cur: Parser.SyntaxNode | null = node;
  while (cur && cur.type === "invocation_expression") {
    const fn = cur.childForFieldName("function");
    const argList = cur.childForFieldName("arguments");
    if (!fn || fn.type !== "member_access_expression") return null;
    const nameNode = fn.childForFieldName("name");
    const name = nameNode?.type === "generic_name" ? (nameNode.namedChildren[0]?.text ?? "") : (nameNode?.text ?? "");
    calls.unshift({ name, args: argList ? argList.namedChildren.filter((a) => a.type === "argument").map((a) => a.namedChildren[0] ?? a) : [], node: cur });
    cur = fn.childForFieldName("expression");
  }
  if (!cur) return null;
  return { root: cur.text, calls };
}

function stringArg(node: Parser.SyntaxNode | undefined): string | null {
  if (!node) return null;
  if (node.type === "string_literal" || node.type === "verbatim_string_literal" || node.type === "raw_string_literal") {
    const content = node.namedChildren.filter((c) => c.type === "string_literal_content").map((c) => c.text).join("");
    return node.namedChildren.length > 0 ? content : node.text.replace(/^@?"|"$/g, "");
  }
  return null;
}

/** The genric type argument of `Property<T>` as written (`DateTimeOffset?`). */
function typeArgOf(call: Call): string | null {
  const fn = call.node.childForFieldName("function");
  const nameNode = fn?.childForFieldName("name");
  const list = nameNode?.type === "generic_name" ? nameNode.namedChildren.find((c) => c.type === "type_argument_list") : null;
  return list ? list.namedChildren.map((c) => c.text).join(", ") : null;
}

/** The statements of a lambda argument's block body (`b => { … }`), with its parameter name. */
function lambdaBody(node: Parser.SyntaxNode | undefined): { param: string; statements: Parser.SyntaxNode[] } | null {
  if (!node || node.type !== "lambda_expression") return null;
  const params = node.childForFieldName("parameters");
  const param = params ? params.text.replace(/[()\s]/g, "") : "";
  const body = node.childForFieldName("body");
  if (!body) return null;
  if (body.type === "block") return { param, statements: body.namedChildren.filter((c) => c.type === "expression_statement") };
  return { param, statements: [body] };
}

function chainOfStatement(statement: Parser.SyntaxNode): Chain | null {
  const expr = statement.type === "expression_statement" ? statement.namedChildren[0] : statement;
  return expr && expr.type === "invocation_expression" ? flattenChain(expr) : null;
}

function newEntity(type: string, row: number): EfEntity {
  return { type, row, table: null, schema: null, tableRow: row, columns: [], keys: [], indexes: [], checks: [], fks: [], owned: [], gaps: [] };
}

function readProperty(chain: Chain, ownerType: string): EfColumn | null {
  const head = chain.calls[0]!;
  const property = stringArg(head.args[0]);
  if (!property) return null;
  const col: EfColumn = { property, column: property, type: typeArgOf(head), required: false, maxLength: null, defaultValue: null, concurrency: false, row: head.node.startPosition.row, ownerType };
  let columnType: string | null = null;
  for (const c of chain.calls.slice(1)) {
    if (c.name === "HasColumnName") col.column = stringArg(c.args[0]) ?? col.column;
    else if (c.name === "HasColumnType") columnType = stringArg(c.args[0]);
    else if (c.name === "IsRequired") col.required = c.args.length === 0 || c.args[0]!.text === "true";
    else if (c.name === "HasMaxLength") col.maxLength = c.args[0]?.text ?? null;
    else if (c.name === "HasDefaultValue") col.defaultValue = c.args[0]?.text ?? null;
    else if (c.name === "HasDefaultValueSql") col.defaultValue = `sql ${c.args[0]?.text ?? ""}`;
    else if (c.name === "IsConcurrencyToken") col.concurrency = true;
  }
  // The CLR type as written decides nullability for value types (`int?`) — EF's own rule; reference types
  // are optional unless IsRequired.
  if (col.type && /^(bool|byte|short|int|long|float|double|decimal|Guid|DateTime|DateTimeOffset|DateOnly|TimeOnly|TimeSpan|char)$/.test(col.type)) col.required = true;
  col.type = columnType ?? col.type;
  return col;
}

function readEntityBlock(statements: Parser.SyntaxNode[], param: string, entity: EfEntity, ownerTable: { owned?: EfEntity["owned"][number] }): void {
  for (const statement of statements) {
    const chain = chainOfStatement(statement);
    if (!chain || chain.calls.length === 0) continue;
    const head = chain.calls[0]!;
    const row = head.node.startPosition.row;
    const target = ownerTable.owned;
    if (chain.root !== param) {
      // A provider extension over something the block already declared annotates it:
      // `NpgsqlIndexBuilderExtensions.HasMethod(b.HasIndex("X"), "gin")` is the index method (kept);
      // `HasOperators`, SQL Server `IsClustered` / `IncludeProperties` and
      // `SqlServerPropertyBuilderExtensions.UseIdentityColumn(b.Property<int>("Id"))` add nothing the graph models,
      // and are not gaps either — the index or column itself is modelled (wec.be: 322 identity calls). A provider
      // call over something NOT declared, or any other static call on the builder, is a gap.
      const inner = head.args[0]?.type === "invocation_expression" ? flattenChain(head.args[0]) : null;
      const innerHead = inner && inner.root === param ? inner.calls[0] : undefined;
      if (innerHead?.name === "HasIndex" && /IndexBuilderExtensions$/.test(chain.root)) {
        const cols = innerHead.args.map((a) => stringArg(a)).filter((x): x is string => x !== null).join("|");
        const idx = entity.indexes.find((i) => i.columns.join("|") === cols);
        if (!idx) entity.gaps.push({ construct: `${chain.root}.${head.name}`, row });
        else if (head.name === "HasMethod") idx.method = stringArg(head.args[1]);
      } else if ((innerHead?.name === "Property" || innerHead?.name === "PrimitiveCollection") && /PropertyBuilderExtensions$/.test(chain.root)) {
        const prop = stringArg(innerHead.args[0]);
        if (!(target ? target.columns : entity.columns).some((c) => c.property === prop)) entity.gaps.push({ construct: `${chain.root}.${head.name}`, row });
      } else if (statement.text.includes(`${param}.`)) {
        entity.gaps.push({ construct: `${chain.root}.${head.name}`, row });
      }
      continue;
    }
    if (head.name === "Property" || head.name === "PrimitiveCollection") {
      const col = readProperty(chain, target ? target.type : entity.type);
      if (col) (target ? target.columns : entity.columns).push(col);
    } else if (head.name === "HasKey") {
      if (!target) entity.keys = head.args.map((a) => stringArg(a)).filter((x): x is string => x !== null);
    } else if (head.name === "HasIndex") {
      const idx: EfIndex = { columns: head.args.map((a) => stringArg(a)).filter((x): x is string => x !== null), name: null, unique: false, filter: null, method: null, row };
      for (const c of chain.calls.slice(1)) {
        if (c.name === "IsUnique") idx.unique = c.args.length === 0 || c.args[0]!.text === "true";
        else if (c.name === "HasDatabaseName" || c.name === "HasName") idx.name = stringArg(c.args[0]);
        else if (c.name === "HasFilter") idx.filter = stringArg(c.args[0]);
      }
      if (!target) entity.indexes.push(idx);
    } else if (head.name === "ToTable") {
      const table = stringArg(head.args[0]);
      if (target) target.table = table;
      else {
        entity.table = table;
        entity.tableRow = row;
        const schemaArg = head.args[1];
        entity.schema = schemaArg && schemaArg.type !== "lambda_expression" ? stringArg(schemaArg) : null;
        const tableLambda = lambdaBody(head.args.find((a) => a.type === "lambda_expression"));
        for (const s of tableLambda?.statements ?? []) {
          const tc = chainOfStatement(s);
          const check = tc?.calls[0];
          if (tc && tc.root === tableLambda!.param && check?.name === "HasCheckConstraint") {
            entity.checks.push({ name: stringArg(check.args[0]) ?? "", expression: stringArg(check.args[1]) ?? "", row: check.node.startPosition.row });
          }
        }
      }
    } else if (head.name === "HasOne") {
      const principal = stringArg(head.args[0]);
      const fkCall = chain.calls.find((c) => c.name === "HasForeignKey");
      if (principal && fkCall) {
        const strings = fkCall.args.map((a) => stringArg(a)).filter((x): x is string => x !== null);
        // HasForeignKey("Dependent.Type", "Prop") on a one-to-one names the dependent first.
        const properties = strings.length > 1 && strings[0]!.includes(".") ? strings.slice(1) : strings;
        const constraintName = stringArg(chain.calls.find((c) => c.name === "HasConstraintName")?.args[0]);
        if (!target) entity.fks.push({ principalType: principal, properties, constraintName, row });
      }
    } else if (head.name === "OwnsOne") {
      const ownedType = stringArg(head.args[0]);
      const lambda = lambdaBody(head.args.find((a) => a.type === "lambda_expression"));
      if (ownedType && lambda) {
        const owned = { type: ownedType, table: null as string | null, columns: [] as EfColumn[], row };
        readEntityBlock(lambda.statements, lambda.param, entity, { owned });
        entity.owned.push(owned);
      }
    } else if (!IGNORED_HEADS.has(head.name)) {
      entity.gaps.push({ construct: head.name, row });
    }
  }
}

/**
 * Release L3: the snapshot's model, or null when the file holds no `ModelSnapshot` class. Pure over the AST,
 * so the extractor and the ground-truth check read the same facts.
 */
export function readEfSnapshot(root: Parser.SyntaxNode): { context: string; entities: EfEntity[]; sequences: { name: string; row: number }[]; gaps: { construct: string; row: number }[] } | null {
  for (const cls of root.descendantsOfType("class_declaration")) {
    const bases = cls.namedChildren.find((c) => c.type === "base_list");
    if (!bases || !bases.namedChildren.some((b) => b.text === "ModelSnapshot" || b.text.endsWith(".ModelSnapshot"))) continue;
    let context: string | null = null;
    for (const attr of cls.descendantsOfType("attribute")) {
      if (attr.namedChildren[0]?.text !== "DbContext") continue;
      const typeOf = attr.descendantsOfType("typeof_expression")[0];
      context = typeOf?.namedChildren[0]?.text ?? null;
    }
    if (!context) continue;
    const method = cls.descendantsOfType("method_declaration").find((m) => m.childForFieldName("name")?.text === "BuildModel");
    const body = method?.childForFieldName("body");
    if (!method || !body) continue;
    const modelParam = method.childForFieldName("parameters")?.namedChildren[0]?.childForFieldName("name")?.text ?? "modelBuilder";
    const byType = new Map<string, EfEntity>();
    const sequences: { name: string; row: number }[] = [];
    const gaps: { construct: string; row: number }[] = [];
    for (const statement of body.namedChildren) {
      const chain = chainOfStatement(statement);
      if (!chain || chain.root !== modelParam || chain.calls.length === 0) continue;
      const head = chain.calls[0]!;
      if (head.name === "Entity") {
        const type = stringArg(head.args[0]);
        const lambda = lambdaBody(head.args.find((a) => a.type === "lambda_expression"));
        if (!type || !lambda) continue;
        // The snapshot states an entity in several blocks (columns first, relationships later): merge them.
        const entity = byType.get(type) ?? newEntity(type, head.node.startPosition.row);
        byType.set(type, entity);
        readEntityBlock(lambda.statements, lambda.param, entity, {});
      } else if (head.name === "HasSequence") {
        const name = stringArg(head.args[0]);
        if (name) sequences.push({ name, row: head.node.startPosition.row });
      } else if (UNSUPPORTED.has(head.name)) {
        gaps.push({ construct: head.name, row: head.node.startPosition.row });
      }
    }
    return { context, entities: [...byType.values()], sequences, gaps };
  }
  return null;
}

const MAX_SIGNATURE = 200;
const clip = (s: string): string => (s.length > MAX_SIGNATURE ? `${s.slice(0, MAX_SIGNATURE - 1)}…` : s);

/** Emit the snapshot's model into `symbols` / `edges`. Returns false (and emits nothing) for any other file. */
export function extractEfSnapshotImpl(input: ExtractInput, root: Parser.SyntaxNode, symbols: SymbolRecord[], edges: EdgeRecord[]): boolean {
  const model = readEfSnapshot(root);
  if (!model) return false;
  const tag = (type: string): string => ` [EF ${model.context}: ${type}]`;
  const edgeKeys = new Set<string>();
  const edge = (fromId: string, toId: string, type: EdgeRecord["type"], reason: string, confidence: number): void => {
    const key = `${fromId}\u0000${toId}\u0000${type}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ repoId: input.repoId, fromId, toId, type, confidence, reason });
  };
  const define = (kind: string, name: string, row: number, signature: string, parentSymbolId?: string): string => {
    const symbolId = makeSymbolId(input, kind, name, row);
    symbols.push({ repoId: input.repoId, symbolId, filePath: input.filePath, name, kind: kind as SymbolRecord["kind"], line: row + 1, endLine: row + 1, signature: clip(signature), ...(parentSymbolId && { parentSymbolId }) });
    return symbolId;
  };
  const sqlRef = (fromId: string, tokenKind: "table" | "column", name: string, type: "SQL_USES" | "SQL_REFERENCES", clause: string): void =>
    edge(fromId, `${SQL_TOKEN_PREFIX[tokenKind]}${name}`, type, `${SQL_UNRESOLVED_REASON_PREFIX}${clause}`, SQL_TOKEN_CONFIDENCE);
  const efRef = (fromId: string, token: string): void => edge(fromId, token, "EF_MAPS", `${EF_UNRESOLVED_REASON_PREFIX}${token}`, EF_TOKEN_CONFIDENCE);

  const tableOf = new Map(model.entities.filter((e) => e.table).map((e) => [e.type, e.schema ? `${e.schema}.${e.table}` : e.table!]));

  for (const entity of model.entities) {
    for (const g of entity.gaps) define("sql_gap", `gap: ${g.construct} ${entity.type}`, g.row, `not modelled: ${g.construct}${tag(entity.type)}`);
    if (!entity.table) {
      define("sql_gap", `gap: no table ${entity.type}`, entity.row, `not modelled: entity without ToTable${tag(entity.type)}`);
      continue;
    }
    const qualified = tableOf.get(entity.type)!;
    // Owned columns split into this table join it; the owned key repeats the owner's key column — first wins.
    const columns: EfColumn[] = [];
    const seen = new Set<string>();
    for (const c of [...entity.columns, ...entity.owned.filter((o) => o.table === null || o.table === entity.table).flatMap((o) => o.columns)]) {
      if (seen.has(c.column)) continue;
      seen.add(c.column);
      columns.push(c);
    }
    for (const o of entity.owned.filter((x) => x.table !== null && x.table !== entity.table)) {
      define("sql_gap", `gap: OwnsOne into ${o.table ?? "?"} ${o.type}`, o.row, `not modelled: owned type mapped to another table${tag(o.type)}`);
    }
    const keyColumns = new Set(entity.keys.map((k) => entity.columns.find((c) => c.property === k)?.column ?? k));
    const tableId = define(
      "sql_table",
      entity.table,
      entity.tableRow,
      `${qualified}${SQL_SIGNATURE_SEPARATOR}table (${String(columns.length)} columns${entity.checks.length > 0 ? `, ${String(entity.checks.length)} checks` : ""})${tag(entity.type)}`
    );
    efRef(tableId, `${EF_ENTITY_TOKEN_PREFIX}${entity.type}`);
    const columnIds = new Map<string, string>();
    for (const c of columns) {
      const traits = [c.required ? "not null" : null, keyColumns.has(c.column) ? "primary key" : null, c.maxLength ? `max ${c.maxLength}` : null, c.defaultValue ? `default ${c.defaultValue}` : null, c.concurrency ? "concurrency token" : null]
        .filter(Boolean)
        .join(", ");
      const id = define("sql_column", c.column, c.row, `${qualified}.${c.column}${SQL_SIGNATURE_SEPARATOR}column ${c.type ?? "?"}${traits ? ` (${traits})` : ""}${tag(`${c.ownerType}.${c.property}`)}`, tableId);
      columnIds.set(c.property, id);
      efRef(id, `${EF_PROPERTY_TOKEN_PREFIX}${c.ownerType}#${c.property}`);
    }
    for (const idx of entity.indexes) {
      const cols = idx.columns.map((p) => entity.columns.find((c) => c.property === p)?.column ?? p);
      const name = idx.name ?? `ix_${entity.table}_${cols.join("_")}`;
      const id = define("sql_index", name, idx.row, `${entity.schema ? `${entity.schema}.${name}` : name}${SQL_SIGNATURE_SEPARATOR}${idx.unique ? "unique index" : "index"} on ${qualified} (${cols.join(", ")})${idx.method ? ` using ${idx.method}` : ""}${idx.filter ? ` where ${idx.filter}` : ""}${tag(entity.type)}`);
      sqlRef(id, "table", qualified, "SQL_USES", "index on (EF)");
      for (const c of cols) sqlRef(id, "column", `${qualified}.${c}`, "SQL_USES", "index column (EF)");
    }
    for (const check of entity.checks) {
      const id = define("sql_statement", `constraint ${check.name}`, check.row, `check (${check.expression})${tag(entity.type)}`, tableId);
      sqlRef(id, "table", qualified, "SQL_USES", "check constraint (EF)");
    }
    for (const fk of entity.fks) {
      const principal = tableOf.get(fk.principalType) ?? fk.principalType;
      for (const p of fk.properties) {
        const from = columnIds.get(p) ?? tableId;
        sqlRef(from, "table", principal, "SQL_REFERENCES", `fk ${qualified}.${entity.columns.find((c) => c.property === p)?.column ?? p}${fk.constraintName ? ` ${fk.constraintName}` : ""} (EF)`);
      }
    }
  }
  for (const s of model.sequences) define("sql_sequence", s.name, s.row, `${s.name}${SQL_SIGNATURE_SEPARATOR}sequence [EF ${model.context}]`);
  for (const g of model.gaps) define("sql_gap", `gap: ${g.construct}`, g.row, `not modelled: ${g.construct} [EF ${model.context}]`);
  return true;
}
