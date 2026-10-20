/**
 * R3 exact — the Zod parse pass: writes TypeScript's reference finder cannot see.
 *
 * `audit_event_schema.parse({ kb_version_ids: …, … })` is how wec.aria's core builds an audit event
 * (`packages/core/audit/index.ts:92`). `.parse` takes `unknown`, so the literal has no contextual
 * type and `findReferences` correctly does not link its keys to the contract — the R3 spike's most
 * important finding: without this pass the tool reports "no writer in core" for a field core writes
 * on every turn.
 *
 * For every `X.parse | safeParse | parseAsync | safeParseAsync (arg)` in the repo:
 * 1. X's type must reach a Zod object shape (`.shape`, through union `.options`, `_def.schema` /
 *    `innerType` / `in` wrappers) whose property `field` is DECLARED by the declaration group being
 *    answered — checked with the checker against the group's definition sites, so spreads of a field
 *    bag (`...audit_event_common_fields`) count and a same-named key of another schema does not.
 * 2. The argument is then read: an object literal → its `field` key is a WRITE "via parse"; an
 *    identifier → its variable's object-literal initializer, same rule; anything else (a parameter, a
 *    call result, `JSON.parse(...)`) → a named gap, because the construction is somewhere this pass
 *    cannot follow. A literal without the key whose spread is untyped is also a gap.
 */

import ts from "typescript";

import { unwrapExpression } from "./fieldClassify.js";

const PARSE_METHODS = new Set(["parse", "safeParse", "parseAsync", "safeParseAsync", "decode", "safeDecode"]);
const PARSE_TEXT = /\.(?:safeParse|parse|parseAsync|safeParseAsync|decode|safeDecode)\s*\(/;

/** `file:pos` key — the identity of a definition site across the pass. */
export const siteKey = (fileName: string, pos: number): string => `${fileName}:${String(pos)}`;

export type ParseWrite = { sf: ts.SourceFile; pos: number; groupIndex: number; how: string; schemaExpression: string };
export type ParseGap = { sf: ts.SourceFile; pos: number; groupIndex: number; reason: string };

/** Shapes a Zod schema type reaches, bounded. */
function reachableShapes(checker: ts.TypeChecker, type: ts.Type, at: ts.Node, depth = 0, out: ts.Type[] = []): ts.Type[] {
  if (depth > 4) return out;
  if (type.isUnion()) {
    for (const t of type.types) reachableShapes(checker, t, at, depth + 1, out);
    return out;
  }
  const prop = (t: ts.Type, name: string): ts.Type | null => {
    const sym = t.getProperty(name);
    return sym ? checker.getTypeOfSymbolAtLocation(sym, at) : null;
  };
  const shape = prop(type, "shape");
  if (shape && !(shape.flags & ts.TypeFlags.Any)) out.push(shape);
  const options = prop(type, "options");
  if (options) {
    const elements = checker.isTupleType(options)
      ? checker.getTypeArguments(options as ts.TypeReference)
      : [checker.getIndexTypeOfType(options, ts.IndexKind.Number)].filter((t): t is ts.Type => Boolean(t));
    for (const el of elements) reachableShapes(checker, el, at, depth + 1, out);
  }
  const def = prop(type, "_def");
  if (def) {
    for (const inner of ["schema", "innerType", "in"]) {
      const t = prop(def, inner);
      if (t) reachableShapes(checker, t, at, depth + 1, out);
    }
  }
  const pipeIn = prop(type, "in");
  if (pipeIn) reachableShapes(checker, pipeIn, at, depth + 1, out);
  return out;
}

/** Declaration keys of a property symbol, through mapped/derived symbols to their roots. */
export function declarationKeys(checker: ts.TypeChecker, sym: ts.Symbol): string[] {
  const keys: string[] = [];
  const roots = [sym, ...checker.getRootSymbols(sym)];
  for (const s of roots) {
    for (const d of s.declarations ?? []) {
      const name = (d as { name?: ts.Node }).name;
      const node = name ?? d;
      keys.push(siteKey(d.getSourceFile().fileName, node.getStart(d.getSourceFile())));
    }
  }
  return keys;
}

/** Which declaration group (if any) owns `field` on a shape X reaches. */
function groupOfSchema(checker: ts.TypeChecker, x: ts.Expression, field: string, groupOfKey: Map<string, number>): number | null {
  const type = checker.getTypeAtLocation(x);
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return null;
  for (const shape of reachableShapes(checker, type, x)) {
    const sym = shape.getProperty(field);
    if (!sym) continue;
    for (const key of declarationKeys(checker, sym)) {
      const g = groupOfKey.get(key);
      if (g !== undefined) return g;
    }
  }
  return null;
}

function literalKey(obj: ts.ObjectLiteralExpression, field: string): ts.Node | null {
  for (const p of obj.properties) {
    if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === field) return p.name;
  }
  return null;
}

