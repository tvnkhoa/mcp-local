/**
 * PROPERTY_REF / PROPERTY_WRITE edges for C#.
 *
 * The read/write distinction is the point (ISSUE-018): `find_field_accesses` has to answer
 * "who writes this field" separately from "who reads it", and object initializers,
 * compound assignments and nested member chains each reach a property differently.
 */

import type Parser from "tree-sitter";
import type { ExtractInput } from "./extractorTypes.js";
import type { EdgeRecord } from "../../types/index.js";
import {
  collectCSharpScopeTypeMap,
  emitPropertyAccessEdge,
  findEnclosingCSharpSymbolId,
  findEnclosingCSharpTypeName,
  isAncestorInvocation,
  isSameNode
} from "./extractorUtils.js";

export function extractPropertyAccessEdges(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  edges: EdgeRecord[],
  moduleSymbolId: string
): void {
  // Extract property reads from member_access_expression
  for (const node of root.descendantsOfType(["member_access_expression"])) {
    const nameNode = node.childForFieldName("name");
    const expressionNode = node.childForFieldName("expression");
    if (!nameNode || !expressionNode) continue;

    const propertyName = nameNode.text.trim();
    if (!propertyName || propertyName.length < 2) continue;

    // P1.2: Skip if this member_access is used as a method call at any ancestor level.
    // Covers both direct parent invocation and chained LINQ patterns like
    // query.Where(...).Select(...).ToListAsync()
    if (node.parent?.type === "invocation_expression" && node.parent.childForFieldName("function") === node) {
      continue;
    }
    if (isAncestorInvocation(node)) {
      continue;
    }

    // Determine if this is a write or read
    const isWrite = isPropertyWrite(node);
    // ENH-029-B: capture the assigned RHS so find_field_accesses can report the value-domain.
    const assignedExpression = isWrite ? getAssignedExpressionText(node) : undefined;

    // Extract the full member access chain for nested properties
    // Example: conv.IdentityState.CrmCustomerId
    // Emit edges for:
    // 1. Conversation.IdentityState (if conv type is known)
    // 2. IdentityState.CrmCustomerId
    // 3. CrmCustomerId (fallback)
    const memberChain = extractMemberAccessChain(node);
    const scopeTypeMap = collectCSharpScopeTypeMap(node, /* includeDiAliases */ false);
    const fromId = findEnclosingCSharpSymbolId(node, input) ?? moduleSymbolId;

    // Emit edges for each level of the chain
    emitNestedPropertyEdges(input, fromId, node, memberChain, scopeTypeMap, isWrite, edges, assignedExpression);
  }

  // Extract property assignments from object initializers
  // Pattern: new ClassName { PropertyName = value, ... }
  for (const initNode of root.descendantsOfType(["initializer_expression"])) {
    // Try to infer the type being initialized from various contexts
    const typeName = inferObjectInitializerType(initNode);
    if (!typeName) continue;

    // Extract all assignment expressions inside the initializer
    for (const assignment of initNode.descendantsOfType(["assignment_expression"])) {
      const leftNode = assignment.childForFieldName("left");
      if (!leftNode || leftNode.type !== "identifier") continue;

      const propertyName = leftNode.text.trim();
      if (!propertyName) continue;

      const propertyToken = `${typeName}.${propertyName}`;
      const fromId = findEnclosingCSharpSymbolId(initNode, input) ?? moduleSymbolId;

      // Object initializer assignments are writes; capture the RHS (ENH-029-B).
      const rightNode = assignment.childForFieldName("right");
      const assignedExpression = rightNode ? truncateAssignedExpression(rightNode.text) : undefined;
      emitPropertyAccessEdge(input, fromId, propertyToken, true, edges, assignedExpression);
    }
  }
}

/** Max stored length for a captured RHS — keeps the edge row compact for long initializers. */
const MAX_ASSIGNED_EXPRESSION_LEN = 200;

function truncateAssignedExpression(text: string): string | undefined {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_ASSIGNED_EXPRESSION_LEN ? `${trimmed.slice(0, MAX_ASSIGNED_EXPRESSION_LEN)}…` : trimmed;
}

/**
 * RHS source text of a `member.prop = <expr>` (or compound-assignment) write, for ENH-029-B.
 * Returns undefined when the node is not the left side of an assignment.
 */
function getAssignedExpressionText(node: Parser.SyntaxNode): string | undefined {
  const parent = node.parent;
  if (!parent) return undefined;
  const ASSIGN_TYPES = new Set([
    "assignment_expression",
    "add_assignment_expression",
    "subtract_assignment_expression",
    "multiply_assignment_expression",
    "divide_assignment_expression"
  ]);
  if (!ASSIGN_TYPES.has(parent.type)) return undefined;
  const right = parent.childForFieldName("right");
  return right ? truncateAssignedExpression(right.text) : undefined;
}

/**
 * Extract the full member access chain from a member_access_expression node.
 * Example: conv.IdentityState.CrmCustomerId → ["conv", "IdentityState", "CrmCustomerId"]
 */
function extractMemberAccessChain(node: Parser.SyntaxNode): string[] {
  const chain: string[] = [];
  let current: Parser.SyntaxNode | null = node;

  while (current && current.type === "member_access_expression") {
    const nameNode = current.childForFieldName("name");
    if (nameNode) {
      chain.unshift(nameNode.text.trim());
    }
    current = current.childForFieldName("expression");
  }

  // Add the base identifier or this expression
  if (current) {
    if (current.type === "identifier") {
      chain.unshift(current.text.trim());
    } else if (current.type === "this_expression") {
      chain.unshift("this");
    }
  }

  return chain;
}

