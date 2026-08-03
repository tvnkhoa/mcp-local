import type Parser from "tree-sitter";
import type { StringLiteralRecord } from "../../types/index.js";
import type { ExtractInput } from "./extractorTypes.js";
import { findEnclosingCSharpSymbolId, findEnclosingSymbolId, stableId } from "./extractorUtils.js";

/**
 * ISSUE-023 — string-literal lane. Index string literals (notification titles, error
 * messages, log templates…) với { value, file, line, enclosingSymbolId } để audit
 * "mọi user-facing text repo này emit" là MỘT call MCP thay vì grep + full Read.
 *
 * Policy: min length + cap per file (per performance profile), dedup theo normalized
 * value trong file (literal_id không chứa line — giữ line đầu tiên), skip value quá dài
 * (embedded blob), skip literal trong C# attribute (JSONKEY lane đã cover) và trong
 * import/require (noise thuần).
 */

export type LiteralPolicy = {
  minLength: number;
  maxPerFile: number;
};

/** Giá trị dài hơn ngưỡng này là blob nhúng (base64, SQL dump…) — bỏ qua. */
const MAX_LITERAL_LENGTH = 500;

const CSHARP_STRING_NODE_TYPES = ["string_literal", "verbatim_string_literal", "raw_string_literal", "interpolated_string_expression"];
const JS_STRING_NODE_TYPES = ["string", "template_string"];

export function extractStringLiteralsImpl(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  policy: LiteralPolicy
): StringLiteralRecord[] {
  const isCSharp = input.language === "csharp";
  const nodeTypes = isCSharp ? CSHARP_STRING_NODE_TYPES : JS_STRING_NODE_TYPES;

  const out: StringLiteralRecord[] = [];
  const seenValues = new Set<string>();

  for (const node of root.descendantsOfType(nodeTypes)) {
    if (out.length >= policy.maxPerFile) break;
    // Interpolated/template node chứa string fragment con — chỉ xử lý node ngoài cùng.
    if (node.parent && nodeTypes.includes(node.parent.type)) continue;
    if (isCSharp ? isInsideCSharpAttribute(node) : isInsideJsImport(node)) continue;

    const { value, kind } = normalizeLiteral(node, isCSharp);
    if (value.length < policy.minLength || value.length > MAX_LITERAL_LENGTH) continue;
    if (seenValues.has(value)) continue;
    seenValues.add(value);

    const enclosingSymbolId = isCSharp
      ? findEnclosingCSharpSymbolId(node, input)
      : findEnclosingSymbolId(node, input);

    out.push({
      repoId: input.repoId,
      literalId: stableId(`${input.repoId}:${input.filePath}:literal:${value}`),
      filePath: input.filePath,
      line: node.startPosition.row + 1,
      value,
      enclosingSymbolId,
      language: input.language,
      kind
    });
  }

  return out;
}

function normalizeLiteral(node: Parser.SyntaxNode, isCSharp: boolean): { value: string; kind: StringLiteralRecord["kind"] } {
  if (isCSharp) {
    if (node.type === "interpolated_string_expression") {
      return { value: replaceChildren(node, "interpolation"), kind: "interpolated" };
    }
    return { value: stripQuoteDelimiters(node.text), kind: "string" };
  }
  if (node.type === "template_string") {
    return { value: replaceChildren(node, "template_substitution"), kind: "template" };
  }
  return { value: stripQuoteDelimiters(node.text), kind: "string" };
}

/** Ghép text của node, thay mỗi child `holeType` (interpolation/template_substitution) bằng {…}. */
function replaceChildren(node: Parser.SyntaxNode, holeType: string): string {
  let result = "";
  let cursor = node.startIndex;
  const source = node.text;
  for (const child of node.namedChildren) {
    if (child.type !== holeType) continue;
    result += source.slice(cursor - node.startIndex, child.startIndex - node.startIndex);
    result += "{…}";
    cursor = child.endIndex;
  }
  result += source.slice(cursor - node.startIndex);
  return stripQuoteDelimiters(result);
}

function stripQuoteDelimiters(raw: string): string {
  return raw
    .replace(/^\$?@?\$?"""/, "").replace(/"""$/, "") // C# raw string
    .replace(/^\$?@?\$?"/, "").replace(/"$/, "")     // C# regular/verbatim/interpolated
    .replace(/^[`'"]/, "").replace(/[`'"]$/, "")      // JS/TS quotes + backtick
    .trim();
}

function isInsideCSharpAttribute(node: Parser.SyntaxNode): boolean {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === "attribute") return true;
    // Dừng sớm ở ranh giới statement — attribute không chứa statement.
    if (current.type.endsWith("_declaration") || current.type.endsWith("_statement")) return false;
    current = current.parent;
  }
  return false;
}

function isInsideJsImport(node: Parser.SyntaxNode): boolean {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === "import_statement" || current.type === "export_statement") return true;
    if (current.type === "call_expression") {
      const fn = current.childForFieldName("function");
      if (fn && (fn.text === "require" || fn.text === "import")) return true;
      return false;
    }
    if (current.type.endsWith("_statement") || current.type.endsWith("_declaration")) return false;
    current = current.parent;
  }
  return false;
}
