/**
 * C# extraction.
 *
 * Split in S-41; this barrel keeps `treeSitterExtractor.ts`'s import list unchanged. The parts
 * are the three questions asked of C# source: what is declared, what touches which property,
 * and what is reachable over HTTP.
 */

export { extractCSharpSymbolsImpl } from "./csharpSymbols.js";
export {
  emitEndpointContractSymbolsFromCSharpSignaturesImpl,
  emitEndpointContractSymbolsImpl,
  extractCSharpRoutesImpl
} from "./csharpRoutes.js";
