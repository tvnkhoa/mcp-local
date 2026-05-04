import { createHash } from "node:crypto";

import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";
import CSharp from "tree-sitter-c-sharp";

import type { DocMentionRecord, DocRecord, EdgeRecord, SymbolRecord } from "./types.js";

import { parseMarkdownFile } from "./markdownParser.js";

export type ExtractInput = {
  repoId: string;
  filePath: string;
  language: string;
  source: string;
};

export type ExtractOutput = {
  symbols: SymbolRecord[];
  edges: EdgeRecord[];
  docs?: DocRecord[];
  mentions?: DocMentionRecord[];
};

export function extractGraphData(input: ExtractInput): ExtractOutput {  // Handle markdown separately
  if (input.language === "markdown") {
    return extractMarkdownFile(input);
  }
  const moduleSymbolId = stableId(`${input.repoId}:${input.filePath}:module`);

  const symbols: SymbolRecord[] = [
    {
      repoId: input.repoId,
      symbolId: moduleSymbolId,
      filePath: input.filePath,
      name: input.filePath.split(/[\\/]/).pop() ?? "unknown",
      kind: "module",
      line: 1
    }
  ];

  const parser = createParserForLanguage(input.language);
  if (!parser) {
    return { symbols, edges: [] };
  }

  const tree = parser.parse(input.source, undefined, { bufferSize: 1024 * 1024 });
  const root = tree.rootNode;

  const edges: EdgeRecord[] = [];

  // Extract based on language
  if (input.language === "javascript" || input.language === "typescript") {
    extractJavaScriptSymbols(input, root, symbols, edges, moduleSymbolId);
  } else if (input.language === "csharp") {
    extractCSharpSymbols(input, root, symbols, edges, moduleSymbolId);
  }

  return { symbols: dedupeSymbols(symbols), edges: dedupeEdges(edges) };
}

function stableId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

function createParserForLanguage(language: string): Parser | null {
  const parser = new Parser();

  if (language === "javascript") {
    parser.setLanguage(JavaScript);
    return parser;
  }

  if (language === "typescript") {
    parser.setLanguage(TypeScript.typescript);
    return parser;
  }

  if (language === "csharp") {
    parser.setLanguage(CSharp);
    return parser;
  }

  return null;
}