/**
 * Run the pass over every repo file. `groupOfKey` maps each definition site (`siteKey`) to the
 * index of its declaration group.
 */
export function runZodParsePass(
  program: ts.Program,
  field: string,
  groupOfKey: Map<string, number>,
  isRepoFile: (fileName: string) => boolean,
  checkBudget: () => void
): { writes: ParseWrite[]; gaps: ParseGap[] } {
  const checker = program.getTypeChecker();
  const writes: ParseWrite[] = [];
  const gaps: ParseGap[] = [];
  for (const sf of program.getSourceFiles()) {
    if (!isRepoFile(sf.fileName) || !PARSE_TEXT.test(sf.text)) continue;
    checkBudget();
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && PARSE_METHODS.has(n.expression.name.text) && n.arguments.length > 0) {
        inspectCall(n, n.expression);
      }
      ts.forEachChild(n, visit);
    };
    const inspectCall = (call: ts.CallExpression, callee: ts.PropertyAccessExpression): void => {
      const g = groupOfSchema(checker, callee.expression, field, groupOfKey);
      if (g === null) return;
      const schemaExpression = callee.expression.getText(sf).slice(0, 80);
      const arg = unwrapExpression(call.arguments[0]!) as ts.Expression;
      if (ts.isObjectLiteralExpression(arg)) {
        inspectLiteral(arg, g, schemaExpression, "via parse (object literal)");
        return;
      }
      if (ts.isIdentifier(arg)) {
        let sym = checker.getSymbolAtLocation(arg);
        if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
        const decl = sym?.valueDeclaration;
        const init = decl && ts.isVariableDeclaration(decl) && decl.initializer ? unwrapExpression(decl.initializer) : undefined;
        if (init && ts.isObjectLiteralExpression(init)) {
          inspectLiteral(init, g, schemaExpression, `via parse (initializer of \`${arg.text}\`)`);
          return;
        }
        const what = decl && ts.isParameter(decl) ? "a parameter" : decl && ts.isVariableDeclaration(decl) ? "a variable without an object-literal initializer" : "not a local object literal";
        gaps.push({ sf, pos: arg.getStart(sf), groupIndex: g, reason: `${schemaExpression}.${callee.name.text}(${arg.text}): the argument is ${what}; the construction it carries cannot be followed` });
        return;
      }
      gaps.push({ sf, pos: arg.getStart(sf), groupIndex: g, reason: `${schemaExpression}.${callee.name.text}(…): the argument is a ${ts.SyntaxKind[arg.kind]}, not an object literal; its keys cannot be read` });
    };
    const inspectLiteral = (obj: ts.ObjectLiteralExpression, g: number, schemaExpression: string, how: string): void => {
      const key = literalKey(obj, field);
      const objSf = obj.getSourceFile();
      if (key) {
        writes.push({ sf: objSf, pos: key.getStart(objSf), groupIndex: g, how, schemaExpression });
        return;
      }
      for (const p of obj.properties) {
        if (!ts.isSpreadAssignment(p)) continue;
        const t = checker.getTypeAtLocation(p.expression);
        if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
          gaps.push({ sf: objSf, pos: p.getStart(objSf), groupIndex: g, reason: `${schemaExpression} parse argument spreads an untyped value (\`${p.expression.getText(objSf).slice(0, 60)}\`) that may carry the field` });
        }
      }
    };
    visit(sf);
  }
  return { writes, gaps };
}

/**
 * Dynamic `obj[expr]` sites in the given files whose receiver type declares the field in a group —
 * the accesses no static tool can attribute. Cheap: only files that already reference the group.
 */
export function findDynamicAccessGaps(
  program: ts.Program,
  files: Iterable<string>,
  field: string,
  groupOfKey: Map<string, number>
): ParseGap[] {
  const checker = program.getTypeChecker();
  const gaps: ParseGap[] = [];
  for (const fileName of files) {
    const sf = program.getSourceFile(fileName);
    if (!sf || !sf.text.includes("[")) continue;
    const visit = (n: ts.Node): void => {
      if (ts.isElementAccessExpression(n)) {
        const arg = unwrapExpression(n.argumentExpression);
        const literal = ts.isStringLiteralLike(arg) || ts.isNumericLiteral(arg);
        if (!literal) {
          const recv = checker.getApparentType(checker.getTypeAtLocation(n.expression));
          const sym = recv.getProperty(field);
          const g = sym ? declarationKeys(checker, sym).map((k) => groupOfKey.get(k)).find((x) => x !== undefined) : undefined;
          if (g !== undefined) {
            gaps.push({ sf, pos: n.getStart(sf), groupIndex: g, reason: `dynamic element access \`${n.getText(sf).slice(0, 60)}\` on a type that declares the field — which key it reads is decided at run time` });
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return gaps;
}

