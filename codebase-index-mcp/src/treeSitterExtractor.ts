import { createHash } from "node:crypto";

import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";
import CSharp from "tree-sitter-c-sharp";
import Python from "tree-sitter-python";
import Go from "tree-sitter-go";
import Java from "tree-sitter-java";
import Ruby from "tree-sitter-ruby";
import Rust from "tree-sitter-rust";
import PHP from "tree-sitter-php";

import type { EdgeRecord, SymbolRecord } from "./types.js";

export type ExtractInput = {
  repoId: string;
  filePath: string;
  language: string;
  source: string;
};

export type ExtractOutput = {
  symbols: SymbolRecord[];
  edges: EdgeRecord[];
};

export function extractGraphData(input: ExtractInput): ExtractOutput {
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

  const tree = parser.parse(input.source);
  const root = tree.rootNode;

  const edges: EdgeRecord[] = [];

  // Extract based on language
  if (input.language === "javascript" || input.language === "typescript") {
    extractJavaScriptSymbols(input, root, symbols, edges, moduleSymbolId);
  } else if (input.language === "csharp") {
    extractCSharpSymbols(input, root, symbols, edges, moduleSymbolId);
  } else if (input.language === "python") {
    extractPythonSymbols(input, root, symbols, edges, moduleSymbolId);
  } else if (input.language === "go") {
    extractGoSymbols(input, root, symbols, edges, moduleSymbolId);
  } else if (input.language === "java") {
    extractJavaSymbols(input, root, symbols, edges, moduleSymbolId);
  } else if (input.language === "ruby") {
    extractRubySymbols(input, root, symbols, edges, moduleSymbolId);
  } else if (input.language === "rust") {
    extractRustSymbols(input, root, symbols, edges, moduleSymbolId);
  } else if (input.language === "php") {
    extractPHPSymbols(input, root, symbols, edges, moduleSymbolId);
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

  if (language === "python") {
    parser.setLanguage(Python);
    return parser;
  }

  if (language === "go") {
    parser.setLanguage(Go);
    return parser;
  }

  if (language === "java") {
    parser.setLanguage(Java);
    return parser;
  }

  if (language === "ruby") {
    parser.setLanguage(Ruby);
    return parser;
  }

  if (language === "rust") {
    parser.setLanguage(Rust);
    return parser;
  }

  if (language === "php") {
    parser.setLanguage((PHP as any).php || PHP);
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

// JavaScript/TypeScript extractor
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
            toId: stableId(`${input.repoId}:dep:${dependency}`),
            type: "IMPORTS"
          });
        }
      }
    } else if (node.type === "call_expression") {
      const functionNode = node.childForFieldName("function");
      if (functionNode?.type === "identifier") {
        const callee = functionNode.text.trim();
        if (callee) {
          edges.push({
            repoId: input.repoId,
            fromId: moduleSymbolId,
            toId: stableId(`${input.repoId}:callee:${callee}`),
            type: "CALLS"
          });
        }
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
      line: node.startPosition.row + 1
    });
  }

  // Exported arrow functions: export const fn = () => ...
  for (const node of root.descendantsOfType(["lexical_declaration"])) {
    // Only care about top-level exported const
    const parent = node.parent;
    if (parent?.type !== "export_statement" && node.parent?.type !== "program") continue;

    for (const declarator of node.descendantsOfType(["variable_declarator"])) {
      const nameNode = declarator.childForFieldName("name");
      const valueNode = declarator.childForFieldName("value");
      if (!nameNode) continue;
      if (!valueNode) continue;
      if (valueNode.type !== "arrow_function" && valueNode.type !== "function") continue;

      symbols.push({
        repoId: input.repoId,
        symbolId: stableId(`${input.repoId}:${input.filePath}:function:${nameNode.text}:${node.startPosition.row}`),
        filePath: input.filePath,
        name: nameNode.text,
        kind: "function",
        line: node.startPosition.row + 1
      });
    }
  }
}

