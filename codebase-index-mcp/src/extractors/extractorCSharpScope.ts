/**
 * C# scope analysis: what type a name refers to at a given point in a file.
 *
 * This is what makes C# call resolution work without a compiler. `collectCSharpScopeTypeMap`
 * walks constructor parameters, field declarations and DI registrations to map an identifier to
 * its declared type, which is how an interface-typed call reaches its implementation.
 */

import type Parser from "tree-sitter";
import type { ExtractInput } from "./extractorTypes.js";
import { optionalStringFromEnv } from "../config/envConfig.js";
import { stableId, stripQuotes } from "./extractorPrimitives.js";

export function extractCSharpUsingNamespace(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  const raw = (nameNode?.text ?? node.text)
    .replace(/^\s*global\s+using\s+/i, "")
    .replace(/^\s*using\s+/i, "")
    .replace(/\s*=\s*.+$/, "")
    .replace(/;\s*$/, "")
    .trim();

  if (!raw || raw.length < 2 || !raw.includes(".")) {
    return null;
  }

  return raw;
}

export function mapUsingNamespaceToNugetContract(namespaceImport: string, knownPackageNames?: Set<string>): string | null {
  const normalized = namespaceImport.trim();

  // Hardcoded contract bridge for CommunicationHub package family.
  if (/^SSNet\.CommunicationHub\.Messaging(\.|$)/i.test(normalized)) {
    return "nuget:ssnet.communicationhub.messaging";
  }

  // Config-driven overrides via NUGET_NAMESPACE_MAP env var.
  // Format: JSON array of { "prefix": "My.Namespace", "contractId": "nuget:my.package" }
  const envMap = optionalStringFromEnv("NUGET_NAMESPACE_MAP");
  if (envMap) {
    try {
      const entries = JSON.parse(envMap) as { prefix: string; contractId: string }[];
      for (const entry of entries) {
        if (entry.prefix && entry.contractId) {
          const re = new RegExp(`^${entry.prefix.replace(/\./g, "\\.")}(\\.|$)`, "i");
          if (re.test(normalized)) {
            return entry.contractId.startsWith("nuget:") ? entry.contractId : `nuget:${entry.contractId.toLowerCase()}`;
          }
        }
      }
    } catch {
      // Malformed env var — ignore silently
    }
  }

  // Heuristic: if the root namespace segment matches a known PackageReference name
  // (case-insensitive), emit a nuget: contract edge for it.
  // Example: using MassTransit.X → knownPackageNames has "MassTransit" → nuget:masstransit
  if (knownPackageNames && knownPackageNames.size > 0) {
    const rootSegment = normalized.split(".")[0] ?? "";
    for (const pkg of knownPackageNames) {
      if (pkg.toLowerCase() === rootSegment.toLowerCase()) {
        return `nuget:${pkg.toLowerCase()}`;
      }
      // Also match multi-segment package names where namespace starts with the package name
      if (normalized.toLowerCase().startsWith(pkg.toLowerCase() + ".") ||
          normalized.toLowerCase() === pkg.toLowerCase()) {
        return `nuget:${pkg.toLowerCase()}`;
      }
    }
  }

  return null;
}

export function normalizeCSharpTypeName(raw: string): string {
  return raw
    .replace(/\s*<.*>$/, "")
    .replace(/\s*\[\s*\]\s*$/, "")
    .trim();
}

export function isLikelyCSharpInterfaceName(rawTypeName: string): boolean {
  const normalized = normalizeCSharpTypeName(rawTypeName);
  return /^I[A-Z]/.test(normalized);
}

export function findEnclosingCSharpTypeName(node: Parser.SyntaxNode): string | undefined {
  const CLASS_TYPES = new Set(["class_declaration", "struct_declaration", "interface_declaration", "record_declaration"]);
  let current: Parser.SyntaxNode | null = node.parent;

  while (current) {
    if (CLASS_TYPES.has(current.type)) {
      const nameNode = current.childForFieldName("name");
      if (nameNode) {
        return nameNode.text.trim();
      }
    }
    current = current.parent;
  }

  return undefined;
}

