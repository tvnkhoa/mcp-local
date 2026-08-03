import fs from "node:fs";

import Parser from "tree-sitter";

import type { GraphStore } from "../../repositories/graphStore.js";
import { parseCSharpOnDemand } from "../extractors/treeSitterExtractor.js";
import {
  normalizeRelativePath,
  assertSafeRepoFilePath,
  inferLanguageFromPath,
  offsetToLine
} from "../refactor/refactorUtils.js";

/**
 * ENH-029-C — EF/persistence-aware lane (`get_persistence_mapping`).
 *
 * The risky layer in this EF-heavy codebase is persistence, which the symbol graph can't see:
 * whether a property has a value converter, its column name / max length, the CHECK constraint, and
 * the **EF projection trap** — a converted enum only materializes the CLR type *after* `.ToListAsync()`,
 * so calling the converter inside an EF-translated `.Select()`/`.Where()` breaks at runtime.
 *
 * Mappings are computed on demand by parsing the EF configuration files for the requested property
 * (rule/AST-based, llmInvolved=false). This avoids persisting a new edge/table lane through the
 * indexing pipeline for what is a targeted, per-property lookup.
 */

export type EfPropertyMapping = {
  ownerType: string | null;
  property: string;
  columnName: string | null;
  hasConverter: boolean;
  converterExpression: string | null;
  maxLength: number | null;
  filePath: string;
  line: number;
};

export type EfCheckConstraint = {
  name: string | null;
  expression: string;
  filePath: string;
  line: number;
};

export type EfProjectionWarning = {
  code: "DB_TRANSLATED_PROJECTION";
  property: string;
  operator: "Select" | "Where";
  filePath: string;
  line: number;
  snippet: string;
  detail: string;
};

const MATERIALIZERS = new Set([
  "ToList", "ToListAsync", "ToArray", "ToArrayAsync", "AsEnumerable", "AsAsyncEnumerable",
  "ToHashSet", "ToDictionary", "First", "FirstOrDefault", "Single", "SingleOrDefault", "Last", "LastOrDefault"
]);
const PROJECTION_OPERATORS = new Set(["Select", "Where"]);
const MAX_FILES_SCANNED = 800;

function isEfConfigCandidate(filePath: string): boolean {
  const p = filePath.toLowerCase();
  return /\/configurations?\//.test(p) || p.endsWith("configuration.cs") || p.endsWith("config.cs") || p.includes("dbcontext");
}

/** Method name of an `invocation_expression` whose function is a member access (`a.b.M(...)` → "M"). */
function invocationMethodName(invocation: Parser.SyntaxNode): string | null {
  const fn = invocation.childForFieldName("function");
  if (!fn || fn.type !== "member_access_expression") return null;
  return fn.childForFieldName("name")?.text.trim() ?? null;
}

/** Last identifier of a member-access chain (`x.A.B` → "B"), or the identifier text itself. */
function trailingMemberName(node: Parser.SyntaxNode): string | null {
  if (node.type === "member_access_expression") return node.childForFieldName("name")?.text.trim() ?? null;
  if (node.type === "identifier") return node.text.trim();
  return null;
}

/** Property named by a `x => x.Prop` (or `x => x.A.Prop`) lambda argument, or null. */
function lambdaPropertyName(arg: Parser.SyntaxNode): string | null {
  const lambda = arg.type === "argument" ? arg.namedChildren[0] : arg;
  if (!lambda || lambda.type !== "lambda_expression") return null;
  const body = lambda.childForFieldName("body");
  return body ? trailingMemberName(body) : null;
}

function unquote(node: Parser.SyntaxNode | undefined): string | null {
  if (!node) return null;
  const inner = node.descendantsOfType("string_literal_content")[0];
  if (inner) return inner.text;
  return node.text.replace(/^@?"/, "").replace(/"$/, "");
}

function firstArg(invocation: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  const list = invocation.childForFieldName("arguments") ?? invocation.namedChildren.find((c) => c.type === "argument_list");
  const arg = list?.namedChildren.find((c) => c.type === "argument");
  return arg?.namedChildren[0];
}

