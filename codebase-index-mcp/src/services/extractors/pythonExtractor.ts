import type { EdgeRecord, RouteRecord, SymbolRecord } from "../../types/index.js";
import type { ExtractInput } from "./extractorTypes.js";

import {
  stableId,
  lineFromOffset,
  extractFirstStringLiteral
} from "./extractorUtils.js";

export function extractPythonSymbolsAndRoutesImpl(
  input: ExtractInput,
  symbols: SymbolRecord[],
  edges: EdgeRecord[],
  routes: RouteRecord[],
  moduleSymbolId: string
): void {
  const importRegex = /^\s*(?:from\s+([A-Za-z0-9_\.]+)\s+import\s+.+|import\s+([A-Za-z0-9_\.]+))/gm;
  let importMatch: RegExpExecArray | null;
  while ((importMatch = importRegex.exec(input.source)) !== null) {
    const dep = importMatch[1] ?? importMatch[2] ?? "";
    if (dep) {
      edges.push({
        repoId: input.repoId,
        fromId: moduleSymbolId,
        toId: `import:${dep}`,
        type: "IMPORTS"
      });
    }
  }

  const functionByName = new Map<string, string>();
  const classRegex = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm;
  let classMatch: RegExpExecArray | null;
  while ((classMatch = classRegex.exec(input.source)) !== null) {
    const name = classMatch[1];
    const line = lineFromOffset(input.source, classMatch.index);
    const symbolId = stableId(`${input.repoId}:${input.filePath}:class:${name}:${line - 1}`);
    symbols.push({
      repoId: input.repoId,
      symbolId,
      filePath: input.filePath,
      name,
      kind: "class",
      line,
      signature: `class ${name}`
    });
  }

  const functionRegex = /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
  let functionMatch: RegExpExecArray | null;
  while ((functionMatch = functionRegex.exec(input.source)) !== null) {
    const name = functionMatch[1];
    const line = lineFromOffset(input.source, functionMatch.index);
    const symbolId = stableId(`${input.repoId}:${input.filePath}:function:${name}:${line - 1}`);
    symbols.push({
      repoId: input.repoId,
      symbolId,
      filePath: input.filePath,
      name,
      kind: "function",
      line,
      signature: `${functionMatch[0].trim()}`
    });
    functionByName.set(name, symbolId);
  }

  const routeRegex = /@(router|app)\.(get|post|put|delete|patch)\(([^\)]*)\)\s*[\r\n]+\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi;
  let routeMatch: RegExpExecArray | null;
  while ((routeMatch = routeRegex.exec(input.source)) !== null) {
    const method = (routeMatch[2] ?? "").toUpperCase() as RouteRecord["httpMethod"];
    const argText = routeMatch[3] ?? "";
    const handlerName = routeMatch[4] ?? "";
    const line = lineFromOffset(input.source, routeMatch.index);
    const template = extractFirstStringLiteral(argText) ?? "/";
    const handlerSymbolId = functionByName.get(handlerName) ?? moduleSymbolId;

    routes.push({
      repoId: input.repoId,
      filePath: input.filePath,
      controllerSymbolId: moduleSymbolId,
      handlerSymbolId,
      // MCP-ISSUE-055: the name as written at the registration site, kept even when unresolved.
      handlerName: handlerName.length > 0 ? handlerName : null,
      httpMethod: method,
      routeTemplate: template.startsWith("/") ? template : `/${template}`,
      line
    });
  }
}
