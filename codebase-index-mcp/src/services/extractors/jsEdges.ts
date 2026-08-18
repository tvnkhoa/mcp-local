/**
 * JavaScript/TypeScript edges: module dependencies, calls, and the inheritance bridge.
 *
 * Split out of `jsExtractor.ts`. Type references and property access live in `jsTypeRefs.ts`.
 */

import type Parser from "tree-sitter";

import type { EdgeRecord } from "../../types/index.js";
import type { ExtractInput } from "./extractorTypes.js";

import {
  findEnclosingSymbolId,
  makeSymbolId,
  stripQuotes,
  shouldSkipJavaScriptMemberCall,
  BUILTIN_SKIP_NAMES,
  NODE_BUILTINS
} from "./extractorUtils.js";

// ── Module dependencies ─────────────────────────────────────────────────────────────────────

/**
 * `reason` is load-bearing, not descriptive, which is why no import shape gets its own label here.
 *
 * A NULL reason is what `schema.ts` rewrites to `'unresolved import token'`, and that exact string
 * is the `where` clause `resolveImportEdges` selects on. Tagging a re-export `re_export` — the
 * obvious thing to do — therefore made it invisible to the resolver: its `to_id` stayed the raw
 * `import:./x` token, `detectCircularDependencies` inner-joins `symbols` on `to_id` and dropped it,
 * and the barrel files this pass was added to make visible stayed invisible. The same label also
 * counts as *classified* in `graphQueries.importsClassified`, so it corrupted the health numbers in
 * the opposite direction at the same time.
 *
 * The provenance is not worth a field that decides resolution. The edge itself is the signal.
 */
function pushImportEdge(
  input: ExtractInput,
  moduleSymbolId: string,
  specifier: string,
  edges: EdgeRecord[]
): void {
  const dependency = stripQuotes(specifier);
  if (!dependency) return;

  const isRelative = dependency.startsWith(".");
  const isNodeBuiltin = dependency.startsWith("node:") || NODE_BUILTINS.has(dependency);

  edges.push({
    repoId: input.repoId,
    fromId: moduleSymbolId,
    toId: `import:${dependency}`,
    type: "IMPORTS",
    confidence: isNodeBuiltin ? 0.8 : isRelative ? undefined : 0.8,
    reason: isNodeBuiltin ? "node_builtin" : isRelative ? undefined : "npm_package"
  });
}

/**
 * Every shape that makes one module depend on another.
 *
 * Only static `import` was read before, which left three holes. The one that mattered most is the
 * re-export: a barrel `index.ts` full of `export * from "./x"` produced no IMPORTS edge at all, so
 * barrels were invisible to `detect_circular_dependencies` — the files most likely to be in a cycle
 * were the files it could not see.
 */
export function extractJavaScriptImports(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  edges: EdgeRecord[],
  moduleSymbolId: string
): void {
  for (const node of root.descendantsOfType(["import_statement", "export_statement"])) {
    const source = node.childForFieldName("source");
    if (!source) continue;
    pushImportEdge(input, moduleSymbolId, source.text, edges);
  }

  for (const node of root.descendantsOfType(["call_expression"])) {
    const fn = node.childForFieldName("function");
    if (!fn) continue;
    // `require("x")` and `await import("x")`. The dynamic-import callee is the `import` keyword, not
    // an identifier, so it is matched on text.
    const isRequire = fn.type === "identifier" && fn.text === "require";
    const isDynamicImport = fn.type === "import" || fn.text === "import";
    if (!isRequire && !isDynamicImport) continue;

    const firstArg = node.childForFieldName("arguments")?.namedChildren[0];
    if (!firstArg || (firstArg.type !== "string" && firstArg.type !== "template_string")) continue;
    // A template with substitutions is not a knowable specifier.
    if (firstArg.namedChildren.some((c) => c.type === "template_substitution")) continue;

    pushImportEdge(input, moduleSymbolId, firstArg.text, edges);
  }
}

// ── Calls ───────────────────────────────────────────────────────────────────────────────────

export function extractJavaScriptCalls(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  edges: EdgeRecord[],
  moduleSymbolId: string
): void {
  for (const node of root.descendantsOfType(["call_expression"])) {
    const functionNode = node.childForFieldName("function");
    let callee = "";
    let shouldSkip = false;

    if (functionNode?.type === "identifier") {
      callee = functionNode.text.trim();
    } else if (functionNode?.type === "member_expression") {
      const prop = functionNode.childForFieldName("property");
      if (prop?.type === "property_identifier") {
        callee = prop.text.trim();
        shouldSkip = shouldSkipJavaScriptMemberCall(functionNode, callee);
      }
    }

    if (!callee || shouldSkip || BUILTIN_SKIP_NAMES.has(callee)) continue;

    const fromId = findEnclosingSymbolId(node, input) ?? moduleSymbolId;
    edges.push({ repoId: input.repoId, fromId, toId: `callee:${callee}`, type: "CALLS" });
  }
}