function stripQuotes(value: string): string {
  return value.replace(/^['\"]|['\"]$/g, "").trim();
}

function dedupeEdges(edges: EdgeRecord[]): EdgeRecord[] {
  const seen = new Set<string>();
  const output: EdgeRecord[] = [];

  for (const edge of edges) {
    const key = `${edge.repoId}:${edge.fromId}:${edge.toId}:${edge.type}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(edge);
  }

  return output;
}

function dedupeSymbols(symbols: SymbolRecord[]): SymbolRecord[] {
  const seen = new Set<string>();
  const output: SymbolRecord[] = [];

  for (const symbol of symbols) {
    const key = `${symbol.repoId}:${symbol.symbolId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(symbol);
  }

  return output;
}

/**
 * Walk up AST to find the nearest enclosing function/method node.
 * Returns the stable symbolId if found, otherwise null.
 */
function findEnclosingSymbolId(node: Parser.SyntaxNode, input: ExtractInput): string | null {
  const FUNCTION_TYPES = new Set([
    "function_declaration",
    "function_expression",
    "arrow_function",
    "method_definition"
  ]);
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (FUNCTION_TYPES.has(current.type)) {
      const nameNode =
        current.childForFieldName("name") ??
        current.parent?.childForFieldName("name") ?? // arrow assigned to variable
        null;
      if (nameNode) {
        const kind = current.type === "method_definition" ? "method" : "function";
        return stableId(`${input.repoId}:${input.filePath}:${kind}:${nameNode.text}:${current.startPosition.row}`);
      }
    }
    current = current.parent;
  }
  return null;
}

// JavaScript/TypeScript extractor

/**
 * Extract a compact signature string from a declaration node.
 * Returns text up to the opening brace (or full first line for short nodes).
 */
function extractSignature(node: Parser.SyntaxNode, maxLen = 300): string {
  const text = node.text;
  const braceIdx = text.indexOf("{");
  const raw = braceIdx > 0 ? text.slice(0, braceIdx).trim() : text.split("\n")[0].trim();
  return raw.replace(/\s+/g, " ").slice(0, maxLen);
}

function extractJavaScriptSymbols(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  symbols: SymbolRecord[],
  edges: EdgeRecord[],
  moduleSymbolId: string
): void {
  for (const node of root.descendantsOfType(["import_statement", "call_expression"])) {
    if (node.type === "import_statement") {
      const source = node.childForFieldName("source");
      if (source) {
        const dependency = stripQuotes(source.text);
        if (dependency) {
          edges.push({
            repoId: input.repoId,
            fromId: moduleSymbolId,
            toId: `import:${dependency}`,
            type: "IMPORTS"
          });
        }
      }
    } else if (node.type === "call_expression") {
      const functionNode = node.childForFieldName("function");
      let callee = "";
      if (functionNode?.type === "identifier") {
        callee = functionNode.text.trim();
      } else if (functionNode?.type === "member_expression") {
        // e.g. this.store.run() → property = "run"
        const prop = functionNode.childForFieldName("property");
        if (prop?.type === "property_identifier") {
          callee = prop.text.trim();
        }
      }
      if (callee) {
        const fromId = findEnclosingSymbolId(node, input) ?? moduleSymbolId;
        edges.push({
          repoId: input.repoId,
          fromId,
          toId: `callee:${callee}`,
          type: "CALLS"
        });
      }
    }
  }

  for (const node of root.descendantsOfType([
    "function_declaration",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "method_definition",
    "abstract_class_declaration"
  ])) {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) continue;

    let kind: SymbolRecord["kind"] = "unknown";
    if (node.type === "function_declaration") kind = "function";
    else if (node.type === "class_declaration" || node.type === "abstract_class_declaration") kind = "class";
    else if (node.type === "interface_declaration") kind = "interface";
    else if (node.type === "type_alias_declaration") kind = "type";
    else if (node.type === "enum_declaration") kind = "type";
    else if (node.type === "method_definition") kind = "method";

    symbols.push({
      repoId: input.repoId,
      symbolId: stableId(`${input.repoId}:${input.filePath}:${kind}:${nameNode.text}:${node.startPosition.row}`),
      filePath: input.filePath,
      name: nameNode.text,
      kind,
      line: node.startPosition.row + 1,
      signature: extractSignature(node)
    });
  }

  // Exported arrow functions / functions and exported constants
  for (const node of root.descendantsOfType(["lexical_declaration"])) {
    const parent = node.parent;
    const isExported = parent?.type === "export_statement";
    // Only process exported declarations or top-level (for arrow fns)
    if (!isExported && parent?.type !== "program") continue;

    for (const declarator of node.descendantsOfType(["variable_declarator"])) {
      const nameNode = declarator.childForFieldName("name");
      const valueNode = declarator.childForFieldName("value");
      if (!nameNode || nameNode.type !== "identifier") continue;
      if (!valueNode) continue;

      const isFunction = valueNode.type === "arrow_function" || valueNode.type === "function";

      if (isFunction) {
        // arrow function / function expression
        const sig = extractSignature(declarator).replace(/^(const|let|var)\s+/, "");
        symbols.push({
          repoId: input.repoId,
          symbolId: stableId(`${input.repoId}:${input.filePath}:function:${nameNode.text}:${node.startPosition.row}`),
          filePath: input.filePath,
          name: nameNode.text,
          kind: "function",
          line: node.startPosition.row + 1,
          signature: sig
        });
      } else if (isExported) {
        // exported constant / variable (non-function)
        const valPreview = valueNode.text.split("\n")[0].slice(0, 80);
        symbols.push({
          repoId: input.repoId,
          symbolId: stableId(`${input.repoId}:${input.filePath}:variable:${nameNode.text}:${node.startPosition.row}`),
          filePath: input.filePath,
          name: nameNode.text,
          kind: "variable",
          line: node.startPosition.row + 1,
          signature: `const ${nameNode.text} = ${valPreview}`
        });
      }
    }
  }
}

// C# extractor
/**
 * Walk up AST to find the nearest enclosing method/constructor node for C#.
 * Returns the stable symbolId if found, otherwise null.
 */
function findEnclosingCSharpSymbolId(node: Parser.SyntaxNode, input: ExtractInput): string | null {
  const ENCLOSING_TYPES = new Set([
    "method_declaration",
    "constructor_declaration",
    "operator_declaration",
    "accessor_declaration"
  ]);
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (ENCLOSING_TYPES.has(current.type)) {
      const nameNode = current.childForFieldName("name");
      if (nameNode) {
        const kind = current.type === "constructor_declaration" ? "constructor" : "method";
        return stableId(`${input.repoId}:${input.filePath}:${kind}:${nameNode.text}:${current.startPosition.row}`);
      }
    }
    current = current.parent;
  }
  return null;
}