export function findEnclosingCSharpSymbolId(node: Parser.SyntaxNode, input: ExtractInput): string | null {
  const FUNCTION_TYPES = new Set([
    "method_declaration",
    "constructor_declaration",
    "property_declaration",
    "class_declaration",
    "struct_declaration"
  ]);
  let current: Parser.SyntaxNode | null = node.parent;

  while (current) {
    if (FUNCTION_TYPES.has(current.type)) {
      const nameNode = current.childForFieldName("name");
      if (nameNode) {
        // kind must match the format used in csharpExtractor symbol insertion:
        // stableId(`${repoId}:${filePath}:${kind}:${name}:${node.startPosition.row}`)
        // NOTE: symbol insertion uses row (0-indexed), NOT row+1
        const kind = current.type === "method_declaration" ? "method"
          : current.type === "constructor_declaration" ? "constructor"
          : current.type === "property_declaration" ? "property"
          : current.type === "class_declaration" ? "class"
          : "struct";
        return stableId(`${input.repoId}:${input.filePath}:${kind}:${nameNode.text}:${current.startPosition.row}`);
      }
    }
    current = current.parent;
  }

  return null;
}

export function extractCSharpHttpDependencyContract(invocationNode: Parser.SyntaxNode): {
  httpMethod: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  endpoint: string;
} | null {
  const functionNode = invocationNode.childForFieldName("function");
  if (!functionNode || functionNode.type !== "member_access_expression") {
    return null;
  }

  const methodNameNode = functionNode.childForFieldName("name");
  if (!methodNameNode) {
    return null;
  }

  const methodName = methodNameNode.text.trim();
  const httpMethodMap: Record<string, "GET" | "POST" | "PUT" | "DELETE" | "PATCH"> = {
    GetAsync: "GET",
    PostAsync: "POST",
    PutAsync: "PUT",
    DeleteAsync: "DELETE",
    PatchAsync: "PATCH"
  };

  const httpMethod = httpMethodMap[methodName];
  if (!httpMethod) {
    return null;
  }

  const argsNode = invocationNode.childForFieldName("arguments");
  if (!argsNode) {
    return null;
  }

  const firstArg = argsNode.namedChildren[0];
  if (!firstArg) {
    return null;
  }

  let endpoint = firstArg.text.trim();
  if (firstArg.type === "string_literal" || firstArg.type === "verbatim_string_literal") {
    endpoint = stripQuotes(endpoint);
  } else if (firstArg.type === "interpolated_string_expression") {
    endpoint = firstArg.text.replace(/^\$@?["']|["']$/g, "").trim();
  }

  if (!endpoint || endpoint.length < 2) {
    return null;
  }

  return { httpMethod, endpoint };
}

// ============================================================================
// Scope Utilities
// ============================================================================

export function collectCSharpEnclosingMemberTypeMap(scopeNode: Parser.SyntaxNode): Map<string, string> {
  const typeMap = new Map<string, string>();
  const CLASS_TYPES = new Set(["class_declaration", "struct_declaration", "record_declaration"]);

  let current: Parser.SyntaxNode | null = scopeNode.parent;
  while (current) {
    if (CLASS_TYPES.has(current.type)) {
      // ISSUE-022 (Bug B): C# 12 primary-constructor params are a bare `parameter_list` named
      // child of the type declaration (no field name) — map them like DI fields so
      // `class Handler(INotificationPublisher publisher)` resolves `publisher.Method()` calls.
      for (const child of current.namedChildren) {
        if (child.type !== "parameter_list") continue;
        for (const param of child.namedChildren) {
          if (param.type !== "parameter") continue;
          const pTypeNode = param.childForFieldName("type");
          const pNameNode = param.childForFieldName("name");
          if (pTypeNode && pNameNode) {
            const pType = normalizeCSharpTypeName(pTypeNode.text.trim());
            const pName = pNameNode.text.trim();
            if (pType && pName) addCSharpTypeAliases(typeMap, pName, pType);
          }
        }
      }
      const bodyNode = current.childForFieldName("body");
      if (bodyNode) {
        for (const member of bodyNode.namedChildren) {
          if (member.type === "field_declaration" || member.type === "property_declaration") {
            // ISSUE-022 (Bug A): tree-sitter-c-sharp đặt `type` của field_declaration trên child
            // `variable_declaration`, không trực tiếp — childForFieldName("type") trả null nên
            // DI field types không bao giờ vào scope map. Fallback xuống variable_declaration.
            const typeNode =
              member.childForFieldName("type") ??
              member.descendantsOfType("variable_declaration")[0]?.childForFieldName("type") ??
              null;
            const declaratorNode = member.descendantsOfType("variable_declarator")[0];
            const nameNode = declaratorNode?.childForFieldName("name") ?? member.childForFieldName("name");

            if (typeNode && nameNode) {
              const typeName = normalizeCSharpTypeName(typeNode.text.trim());
              const memberName = nameNode.text.trim();
              if (typeName && memberName) {
                // P1.1: Map the field name as-is (e.g. _scopedContext → IScopedContext)
                typeMap.set(memberName, typeName);
                // Also map without leading underscores so both _repo and repo resolve
                // e.g. _scopedContext.TenantId → property:IScopedContext.TenantId
                const stripped = memberName.replace(/^_+/, "");
                if (stripped && stripped !== memberName) {
                  typeMap.set(stripped, typeName);
                }
                // Also map camelCase → PascalCase variant for common injection patterns
                // e.g. scopedContext → IScopedContext (when accessed as this.ScopedContext)
                if (stripped.length > 0) {
                  const pascal = stripped.charAt(0).toUpperCase() + stripped.slice(1);
                  if (!typeMap.has(pascal)) {
                    typeMap.set(pascal, typeName);
                  }
                }
              }
            }
          }
        }
      }
      break;
    }
    current = current.parent;
  }

  return typeMap;
}

function addCSharpTypeAliases(typeMap: Map<string, string>, memberName: string, typeName: string): void {
  if (!memberName || !typeName) {
    return;
  }

  if (!typeMap.has(memberName)) {
    typeMap.set(memberName, typeName);
  }

  const stripped = memberName.replace(/^_+/, "");
  if (stripped && !typeMap.has(stripped)) {
    typeMap.set(stripped, typeName);
  }

  if (stripped.length > 0) {
    const pascal = stripped.charAt(0).toUpperCase() + stripped.slice(1);
    if (!typeMap.has(pascal)) {
      typeMap.set(pascal, typeName);
    }
  }
}

export function collectCSharpScopeTypeMap(scopeNode: Parser.SyntaxNode, includeDiAliases = true): Map<string, string> {
  const typeMap = new Map<string, string>();

  // Collect local variable declarations
  const localDeclarations = scopeNode.descendantsOfType("local_declaration_statement");
  for (const decl of localDeclarations) {
    const typeNode = decl.childForFieldName("type");
    const declaratorNode = decl.descendantsOfType("variable_declarator")[0];
    const nameNode = declaratorNode?.childForFieldName("name");

    if (typeNode && nameNode) {
      const typeName = normalizeCSharpTypeName(typeNode.text.trim());
      const varName = nameNode.text.trim();
      if (typeName && varName) {
        typeMap.set(varName, typeName);
      }
    }
  }

  // Collect parameters from enclosing method/constructor
  // Walk up to find method_declaration or constructor_declaration
  let current: Parser.SyntaxNode | null = scopeNode;
  while (current) {
    if (current.type === "method_declaration" || 
        current.type === "constructor_declaration" ||
        current.type === "local_function_statement") {
      const paramListNode = current.childForFieldName("parameters");
      if (paramListNode) {
        for (const param of paramListNode.namedChildren) {
          if (param.type === "parameter") {
            const typeNode = param.childForFieldName("type");
            const nameNode = param.childForFieldName("name");

            if (typeNode && nameNode) {
              const typeName = normalizeCSharpTypeName(typeNode.text.trim());
              const paramName = nameNode.text.trim();
              if (typeName && paramName) {
                typeMap.set(paramName, typeName);
              }
            }
          }
        }
      }
      break; // Stop at first enclosing method
    }
    current = current.parent;
  }

  // Collect field/property types from enclosing class
  const enclosingMemberTypes = collectCSharpEnclosingMemberTypeMap(scopeNode);
  for (const [name, type] of enclosingMemberTypes) {
    if (!typeMap.has(name)) {
      typeMap.set(name, type);
    }
  }

  // Infer DI field types from constructor injection assignments.
  // Only when includeDiAliases=true (CALLS path). Property path skips this
  // to avoid emitting property:InterfaceType.Prop tokens that can't resolve.
  if (!includeDiAliases) {
    return typeMap;
  }

  let ctorCurrent: Parser.SyntaxNode | null = scopeNode;
  while (ctorCurrent) {
    if (ctorCurrent.type === "constructor_declaration") {
      for (const assignment of ctorCurrent.descendantsOfType("assignment_expression")) {
        const leftNode = assignment.childForFieldName("left");
        const rightNode = assignment.childForFieldName("right");
        if (!leftNode || !rightNode || rightNode.type !== "identifier") {
          continue;
        }

        const rhsType = typeMap.get(rightNode.text.trim());
        if (!rhsType) {
          continue;
        }

        let leftName = "";
        if (leftNode.type === "identifier") {
          leftName = leftNode.text.trim();
        } else if (leftNode.type === "member_access_expression") {
          const leftNameNode = leftNode.childForFieldName("name");
          leftName = leftNameNode?.text.trim() ?? "";
        }

        if (leftName) {
          addCSharpTypeAliases(typeMap, leftName, rhsType);
        }
      }
      break;
    }
    ctorCurrent = ctorCurrent.parent;
  }

  return typeMap;
}

// ============================================================================
// Edge Utilities
// ============================================================================
