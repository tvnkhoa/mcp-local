/**
 * R3 exact — which declarations a field NAME may mean.
 *
 * Resolution is per declaration, not per name: wec.aria's `kb_version_ids` is a Zod contract key
 * (`contracts/src/entities/audit-event.ts:23`, in a field bag spread into four `z.strictObject`s),
 * and ALSO the api function `kb_version_ids()` (`api/src/wire/envelope.ts:103`) and console's own
 * `Reply.kb_version_ids`. Text search conflates them; this module separates them.
 *
 * Property-like declarations (candidates):
 * - a key of a Zod shape literal (`z.object({ f: … })`, `strictObject`, `extend`, …);
 * - a key of a module-level `const` object literal that is spread (`...bag`) into a Zod shape literal,
 *   directly or through another such bag — the "field bag" (`audit_event_common_fields`);
 * - an interface / type-literal property signature, a class property, a get/set accessor.
 *
 * Other declarations of the same name — functions, variables, classes, methods, types — are named
 * non-matches. Object-literal keys anywhere else are constructions (WRITE sites), not declarations.
 */

import ts from "typescript";

import { fieldBagName, isZodShapeLiteral, unwrapExpression } from "./fieldClassify.js";

export type DeclarationKind = "zod-shape-key" | "zod-field-bag" | "property-signature" | "class-property" | "accessor";

export type FieldDeclaration = {
  sf: ts.SourceFile;
  /** Start of the declaration's name. */
  pos: number;
  kind: DeclarationKind;
  /** Schema / interface / class / bag the field belongs to. */
  ownerName: string;
  /** For a field bag: the schemas it is spread into. */
  spreadInto: string[];
};

export type NonMatch = { sf: ts.SourceFile; pos: number; kind: string; container: string | null };

const NAME_RE_CACHE = new Map<string, RegExp>();
export function wordRegex(field: string): RegExp {
  let re = NAME_RE_CACHE.get(field);
  if (!re) {
    re = new RegExp(`(?<![\\w$])${field.replace(/[$]/g, "\\$")}(?![\\w$])`);
    NAME_RE_CACHE.set(field, re);
  }
  return re;
}

function nameText(name: ts.Node): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
  return null;
}

/** The variable a Zod expression is assigned to: `const audit_event_schema = z.discriminatedUnion(…, [z.strictObject({…})])`. */
export function schemaOwnerName(n: ts.Node): string | null {
  let cur: ts.Node | undefined = n;
  while (cur && !ts.isSourceFile(cur)) {
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
    if (ts.isPropertyAssignment(cur) && ts.isObjectLiteralExpression(cur.parent) && !isZodShapeLiteral(cur.parent)) {
      const key = nameText(cur.name);
      if (key) return key;
    }
    if (ts.isFunctionLike(cur) || ts.isClassLike(cur)) return null;
    cur = cur.parent;
  }
  return null;
}

function containerName(n: ts.Node): string | null {
  let cur: ts.Node | undefined = n.parent;
  while (cur && !ts.isSourceFile(cur)) {
    if ((ts.isInterfaceDeclaration(cur) || ts.isClassLike(cur) || ts.isTypeAliasDeclaration(cur) || ts.isFunctionLike(cur) || ts.isModuleDeclaration(cur)) && cur.name && nameText(cur.name)) {
      return nameText(cur.name);
    }
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
    cur = cur.parent;
  }
  return null;
}

/** Where a field bag is spread, resolved through the LanguageService (imports and aliases included). */
function bagSpreadTargets(ls: ts.LanguageService, bagDecl: ts.VariableDeclaration, depth = 0): string[] {
  if (depth > 3 || !ts.isIdentifier(bagDecl.name)) return [];
  const sf = bagDecl.getSourceFile();
  const refs = ls.getReferencesAtPosition(sf.fileName, bagDecl.name.getStart(sf)) ?? [];
  const program = ls.getProgram();
  const owners: string[] = [];
  for (const ref of refs) {
    const refSf = program?.getSourceFile(ref.fileName);
    if (!refSf) continue;
    const id = findToken(refSf, ref.textSpan.start);
    const spread = id?.parent;
    if (!spread || !ts.isSpreadAssignment(spread) || !ts.isObjectLiteralExpression(spread.parent)) continue;
    const obj = spread.parent;
    if (isZodShapeLiteral(obj)) {
      owners.push(schemaOwnerName(obj) ?? "<anonymous schema>");
      continue;
    }
    // A bag spread into another bag: follow it.
    const outerName = fieldBagName(obj);
    if (outerName) {
      let top: ts.Node = obj;
      while (top.parent && !ts.isVariableDeclaration(top.parent)) top = top.parent;
      if (top.parent && ts.isVariableDeclaration(top.parent)) owners.push(...bagSpreadTargets(ls, top.parent, depth + 1));
    }
  }
  return [...new Set(owners)];
}