function extractCSharpSymbols(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  symbols: SymbolRecord[],
  edges: EdgeRecord[],
  moduleSymbolId: string
): void {
  // Extract using directives (imports)
  for (const node of root.descendantsOfType(["using_directive"])) {
    const nameNode = node.childForFieldName("name");
    if (nameNode) {
      edges.push({
        repoId: input.repoId,
        fromId: moduleSymbolId,
        toId: `import:${nameNode.text}`,
        type: "IMPORTS"
      });
    }
  }

  // Extract invocation expressions (method calls)
  for (const node of root.descendantsOfType(["invocation_expression"])) {
    const functionNode = node.childForFieldName("function");
    if (functionNode) {
      let calleeName = "";
      if (functionNode.type === "identifier") {
        calleeName = functionNode.text;
      } else if (functionNode.type === "member_access_expression") {
        const nameNode = functionNode.childForFieldName("name");
        if (nameNode) {
          calleeName = nameNode.text;
        }
      }

      if (calleeName) {
        const fromId = findEnclosingCSharpSymbolId(node, input) ?? moduleSymbolId;
        edges.push({
          repoId: input.repoId,
          fromId,
          toId: `callee:${calleeName}`,
          type: "CALLS"
        });
      }
    }
  }

  // Extract object creation expressions (constructor calls)
  for (const node of root.descendantsOfType(["object_creation_expression"])) {
    const typeNode = node.childForFieldName("type");
    if (typeNode) {
      const typeName = typeNode.text;
      if (typeName) {
        const fromId = findEnclosingCSharpSymbolId(node, input) ?? moduleSymbolId;
        edges.push({
          repoId: input.repoId,
          fromId,
          toId: `callee:${typeName}`,
          type: "CALLS"
        });
      }
    }
  }

  // Extract class, interface, method, property, struct, namespace declarations
  for (const node of root.descendantsOfType([
    "class_declaration",
    "interface_declaration",
    "method_declaration",
    "property_declaration",
    "constructor_declaration",
    "struct_declaration",
    "enum_declaration",
    "namespace_declaration",
    "record_declaration"
  ])) {
    const nameNode = node.childForFieldName("name");
    if (nameNode) {
      let kind: SymbolRecord["kind"] = "unknown";
      if (node.type === "method_declaration") kind = "method";
      else if (node.type === "interface_declaration") kind = "interface";
      else if (node.type === "class_declaration") kind = "class";
      else if (node.type === "property_declaration") kind = "property";
      else if (node.type === "constructor_declaration") kind = "constructor";
      else if (node.type === "struct_declaration") kind = "struct";
      else if (node.type === "namespace_declaration") kind = "module";
      else if (node.type === "enum_declaration") kind = "type";
      else if (node.type === "record_declaration") kind = "class";

      const symbolId = stableId(`${input.repoId}:${input.filePath}:${kind}:${nameNode.text}:${node.startPosition.row}`);

      symbols.push({
        repoId: input.repoId,
        symbolId,
        filePath: input.filePath,
        name: nameNode.text,
        kind,
        line: node.startPosition.row + 1,
        signature: extractSignature(node)
      });

      // Emit IMPLEMENTS edges for class/struct/record base_list entries
      if (node.type === "class_declaration" || node.type === "struct_declaration" || node.type === "record_declaration") {
        const baseList = node.childForFieldName("bases");
        if (baseList) {
          for (const baseNode of baseList.children) {
            const baseName = baseNode.text.trim();
            // Skip punctuation and whitespace nodes
            if (!baseName || baseName === "," || baseName === ":" || baseName.length < 2) continue;
            // Strip generic type args: IRepository<User> → IRepository
            const cleanName = baseName.replace(/<.*>$/, "").trim();
            if (cleanName) {
              edges.push({
                repoId: input.repoId,
                fromId: symbolId,
                toId: `iface:${cleanName}`,
                type: "IMPLEMENTS"
              });
            }
          }
        }
      }
    }
  }
}

// Markdown extractor — parses headings, code blocks, and mentions
function extractMarkdownFile(input: ExtractInput): ExtractOutput {
  const { docs, mentions } = parseMarkdownFile(input);
  // Markdown files don't have traditional symbols, just docs and mentions
  return { symbols: [], edges: [], docs, mentions };
}