function owningType(node: Parser.SyntaxNode, classOwnerMap: Map<number, string>): string | null {
  let current: Parser.SyntaxNode | null = node;
  while (current) {
    if (current.type === "class_declaration" || current.type === "record_declaration") {
      const owner = classOwnerMap.get(current.id);
      if (owner) return owner;
    }
    current = current.parent;
  }
  return null;
}

/** Map each `IEntityTypeConfiguration<T>` class node id to its entity type T. */
function buildClassOwnerMap(root: Parser.SyntaxNode): Map<number, string> {
  const map = new Map<number, string>();
  for (const cls of root.descendantsOfType(["class_declaration", "record_declaration"])) {
    const baseList = cls.namedChildren.find((c) => c.type === "base_list");
    if (!baseList) continue;
    for (const generic of baseList.descendantsOfType("generic_name")) {
      if (generic.childForFieldName("name")?.text.trim() === "IEntityTypeConfiguration" || /^IEntityTypeConfiguration$/.test(generic.namedChildren[0]?.text.trim() ?? "")) {
        const typeArg = generic.descendantsOfType("type_argument_list")[0]?.namedChildren[0];
        if (typeArg) { map.set(cls.id, typeArg.text.trim()); break; }
      }
    }
  }
  return map;
}

/** Extract per-property EF mappings + CHECK constraints from one parsed config file. */
function extractMappingsFromFile(content: string, filePath: string): { mappings: EfPropertyMapping[]; checks: EfCheckConstraint[] } {
  const mappings: EfPropertyMapping[] = [];
  const checks: EfCheckConstraint[] = [];
  const tree = parseCSharpOnDemand(content, filePath);
  if (!tree) return { mappings, checks }; // too large / parse timeout → skip this file
  const root = tree.rootNode;
  const classOwnerMap = buildClassOwnerMap(root);

  for (const invocation of root.descendantsOfType("invocation_expression")) {
    if (invocationMethodName(invocation) !== "Property") continue;
    const arg0 = firstArg(invocation);
    const propName = arg0 ? lambdaPropertyName(arg0) : null;
    if (!propName) continue;

    // Climb the fluent chain: Property(...).HasConversion(...).HasColumnName("c").HasMaxLength(n)
    let hasConverter = false, converterExpression: string | null = null, columnName: string | null = null, maxLength: number | null = null;
    let cursor: Parser.SyntaxNode | null = invocation;
    while (cursor?.parent?.type === "member_access_expression" && cursor.parent.parent?.type === "invocation_expression") {
      const callNode: Parser.SyntaxNode = cursor.parent.parent;
      const method = invocationMethodName(callNode);
      const arg = firstArg(callNode);
      if (method === "HasConversion") { hasConverter = true; converterExpression = (callNode.childForFieldName("arguments") ?? callNode.namedChildren.find((c: Parser.SyntaxNode) => c.type === "argument_list"))?.text.slice(0, 160) ?? null; }
      else if (method === "HasColumnName") columnName = unquote(arg);
      else if (method === "HasMaxLength" && arg?.type === "integer_literal") maxLength = Number(arg.text);
      cursor = callNode;
    }

    mappings.push({
      ownerType: owningType(invocation, classOwnerMap),
      property: propName,
      columnName,
      hasConverter,
      converterExpression,
      maxLength,
      filePath,
      line: offsetToLine(content, invocation.startIndex)
    });
  }

  for (const invocation of root.descendantsOfType("invocation_expression")) {
    if (invocationMethodName(invocation) !== "HasCheckConstraint") continue;
    const args = (invocation.childForFieldName("arguments") ?? invocation.namedChildren.find((c) => c.type === "argument_list"))?.namedChildren.filter((c) => c.type === "argument") ?? [];
    checks.push({
      name: unquote(args[0]?.namedChildren[0]),
      expression: unquote(args[1]?.namedChildren[0]) ?? "",
      filePath,
      line: offsetToLine(content, invocation.startIndex)
    });
  }

  return { mappings, checks };
}