// ── Inheritance bridge ──────────────────────────────────────────────────────────────────────

/** The plain type name a heritage entry names, or null when it is not a plain type. */
function heritageTypeName(node: Parser.SyntaxNode): string | null {
  switch (node.type) {
    case "type_identifier":
    case "identifier":
      return node.text.trim() || null;
    case "generic_type":
      // `implements Repository<User>` — the interface is the base name; the argument is a TYPE_REF,
      // emitted separately.
      return heritageTypeName(node.namedChildren[0] ?? node);
    case "nested_type_identifier": {
      // `ns.Contract` — only the right-most segment is the type.
      const last = node.namedChildren[node.namedChildren.length - 1];
      return last ? heritageTypeName(last) : null;
    }
    default:
      // `extends mixin(Base)` and other call/expression forms cannot be named without evaluating
      // them. Dropped rather than guessed.
      return null;
  }
}

function classSymbolIdFor(node: Parser.SyntaxNode, input: ExtractInput): string | null {
  // A class EXPRESSION is registered under the name it is bound to, on the declaration's row — even
  // when the expression carries its own name. `const A = class Foo extends Base {}` is registered as
  // `A`, so reading `Foo` off the node produced an id matching no symbol: the dangling-edge class
  // this whole change exists to remove. The binding is checked first for exactly that reason.
  if (node.type === "class") {
    const declarator = node.parent;
    if (declarator?.type !== "variable_declarator") return null;
    const boundName = declarator.childForFieldName("name");
    const declaration = declarator.parent;
    if (!boundName || boundName.type !== "identifier" || declaration?.type !== "lexical_declaration") return null;
    return makeSymbolId(input, "class", boundName.text, declaration.startPosition.row);
  }

  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;
  const kind = node.type === "interface_declaration" ? "interface" : "class";
  return makeSymbolId(input, kind, nameNode.text, node.startPosition.row);
}

/**
 * `EXTENDS` and `IMPLEMENTS` for TypeScript/JavaScript.
 *
 * Until this existed the two edge types were emitted by the C# extractor alone, so
 * `find_implementations` returned empty for a TypeScript repo no matter what it declared, and the
 * interface-dispatch fan-out in `edgeResolverCalls` had nothing to fan out along.
 *
 * TypeScript needs no equivalent of the C# `isLikelyCSharpInterfaceName` heuristic: a C# base list
 * cannot say which entry is the base class, so it is guessed from the `I` prefix, whereas
 * `extends_clause` and `implements_clause` are distinct nodes here. `interface A extends B` is
 * recorded as IMPLEMENTS rather than EXTENDS, because what it means is "A satisfies B's contract" —
 * which is the relation `find_implementations(B)` is asked about.
 */
export function extractJavaScriptHeritage(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  edges: EdgeRecord[]
): void {
  for (const node of root.descendantsOfType(["class_declaration", "abstract_class_declaration", "class"])) {
    const symbolId = classSymbolIdFor(node, input);
    if (!symbolId) continue;

    for (const heritage of node.namedChildren.filter((c) => c.type === "class_heritage")) {
      for (const clause of heritage.namedChildren) {
        const isImplements = clause.type === "implements_clause";
        if (!isImplements && clause.type !== "extends_clause") continue;

        for (const entry of clause.namedChildren) {
          if (entry.type === "type_arguments") continue;
          const name = heritageTypeName(entry);
          if (!name) continue;
          edges.push({
            repoId: input.repoId,
            fromId: symbolId,
            toId: isImplements ? `iface:${name}` : `base:${name}`,
            type: isImplements ? "IMPLEMENTS" : "EXTENDS",
            confidence: 0.95,
            reason: isImplements ? "implements_clause" : "extends_clause"
          });
        }
      }
    }
  }

  for (const node of root.descendantsOfType(["interface_declaration"])) {
    const symbolId = classSymbolIdFor(node, input);
    if (!symbolId) continue;

    for (const clause of node.namedChildren.filter((c) => c.type === "extends_type_clause")) {
      for (const entry of clause.namedChildren) {
        const name = heritageTypeName(entry);
        if (!name) continue;
        edges.push({
          repoId: input.repoId,
          fromId: symbolId,
          toId: `iface:${name}`,
          type: "IMPLEMENTS",
          confidence: 0.95,
          reason: "interface_extends"
        });
      }
    }
  }
}