/**
 * Emit property edges for nested member access chains.
 * For conv.IdentityState.CrmCustomerId, emit:
 * 1. Conversation.IdentityState (if conv type is Conversation)
 * 2. IdentityState.CrmCustomerId
 * 3. CrmCustomerId (fallback)
 */
function emitNestedPropertyEdges(
  input: ExtractInput,
  fromId: string,
  node: Parser.SyntaxNode,
  memberChain: string[],
  scopeTypeMap: Map<string, string>,
  isWrite: boolean,
  edges: EdgeRecord[],
  assignedExpression?: string
): void {
  if (memberChain.length === 0) return;

  // For single-level access (e.g., conv.Property), use original logic
  if (memberChain.length === 2) {
    const [receiver, property] = memberChain;
    let declaringType: string | undefined;

    if (receiver === "this") {
      declaringType = findEnclosingCSharpTypeName(node);
    } else {
      declaringType = scopeTypeMap.get(receiver);
    }

    const propertyToken = declaringType ? `${declaringType}.${property}` : property;
    emitPropertyAccessEdge(input, fromId, propertyToken, isWrite, edges, assignedExpression);
    return;
  }

  // For nested access (e.g., conv.IdentityState.CrmCustomerId)
  // Emit edges for each pair in the chain
  for (let i = 0; i < memberChain.length - 1; i++) {
    const left = memberChain[i];
    const right = memberChain[i + 1];

    if (i === 0) {
      // First level: try to resolve base type
      let baseType: string | undefined;
      if (left === "this") {
        baseType = findEnclosingCSharpTypeName(node);
      } else {
        baseType = scopeTypeMap.get(left);
      }

      const writeHere = i === memberChain.length - 2 && isWrite;
      if (baseType) {
        // Emit: BaseType.Property
        emitPropertyAccessEdge(input, fromId, `${baseType}.${right}`, writeHere, edges, writeHere ? assignedExpression : undefined);
      } else {
        // Fallback: emit unqualified
        emitPropertyAccessEdge(input, fromId, right, writeHere, edges, writeHere ? assignedExpression : undefined);
      }
    } else {
      // Subsequent levels: emit as Type.Property pairs
      // Example: IdentityState.CrmCustomerId
      const writeHere = i === memberChain.length - 2 && isWrite;
      emitPropertyAccessEdge(input, fromId, `${left}.${right}`, writeHere, edges, writeHere ? assignedExpression : undefined);
    }
  }

  // Also emit the final property name as fallback
  const finalProperty = memberChain[memberChain.length - 1];
  if (finalProperty) {
    emitPropertyAccessEdge(input, fromId, finalProperty, isWrite, edges, isWrite ? assignedExpression : undefined);
  }
}

/**
 * Infer the type name from an object initializer expression.
 * Handles multiple contexts:
 * - Direct: new Type { ... }
 * - Argument: Method(new Type { ... })
 * - Collection: new List<Type> { new Type { ... } }
 * - Return: return new Type { ... }
 * - Assignment: var x = new Type { ... }
 */
function inferObjectInitializerType(initNode: Parser.SyntaxNode): string | null {
  const parent = initNode.parent;
  if (!parent) return null;

  // Context 1: Direct object creation - new Type { ... }
  if (parent.type === "object_creation_expression") {
    const typeNode = parent.childForFieldName("type");
    if (typeNode) {
      return typeNode.text.trim().replace(/<.*>/, "").trim();
    }
  }

  // Context 2: Argument - Method(new Type { ... })
  // The parent is object_creation_expression, grandparent is argument
  if (parent.type === "object_creation_expression" && parent.parent?.type === "argument") {
    const typeNode = parent.childForFieldName("type");
    if (typeNode) {
      return typeNode.text.trim().replace(/<.*>/, "").trim();
    }
  }

  // Context 3: Collection initializer - new List<Type> { new Type { ... }, ... }
  // The parent is object_creation_expression, grandparent is initializer_expression
  if (parent.type === "object_creation_expression" && parent.parent?.type === "initializer_expression") {
    const typeNode = parent.childForFieldName("type");
    if (typeNode) {
      return typeNode.text.trim().replace(/<.*>/, "").trim();
    }
  }

  // Context 4: Return statement - return new Type { ... }
  if (parent.type === "object_creation_expression" && parent.parent?.type === "return_statement") {
    const typeNode = parent.childForFieldName("type");
    if (typeNode) {
      return typeNode.text.trim().replace(/<.*>/, "").trim();
    }
  }

  // Context 5: Variable assignment - var x = new Type { ... }
  if (parent.type === "object_creation_expression") {
    const typeNode = parent.childForFieldName("type");
    if (typeNode) {
      return typeNode.text.trim().replace(/<.*>/, "").trim();
    }
  }

  return null;
}

function isPropertyWrite(node: Parser.SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;

  // Check if this is the left side of an assignment
  if (parent.type === "assignment_expression") {
    const leftNode = parent.childForFieldName("left");
    return isSameNode(leftNode, node);
  }

  // Check for compound assignments (+=, -=, etc.)
  if (parent.type === "add_assignment_expression" ||
      parent.type === "subtract_assignment_expression" ||
      parent.type === "multiply_assignment_expression" ||
      parent.type === "divide_assignment_expression") {
    const leftNode = parent.childForFieldName("left");
    return isSameNode(leftNode, node);
  }

  return false;
}

// HTTP method names supported by ASP.NET Minimal API MapXxx conventions
