/**
 * R3 exact — what a reference to a field DOES at its site: DEFINITION, WRITE or READ.
 *
 * Pure syntax over a TypeScript AST, so it is unit-testable without a program. The rules are the
 * R3 spike's `classify`, which agreed with TypeScript's own `isWriteAccess` on every wec.aria row:
 *
 * - a key in an object literal passed to `z.object` / `strictObject` / `looseObject` / `extend` /
 *   `safeExtend` (or in a field bag spread into one) is the DEFINITION of the shape key;
 * - any other object-literal key is a WRITE (construction), except on the left of a destructuring
 *   assignment, which writes the target;
 * - `x.f = …`, `x.f += …`, `x.f++` are WRITEs; a binding element (`const { f } = x`) is a READ;
 * - an interface/type property signature or class property is a DEFINITION;
 * - everything else (property access, element access by literal, type positions) is a READ.
 */

import ts from "typescript";

export type AccessKind = "DEFINITION" | "WRITE" | "READ";

export type Classification = {
  kind: AccessKind;
  /** How the site was recognised, e.g. "property-access", "object-literal-key (construction)". */
  how: string;
  notes: string[];
};

const ASSIGN_OPS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken
]);

export const ZOD_SHAPE_METHODS = /^(?:object|strictObject|looseObject|passthroughObject|extend|safeExtend|merge)$/;

/** The innermost node whose span contains `pos` (the identifier a reference points at). */
export function nodeAt(sf: ts.SourceFile, pos: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    if (pos >= n.getStart(sf) && pos < n.getEnd()) {
      found = n;
      ts.forEachChild(n, visit);
    }
  };
  visit(sf);
  return found;
}

/** `z.object({...})`-shaped: the literal is the first argument of a Zod shape method call. */
export function isZodShapeLiteral(obj: ts.ObjectLiteralExpression): boolean {
  const call = obj.parent;
  if (!call || !ts.isCallExpression(call) || call.arguments[0] !== obj) return false;
  const callee = call.expression;
  return ts.isPropertyAccessExpression(callee) && ZOD_SHAPE_METHODS.test(callee.name.text);
}

function unwrapExpression(n: ts.Node): ts.Node {
  let cur = n;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isTypeAssertionExpression(cur)) cur = cur.expression;
  return cur;
}

/** A module-level `const X = { ... }` (optionally `as const` / `satisfies …`): a field bag candidate. */
export function fieldBagName(obj: ts.ObjectLiteralExpression): string | null {
  let top: ts.Node = obj;
  while (top.parent && (ts.isParenthesizedExpression(top.parent) || ts.isAsExpression(top.parent) || ts.isSatisfiesExpression(top.parent))) top = top.parent;
  const decl = top.parent;
  if (!decl || !ts.isVariableDeclaration(decl) || decl.initializer !== top || !ts.isIdentifier(decl.name)) return null;
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return null;
  const statement = list.parent;
  return ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent) ? decl.name.text : null;
}

export function classify(sf: ts.SourceFile, pos: number, isTsDefinition = false): Classification {
  const result = classifySyntax(sf, pos);
  if (isTsDefinition && result.kind !== "DEFINITION") {
    return { kind: "DEFINITION", how: `declaration (${result.how})`, notes: result.notes };
  }
  return result;
}

function classifySyntax(sf: ts.SourceFile, pos: number): Classification {
  const n = nodeAt(sf, pos);
  if (!n) return { kind: "READ", how: "unknown-node", notes: [] };
  const p = n.parent;
  const notes: string[] = [];
  if (p && (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name === n && ts.isObjectLiteralExpression(p.parent)) {
    const obj = p.parent;
    if (obj.properties.some(ts.isSpreadAssignment)) notes.push("object-literal-has-spread");
    if (isZodShapeLiteral(obj)) return { kind: "DEFINITION", how: "zod-shape-key", notes };
    const outer = obj.parent;
    if (outer && ts.isBinaryExpression(outer) && outer.left === obj) return { kind: "WRITE", how: "destructuring-assignment-target", notes };
    if (ts.isShorthandPropertyAssignment(p)) notes.push("shorthand");
    return { kind: "WRITE", how: "object-literal-key (construction)", notes };
  }
  if (p && (ts.isPropertySignature(p) || ts.isPropertyDeclaration(p)) && p.name === n) {
    return { kind: "DEFINITION", how: ts.isPropertySignature(p) ? "property-signature" : "class-property", notes };
  }
  if (p && ts.isBindingElement(p)) return { kind: "READ", how: "destructuring (binding element)", notes: ["destructuring"] };
  let access: ts.Node = n;
  if (p && ts.isPropertyAccessExpression(p) && p.name === n) access = p;
  else if (p && ts.isElementAccessExpression(p) && p.argumentExpression === n) access = p;
  else if ((ts.isStringLiteral(n) || ts.isIdentifier(n)) && p && (ts.isLiteralTypeNode(p) || ts.isIndexedAccessTypeNode(p) || ts.isTypeReferenceNode(p))) {
    return { kind: "READ", how: "type-position", notes };
  }
  let q = access.parent;
  while (q && (ts.isParenthesizedExpression(q) || ts.isNonNullExpression(q))) q = q.parent;
  if (q && ts.isBinaryExpression(q) && ASSIGN_OPS.has(q.operatorToken.kind) && unwrapExpression(q.left) === access) {
    return { kind: "WRITE", how: q.operatorToken.kind === ts.SyntaxKind.EqualsToken ? "assignment" : "compound-assignment", notes };
  }
  if (q && (ts.isPrefixUnaryExpression(q) || ts.isPostfixUnaryExpression(q)) && (q.operator === ts.SyntaxKind.PlusPlusToken || q.operator === ts.SyntaxKind.MinusMinusToken)) {
    return { kind: "WRITE", how: "increment", notes };
  }
  if (q && ts.isSpreadElement(q)) notes.push("spread-of-value");
  return { kind: "READ", how: access === n ? "other" : ts.isElementAccessExpression(access) ? "element-access (literal key)" : "property-access", notes };
}

/** Name of the nearest named enclosing declaration — the "who" of a read or write. */
export function enclosingName(sf: ts.SourceFile, pos: number): string | null {
  let n: ts.Node | undefined = nodeAt(sf, pos);
  const parts: string[] = [];
  while (n && !ts.isSourceFile(n)) {
    const name = declarationName(n);
    // `const f = () => …` names both the arrow and the declaration; count it once.
    if (name && parts[0] !== name) {
      parts.unshift(name);
      if (ts.isClassDeclaration(n) || ts.isFunctionDeclaration(n) || parts.length >= 2) break;
    }
    n = n.parent;
  }
  return parts.length > 0 ? parts.join(".") : null;
}

function declarationName(n: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isMethodDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) && n.name) {
    return n.name.getText();
  }
  if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parent && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) {
    return n.parent.name.text;
  }
  if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.parent.parent && ts.isVariableStatement(n.parent.parent) && ts.isSourceFile(n.parent.parent.parent)) {
    return n.name.text;
  }
  if (ts.isCallExpression(n) && n.parent && ts.isExpressionStatement(n.parent) && ts.isIdentifier(n.expression) && /^(?:it|test|describe)$/.test(n.expression.text)) {
    const title = n.arguments[0];
    if (title && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))) return `${n.expression.text}(${JSON.stringify(title.text.slice(0, 60))})`;
  }
  return null;
}

export { unwrapExpression };