/** True if any invocation in an expression's receiver spine is a materializer (unwrapping `await`). */
function chainHasMaterializer(node: Parser.SyntaxNode | null): boolean {
  let cur: Parser.SyntaxNode | null = node;
  while (cur) {
    if (cur.type === "await_expression") { cur = cur.namedChildren[0] ?? null; continue; }
    if (cur.type === "invocation_expression") {
      const method = invocationMethodName(cur);
      if (method && MATERIALIZERS.has(method)) return true;
      const fn = cur.childForFieldName("function");
      cur = fn?.type === "member_access_expression" ? fn.childForFieldName("expression") : null;
      continue;
    }
    if (cur.type === "member_access_expression") { cur = cur.childForFieldName("expression"); continue; }
    break;
  }
  return false;
}

/** Leftmost identifier of a receiver spine (`items.Where(...).x` → "items"), or null. */
function baseIdentifier(node: Parser.SyntaxNode | null): string | null {
  let cur: Parser.SyntaxNode | null = node;
  while (cur) {
    if (cur.type === "identifier") return cur.text.trim();
    if (cur.type === "await_expression") { cur = cur.namedChildren[0] ?? null; continue; }
    if (cur.type === "invocation_expression") {
      const fn = cur.childForFieldName("function");
      cur = fn?.type === "member_access_expression" ? fn.childForFieldName("expression") : null;
      continue;
    }
    if (cur.type === "member_access_expression") { cur = cur.childForFieldName("expression"); continue; }
    break;
  }
  return null;
}

/** Enclosing method/constructor/local-function body used as the dataflow scope. */
function enclosingMethodNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let current: Parser.SyntaxNode | null = node;
  while (current) {
    if (current.type === "method_declaration" || current.type === "constructor_declaration" || current.type === "local_function_statement") return current;
    current = current.parent;
  }
  return null;
}

/** True if a local `name` was assigned (declared or reassigned) from a materialized expression in scope. */
function localValueIsMaterialized(fromNode: Parser.SyntaxNode, name: string): boolean {
  const scope = enclosingMethodNode(fromNode);
  if (!scope) return false;
  for (const declarator of scope.descendantsOfType("variable_declarator")) {
    if (declarator.childForFieldName("name")?.text.trim() !== name) continue;
    const init = declarator.namedChildren.find((c) => c.type !== "identifier");
    if (chainHasMaterializer(init ?? null)) return true;
  }
  for (const assign of scope.descendantsOfType("assignment_expression")) {
    if (assign.childForFieldName("left")?.text.trim() !== name) continue;
    if (chainHasMaterializer(assign.childForFieldName("right"))) return true;
  }
  return false;
}

/** Does the projection run in memory — its receiver spine is materialized, directly or via a local? */
function receiverIsMaterialized(invocation: Parser.SyntaxNode): boolean {
  const fn = invocation.childForFieldName("function");
  const receiver = fn?.type === "member_access_expression" ? fn.childForFieldName("expression") : null;
  if (!receiver) return false;
  if (chainHasMaterializer(receiver)) return true;
  const base = baseIdentifier(receiver);
  return base ? localValueIsMaterialized(invocation, base) : false;
}

/** Find EF-translated `.Select()`/`.Where()` projections that reference `property` without prior materialization. */
function findProjectionTrapsInFile(content: string, filePath: string, property: string): EfProjectionWarning[] {
  const warnings: EfProjectionWarning[] = [];
  const tree = parseCSharpOnDemand(content, filePath);
  if (!tree) return warnings; // too large / parse timeout → skip this file

  for (const invocation of tree.rootNode.descendantsOfType("invocation_expression")) {
    const method = invocationMethodName(invocation);
    if (!method || !PROJECTION_OPERATORS.has(method)) continue;
    const lambdaArg = firstArg(invocation);
    const lambda = lambdaArg?.type === "lambda_expression" ? lambdaArg : (lambdaArg?.parent?.type === "lambda_expression" ? lambdaArg.parent : null);
    const body = lambda?.type === "lambda_expression" ? lambda.childForFieldName("body") : null;
    if (!body) continue;

    const referencesProperty = body.descendantsOfType("member_access_expression").some((ma) => ma.childForFieldName("name")?.text.trim() === property);
    if (!referencesProperty) continue;
    if (receiverIsMaterialized(invocation)) continue;

    warnings.push({
      code: "DB_TRANSLATED_PROJECTION",
      property,
      operator: method as "Select" | "Where",
      filePath,
      line: offsetToLine(content, invocation.startIndex),
      snippet: invocation.text.replace(/\s+/g, " ").slice(0, 160),
      detail: `'${property}' is used inside a .${method}() that EF translates to SQL with no preceding materialization (.ToListAsync()/.AsEnumerable()). A value-converted property cannot run its converter in SQL — materialize first, then project in memory.`
    });
  }

  return warnings;
}