export function findToken(sf: ts.SourceFile, pos: number): ts.Node | undefined {
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

/**
 * Every declaration of `field` in the repo's own source files, split into property-like candidates
 * and named non-matches.
 */
export function collectFieldDeclarations(
  ls: ts.LanguageService,
  program: ts.Program,
  field: string,
  isRepoFile: (fileName: string) => boolean
): { declarations: FieldDeclaration[]; nonMatches: NonMatch[] } {
  const declarations: FieldDeclaration[] = [];
  const nonMatches: NonMatch[] = [];
  const re = wordRegex(field);
  for (const sf of program.getSourceFiles()) {
    if (!isRepoFile(sf.fileName) || !re.test(sf.text)) continue;
    const visit = (n: ts.Node): void => {
      const name = (n as { name?: ts.Node }).name;
      if (name && nameText(name) === field && name.parent === n) classifyDeclaration(n, name);
      ts.forEachChild(n, visit);
    };
    const classifyDeclaration = (n: ts.Node, name: ts.Node): void => {
      const pos = name.getStart(sf);
      if (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) {
        const obj = n.parent;
        if (!ts.isObjectLiteralExpression(obj)) return;
        if (isZodShapeLiteral(obj)) {
          declarations.push({ sf, pos, kind: "zod-shape-key", ownerName: schemaOwnerName(obj) ?? "<anonymous schema>", spreadInto: [] });
          return;
        }
        const bag = fieldBagName(obj);
        if (bag) {
          let top: ts.Node = obj;
          while (top.parent && !ts.isVariableDeclaration(top.parent)) top = top.parent;
          const decl = top.parent;
          const spreadInto = decl && ts.isVariableDeclaration(decl) ? bagSpreadTargets(ls, decl) : [];
          if (spreadInto.length > 0) declarations.push({ sf, pos, kind: "zod-field-bag", ownerName: bag, spreadInto });
        }
        return; // any other object-literal key is a construction site, not a declaration
      }
      if (ts.isPropertySignature(n)) {
        declarations.push({ sf, pos, kind: "property-signature", ownerName: containerName(n) ?? "<type literal>", spreadInto: [] });
      } else if (ts.isPropertyDeclaration(n)) {
        declarations.push({ sf, pos, kind: "class-property", ownerName: containerName(n) ?? "<class>", spreadInto: [] });
      } else if (ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) {
        declarations.push({ sf, pos, kind: "accessor", ownerName: containerName(n) ?? "<class>", spreadInto: [] });
      } else if (ts.isFunctionDeclaration(n)) {
        nonMatches.push({ sf, pos, kind: "function", container: containerName(n) });
      } else if (ts.isMethodDeclaration(n) || ts.isMethodSignature(n)) {
        nonMatches.push({ sf, pos, kind: "method", container: containerName(n) });
      } else if (ts.isVariableDeclaration(n)) {
        const init = n.initializer ? unwrapExpression(n.initializer) : undefined;
        const fnLike = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        nonMatches.push({ sf, pos, kind: fnLike ? "function" : "variable", container: containerName(n) });
      } else if (ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isEnumDeclaration(n)) {
        nonMatches.push({ sf, pos, kind: ts.SyntaxKind[n.kind].replace(/Declaration$/, "").toLowerCase(), container: containerName(n) });
      }
      // Parameters, binding elements, import/export specifiers are locals or aliases: neither.
    };
    visit(sf);
  }
  const order: Record<DeclarationKind, number> = { "zod-shape-key": 0, "zod-field-bag": 0, "property-signature": 1, "class-property": 1, accessor: 2 };
  declarations.sort((a, b) => order[a.kind] - order[b.kind] || a.sf.fileName.localeCompare(b.sf.fileName) || a.pos - b.pos);
  return { declarations, nonMatches };
}
