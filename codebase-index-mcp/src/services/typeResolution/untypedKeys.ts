/**
 * R3 exact — same-name keys the type checker cannot link to any declaration.
 *
 * wec.aria's api builds CommHub wire objects as `{ …, kb_version_ids: kb_version_ids(response) }`
 * (`api/src/wire/commhub.ts:283`, `console.ts:375`): the literal has no contextual type declaring the
 * field, so `findReferences` links the key to nothing — correctly, it is not the contract field. A
 * reader still needs to see it: it is the place a text search would have flagged, and the answer
 * should say why it is not a site. These keys are reported as `nonMatches` with kind
 * `"untyped-object-key"`.
 *
 * Cheap by construction: only files whose text contains the word are walked, and the checker is
 * asked once per same-named key. A key is reported when it is not already a site, declaration or
 * parse-pass write (`known`) and its object literal's contextual type is absent, `any`/`unknown`, or
 * has no property of that name in any union member. A key whose contextual type DOES declare the
 * name belongs to that declaration — a homonym TypeScript resolved — and is not reported here.
 */

import ts from "typescript";

import { enclosingName, isZodShapeLiteral } from "./fieldClassify.js";
import { wordRegex } from "./fieldDeclarations.js";
import { siteKey } from "./zodParsePass.js";

export type UntypedKey = { sf: ts.SourceFile; pos: number; container: string | null };

function keyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) ? name.text : null;
}

function declaresProperty(checker: ts.TypeChecker, type: ts.Type, field: string): boolean {
  const members = type.isUnion() ? type.types : [type];
  return members.some((m) => {
    const apparent = checker.getApparentType(m);
    if (apparent.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
    return apparent.getProperty(field) !== undefined;
  });
}

export function findUntypedObjectKeys(
  program: ts.Program,
  field: string,
  include: (fileName: string) => boolean,
  known: ReadonlySet<string>,
  checkBudget: () => void
): UntypedKey[] {
  const checker = program.getTypeChecker();
  const re = wordRegex(field);
  const out: UntypedKey[] = [];
  for (const sf of program.getSourceFiles()) {
    if (!include(sf.fileName) || !re.test(sf.text)) continue;
    checkBudget();
    const visit = (n: ts.Node): void => {
      if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && keyName(n.name) === field && ts.isObjectLiteralExpression(n.parent)) {
        inspect(n, n.parent);
      }
      ts.forEachChild(n, visit);
    };
    const inspect = (prop: ts.PropertyAssignment | ts.ShorthandPropertyAssignment, obj: ts.ObjectLiteralExpression): void => {
      if (isZodShapeLiteral(obj)) return;
      const outer = obj.parent;
      if (outer && ts.isBinaryExpression(outer) && outer.left === obj) return; // destructuring assignment target
      const pos = prop.name.getStart(sf);
      if (known.has(siteKey(sf.fileName, pos))) return;
      const contextual = checker.getContextualType(obj);
      if (contextual && !(contextual.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) && declaresProperty(checker, contextual, field)) return;
      out.push({ sf, pos, container: enclosingName(sf, pos) });
    };
    visit(sf);
  }
  return out;
}