// C# extractor
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
        toId: stableId(`${input.repoId}:dep:${nameNode.text}`),
        type: "IMPORTS"
      });
    }
  }

  // Extract invocation expressions (method calls)
  for (const node of root.descendantsOfType(["invocation_expression"])) {
    const functionNode = node.childForFieldName("function");
    if (functionNode) {
      // Handle simple identifiers and member access
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
        edges.push({
          repoId: input.repoId,
          fromId: moduleSymbolId,
          toId: stableId(`${input.repoId}:callee:${calleeName}`),
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
        edges.push({
          repoId: input.repoId,
          fromId: moduleSymbolId,
          toId: stableId(`${input.repoId}:type:${typeName}`),
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

      symbols.push({
        repoId: input.repoId,
        symbolId: stableId(`${input.repoId}:${input.filePath}:${kind}:${nameNode.text}:${node.startPosition.row}`),
        filePath: input.filePath,
        name: nameNode.text,
        kind,
        line: node.startPosition.row + 1
      });
    }
  }
}

// Python extractor
function extractPythonSymbols(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  symbols: SymbolRecord[],
  edges: EdgeRecord[],
  moduleSymbolId: string
): void {
  for (const node of root.descendantsOfType(["import_statement", "import_from_statement"])) {
    const nameNode = node.childForFieldName("name") || node.child(1);
    if (nameNode) {
      edges.push({
        repoId: input.repoId,
        fromId: moduleSymbolId,
        toId: stableId(`${input.repoId}:dep:${nameNode.text}`),
        type: "IMPORTS"
      });
    }
  }

  for (const node of root.descendantsOfType(["function_definition", "class_definition"])) {
    const nameNode = node.childForFieldName("name");
    if (nameNode) {
      symbols.push({
        repoId: input.repoId,
        symbolId: stableId(`${input.repoId}:${input.filePath}:${node.type}:${nameNode.text}:${node.startPosition.row}`),
        filePath: input.filePath,
        name: nameNode.text,
        kind: node.type === "function_definition" ? "function" : "class",
        line: node.startPosition.row + 1
      });
    }
  }
}

// Go extractor
function extractGoSymbols(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  symbols: SymbolRecord[],
  edges: EdgeRecord[],
  moduleSymbolId: string
): void {
  for (const node of root.descendantsOfType(["import_declaration"])) {
    for (const spec of node.descendantsOfType(["import_spec"])) {
      const pathNode = spec.childForFieldName("path");
      if (pathNode) {
        edges.push({
          repoId: input.repoId,
          fromId: moduleSymbolId,
          toId: stableId(`${input.repoId}:dep:${stripQuotes(pathNode.text)}`),
          type: "IMPORTS"
        });
      }
    }
  }

  for (const node of root.descendantsOfType(["function_declaration", "type_declaration"])) {
    const nameNode = node.childForFieldName("name");
    if (nameNode) {
      symbols.push({
        repoId: input.repoId,
        symbolId: stableId(`${input.repoId}:${input.filePath}:${node.type}:${nameNode.text}:${node.startPosition.row}`),
        filePath: input.filePath,
        name: nameNode.text,
        kind: node.type === "function_declaration" ? "function" : "type",
        line: node.startPosition.row + 1
      });
    }
  }
}

// Java extractor
function extractJavaSymbols(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  symbols: SymbolRecord[],
  edges: EdgeRecord[],
  moduleSymbolId: string
): void {
  for (const node of root.descendantsOfType(["import_declaration"])) {
    const nameNode = node.child(1);
    if (nameNode) {
      edges.push({
        repoId: input.repoId,
        fromId: moduleSymbolId,
        toId: stableId(`${input.repoId}:dep:${nameNode.text}`),
        type: "IMPORTS"
      });
    }
  }

  for (const node of root.descendantsOfType(["class_declaration", "interface_declaration", "method_declaration"])) {
    const nameNode = node.childForFieldName("name");
    if (nameNode) {
      const kind = node.type === "method_declaration" ? "method" : node.type === "interface_declaration" ? "interface" : "class";
      symbols.push({
        repoId: input.repoId,
        symbolId: stableId(`${input.repoId}:${input.filePath}:${kind}:${nameNode.text}:${node.startPosition.row}`),
        filePath: input.filePath,
        name: nameNode.text,
        kind,
        line: node.startPosition.row + 1
      });
    }
  }
}

// Ruby extractor
function extractRubySymbols(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  symbols: SymbolRecord[],
  edges: EdgeRecord[],
  moduleSymbolId: string
): void {
  for (const node of root.descendantsOfType(["call"])) {
    const methodNode = node.childForFieldName("method");
    if (methodNode?.text === "require" || methodNode?.text === "require_relative") {
      const argNode = node.descendantsOfType(["string"])[0];
      if (argNode) {
        edges.push({
          repoId: input.repoId,
          fromId: moduleSymbolId,
          toId: stableId(`${input.repoId}:dep:${stripQuotes(argNode.text)}`),
          type: "IMPORTS"
        });
      }
    }
  }

  for (const node of root.descendantsOfType(["method", "class", "module"])) {
    const nameNode = node.childForFieldName("name");
    if (nameNode) {
      const rubyKind: SymbolRecord["kind"] =
        node.type === "method" ? "method" :
        node.type === "class" ? "class" :
        node.type === "module" ? "module" : "unknown";
      symbols.push({
        repoId: input.repoId,
        symbolId: stableId(`${input.repoId}:${input.filePath}:${node.type}:${nameNode.text}:${node.startPosition.row}`),
        filePath: input.filePath,
        name: nameNode.text,
        kind: rubyKind,
        line: node.startPosition.row + 1
      });
    }
  }
}

// Rust extractor
function extractRustSymbols(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  symbols: SymbolRecord[],
  edges: EdgeRecord[],
  moduleSymbolId: string
): void {
  for (const node of root.descendantsOfType(["use_declaration"])) {
    const argNode = node.childForFieldName("argument");
    if (argNode) {
      edges.push({
        repoId: input.repoId,
        fromId: moduleSymbolId,
        toId: stableId(`${input.repoId}:dep:${argNode.text}`),
        type: "IMPORTS"
      });
    }
  }

  for (const node of root.descendantsOfType(["function_item", "struct_item", "impl_item"])) {
    const nameNode = node.childForFieldName("name");
    if (nameNode) {
      const kind = node.type === "function_item" ? "function" : node.type === "struct_item" ? "struct" : "impl";
      symbols.push({
        repoId: input.repoId,
        symbolId: stableId(`${input.repoId}:${input.filePath}:${kind}:${nameNode.text}:${node.startPosition.row}`),
        filePath: input.filePath,
        name: nameNode.text,
        kind,
        line: node.startPosition.row + 1
      });
    }
  }
}

// PHP extractor
function extractPHPSymbols(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  symbols: SymbolRecord[],
  edges: EdgeRecord[],
  moduleSymbolId: string
): void {
  for (const node of root.descendantsOfType(["namespace_use_declaration"])) {
    for (const clause of node.descendantsOfType(["namespace_use_clause"])) {
      const nameNode = clause.childForFieldName("name");
      if (nameNode) {
        edges.push({
          repoId: input.repoId,
          fromId: moduleSymbolId,
          toId: stableId(`${input.repoId}:dep:${nameNode.text}`),
          type: "IMPORTS"
        });
      }
    }
  }

  for (const node of root.descendantsOfType(["function_definition", "class_declaration", "method_declaration"])) {
    const nameNode = node.childForFieldName("name");
    if (nameNode) {
      const kind = node.type === "function_definition" ? "function" : node.type === "method_declaration" ? "method" : "class";
      symbols.push({
        repoId: input.repoId,
        symbolId: stableId(`${input.repoId}:${input.filePath}:${kind}:${nameNode.text}:${node.startPosition.row}`),
        filePath: input.filePath,
        name: nameNode.text,
        kind,
        line: node.startPosition.row + 1
      });
    }
  }
}
