import type { EdgeRecord, SymbolRecord } from "../../types/index.js";
import type { ExtractInput } from "./extractorTypes.js";
import { stableId, lineFromOffset } from "./extractorUtils.js";

/**
 * Regex-based extractor for Protocol Buffer (.proto) files.
 *
 * Extracts:
 * - Services  → kind: "class"    (gRPC service definitions)
 * - RPCs      → kind: "method"   (rpc methods inside services)
 * - Messages  → kind: "interface" (message type definitions)
 * - Enums     → kind: "type"
 * - Imports   → IMPORTS edges    (proto import statements)
 *
 * No tree-sitter grammar needed — proto syntax is simple enough for regex.
 */
export function extractProtoSymbolsImpl(
  input: ExtractInput,
  symbols: SymbolRecord[],
  edges: EdgeRecord[],
  moduleSymbolId: string
): void {
  const { repoId, filePath, source } = input;

  // ── imports ──────────────────────────────────────────────────────────────
  // import "google/protobuf/timestamp.proto";
  // import "some/other/service.proto";
  const importRegex = /^\s*import\s+"([^"]+)"\s*;/gm;
  let importMatch: RegExpExecArray | null;
  while ((importMatch = importRegex.exec(source)) !== null) {
    const dep = importMatch[1] ?? "";
    if (dep) {
      edges.push({
        repoId,
        fromId: moduleSymbolId,
        toId: `import:${dep}`,
        type: "IMPORTS"
      });
    }
  }

  // ── package ───────────────────────────────────────────────────────────────
  // package customer;
  const packageMatch = /^\s*package\s+([A-Za-z0-9_.]+)\s*;/m.exec(source);
  const packageName = packageMatch?.[1] ?? null;

  // ── services ──────────────────────────────────────────────────────────────
  // service CustomerProto { ... }
  const serviceRegex = /^\s*service\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm;
  let serviceMatch: RegExpExecArray | null;
  while ((serviceMatch = serviceRegex.exec(source)) !== null) {
    const name = serviceMatch[1];
    const line = lineFromOffset(source, serviceMatch.index);
    const qualifiedName = packageName ? `${packageName}.${name}` : name;
    const symbolId = stableId(`${repoId}:${filePath}:service:${name}:${line - 1}`);

    symbols.push({
      repoId,
      symbolId,
      filePath,
      name,
      kind: "class",
      line,
      signature: `service ${qualifiedName}`
    });

    // Extract RPCs inside this service block
    // Find the matching closing brace for this service
    const serviceBodyStart = serviceMatch.index + serviceMatch[0].length;
    const serviceBody = extractBlock(source, serviceBodyStart);

    // rpc MethodName (RequestType) returns (ResponseType);
    // rpc MethodName (stream RequestType) returns (stream ResponseType);
    const rpcRegex = /^\s*rpc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*(stream\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*\)\s*returns\s*\(\s*(stream\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*\)/gm;
    let rpcMatch: RegExpExecArray | null;
    while ((rpcMatch = rpcRegex.exec(serviceBody.text)) !== null) {
      const rpcName = rpcMatch[1];
      const requestStream = !!rpcMatch[2];
      const requestType = rpcMatch[3];
      const responseStream = !!rpcMatch[4];
      const responseType = rpcMatch[5];

      // Line number relative to file
      const rpcLine = lineFromOffset(source, serviceBodyStart + rpcMatch.index);
      const rpcSymbolId = stableId(`${repoId}:${filePath}:rpc:${name}.${rpcName}:${rpcLine - 1}`);

      const requestSig = requestStream ? `stream ${requestType}` : requestType;
      const responseSig = responseStream ? `stream ${responseType}` : responseType;

      symbols.push({
        repoId,
        symbolId: rpcSymbolId,
        filePath,
        name: rpcName,
        kind: "method",
        line: rpcLine,
        signature: `rpc ${rpcName}(${requestSig}) returns (${responseSig})`
      });

      // CALLS edge: service → rpc
      edges.push({
        repoId,
        fromId: symbolId,
        toId: rpcSymbolId,
        type: "CALLS",
        confidence: 1.0
      });
    }
  }

  // ── messages ──────────────────────────────────────────────────────────────
  // message CustomerListRequestDto { ... }
  const messageRegex = /^\s*message\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm;
  let messageMatch: RegExpExecArray | null;
  while ((messageMatch = messageRegex.exec(source)) !== null) {
    const name = messageMatch[1];
    const line = lineFromOffset(source, messageMatch.index);
    const qualifiedName = packageName ? `${packageName}.${name}` : name;
    const symbolId = stableId(`${repoId}:${filePath}:message:${name}:${line - 1}`);

    symbols.push({
      repoId,
      symbolId,
      filePath,
      name,
      kind: "interface",
      line,
      signature: `message ${qualifiedName}`
    });
  }

  // ── enums ─────────────────────────────────────────────────────────────────
  // enum SomeEnum { ... }
  const enumRegex = /^\s*enum\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm;
  let enumMatch: RegExpExecArray | null;
  while ((enumMatch = enumRegex.exec(source)) !== null) {
    const name = enumMatch[1];
    const line = lineFromOffset(source, enumMatch.index);
    const qualifiedName = packageName ? `${packageName}.${name}` : name;
    const symbolId = stableId(`${repoId}:${filePath}:enum:${name}:${line - 1}`);

    symbols.push({
      repoId,
      symbolId,
      filePath,
      name,
      kind: "type",
      line,
      signature: `enum ${qualifiedName}`
    });
  }
}

/**
 * Extracts the text content of a brace-delimited block starting at `startIndex`
 * (which should point to the character AFTER the opening `{`).
 * Returns the inner text and the absolute end index.
 */
function extractBlock(source: string, startIndex: number): { text: string; endIndex: number } {
  let depth = 1;
  let i = startIndex;
  while (i < source.length && depth > 0) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
    i++;
  }
  return { text: source.slice(startIndex, i - 1), endIndex: i };
}
