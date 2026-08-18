/**
 * The JavaScript/TypeScript lane's entry point.
 *
 * One extractor serves both languages — the dispatch in `treeSitterExtractor` is
 * `javascript || typescript`, and only the grammar differs (`.tsx` gets the JSX dialect). So the
 * internals keep a single `js*` prefix even where a pass is meaningful only under TypeScript:
 * `class X extends Y` is JavaScript too, and a `.js` file simply has no type annotations for
 * `jsTypeRefs` to find. A second prefix would imply a second lane that does not exist.
 *
 * Passes run symbols-first because every edge pass mints its `fromId` with the same
 * `makeSymbolId` spelling the symbol pass used.
 */

import type Parser from "tree-sitter";

import type { EdgeRecord, SymbolRecord } from "../../types/index.js";
import type { ExtractInput } from "./extractorTypes.js";

import { extractJavaScriptCalls, extractJavaScriptHeritage, extractJavaScriptImports } from "./jsEdges.js";
import { extractJavaScriptSymbols } from "./jsSymbols.js";
import { extractJavaScriptPropertyEdges, extractJavaScriptTypeRefs } from "./jsTypeRefs.js";

export { extractJavaScriptRoutesImpl } from "./jsRoutes.js";

export function extractJavaScriptSymbolsImpl(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  symbols: SymbolRecord[],
  edges: EdgeRecord[],
  moduleSymbolId: string
): void {
  extractJavaScriptSymbols(input, root, symbols);

  extractJavaScriptImports(input, root, edges, moduleSymbolId);
  extractJavaScriptCalls(input, root, edges, moduleSymbolId);
  extractJavaScriptHeritage(input, root, edges);
  extractJavaScriptTypeRefs(input, root, edges, moduleSymbolId);
  extractJavaScriptPropertyEdges(input, root, edges, moduleSymbolId);
}