export type PersistenceMappingResult = {
  repoId: string;
  property: string;
  requestedOwnerType: string | null;
  mappings: EfPropertyMapping[];
  checkConstraints: EfCheckConstraint[];
  projectionWarnings: EfProjectionWarning[];
  filesScanned: number;
};

/**
 * Resolve the persistence mapping for a property: scan EF config files for HasConversion/column/
 * maxLength/CHECK, and scan query files for the projection trap. Bounded by `MAX_FILES_SCANNED`.
 */
export function getPersistenceMapping(
  store: GraphStore,
  repoPath: string,
  repoId: string,
  args: { property: string; ownerType?: string }
): PersistenceMappingResult {
  const property = args.property;
  const requestedOwner = args.ownerType ?? null;

  const csharpFiles = store
    .listIndexedFiles(repoId)
    .map((x) => normalizeRelativePath(x.path))
    .filter((p) => inferLanguageFromPath(p) === "csharp")
    .sort((a, b) => a.localeCompare(b));

  const mappings: EfPropertyMapping[] = [];
  const checkConstraints: EfCheckConstraint[] = [];
  const projectionWarnings: EfProjectionWarning[] = [];
  let filesScanned = 0;

  const readSafe = (filePath: string): string | null => {
    try {
      const abs = assertSafeRepoFilePath(repoPath, filePath);
      if (!fs.existsSync(abs)) return null;
      return fs.readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  };

  // Pass 1 — EF mappings + CHECK constraints from config/DbContext files mentioning the property.
  for (const filePath of csharpFiles) {
    if (filesScanned >= MAX_FILES_SCANNED) break;
    if (!isEfConfigCandidate(filePath)) continue;
    const content = readSafe(filePath);
    if (content === null || !content.includes(property)) continue;
    filesScanned++;
    const { mappings: fileMappings, checks } = extractMappingsFromFile(content, filePath);
    for (const m of fileMappings) {
      if (m.property !== property) continue;
      if (requestedOwner && m.ownerType && m.ownerType.toLowerCase() !== requestedOwner.toLowerCase()) continue;
      mappings.push(m);
    }
    // Associate CHECK constraints to this property by column name (or surface all when column unknown).
    const columns = new Set(fileMappings.filter((m) => m.property === property).map((m) => m.columnName).filter(Boolean) as string[]);
    for (const check of checks) {
      if (columns.size === 0 || [...columns].some((col) => check.expression.includes(col))) checkConstraints.push(check);
    }
  }

  // Pass 2 — projection-trap scan, only meaningful when the property is value-converted.
  const isConverted = mappings.some((m) => m.hasConverter);
  if (isConverted) {
    for (const filePath of csharpFiles) {
      if (filesScanned >= MAX_FILES_SCANNED) break;
      const content = readSafe(filePath);
      if (content === null || !content.includes(property)) continue;
      if (!content.includes(".Select(") && !content.includes(".Where(")) continue;
      filesScanned++;
      projectionWarnings.push(...findProjectionTrapsInFile(content, filePath, property));
    }
  }

  return {
    repoId,
    property,
    requestedOwnerType: requestedOwner,
    mappings: mappings.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line),
    checkConstraints,
    projectionWarnings: projectionWarnings.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line),
    filesScanned
  };
}
