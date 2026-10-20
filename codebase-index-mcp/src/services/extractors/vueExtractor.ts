/**
 * The Vue single-file-component lane's entry point (MCP-ISSUE-074, R2).
 *
 * A `.vue` file is three languages in one file, and each part goes to what already reads it:
 *
 * 1. **Blocks** — `vueSfc.ts` splits the file with `@vue/compiler-sfc`.
 * 2. **Script** — `<script>` and `<script setup>` go through the unchanged JS/TS lane
 *    (`extractJavaScriptSymbolsImpl`) on a copy of the file with everything outside the script blocks
 *    blanked. Same length, same line breaks, so every symbol line and every minted id is the real
 *    `.vue` row with no offset to add (see `maskOutsideRanges`).
 * 3. **Component** — one `component` symbol per file, named after the file, with the
 *    `defineProps` / `defineEmits` / `defineModel` members registered as its `property` children: a prop
 *    under its own name, an event under the listener key Vue compiles it to (`close` → `onClose`,
 *    `update:modelValue` → `onUpdate:modelValue`), because `@close="h"` on the parent IS the `onClose`
 *    prop of the child. `emit('close')` in the child is a CALLS edge to that member.
 * 4. **Template** — `vueTemplate.ts`: `USES_COMPONENT`, prop and listener bindings, handlers and
 *    inline expressions.
 *
 * 5. **Style** — each `<style>` block through the CSS lane (`extractCss`) at its line offset; the
 *    template's `class` / literal `:class` names become `USES_CSS_CLASS` edges.
 */

import type Parser from "tree-sitter";

import type { EdgeRecord, StringLiteralRecord, SymbolRecord } from "../../types/index.js";
import type { ExtractInput } from "./extractorTypes.js";

import { extractJavaScriptSymbolsImpl } from "./jsExtractor.js";
import { extractStringLiteralsImpl } from "./literalExtractor.js";
import { extractCss } from "./cssExtractor.js";
import { findEnclosingSymbolId, makeSymbolId, stripQuotes } from "./extractorUtils.js";
import { maskOutsideRanges, splitVueSfc, type VueSfcSplit } from "./vueSfc.js";
import { extractVueTemplateEdges, type VueImportBinding } from "./vueTemplate.js";

/** Parse TypeScript (or its TSX dialect) with the pipeline's guards. Throws on a parse timeout. */
export type VueTsParse = (source: string, tsx: boolean) => Parser.Tree;

export type VueExtractResult = {
  literals: StringLiteralRecord[];
  /** The block split, including `styles` — the hook the CSS lane plugs into. */
  sfc: VueSfcSplit;
};

/** `AppCard.vue` → `AppCard`; `app-card.vue` stays `app-card`, which is also the name Vue infers. */
export function vueComponentName(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  return base.replace(/\.vue$/i, "") || base;
}

export function vueComponentSymbolId(input: ExtractInput): string {
  return makeSymbolId(input, "component", vueComponentName(input.filePath), 0);
}

/** Vue's `toHandlerKey(camelize(event))`: `close` → `onClose`, `item-click` → `onItemClick`. */
export function vueListenerKey(event: string): string {
  const camel = camelize(event);
  return `on${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
}

export function camelize(name: string): string {
  return name.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
}

type ComponentInterface = {
  /** Prop name → symbol id. */
  props: Map<string, string>;
  /** Event name → symbol id of its `on<Event>` member. */
  events: Map<string, string>;
  /** Local names bound to `defineEmits(...)` — `const emit = defineEmits(...)`. */
  emitBindings: Set<string>;
  /** Local names bound to `defineProps(...)` / `withDefaults(defineProps(...))`. */
  propsBindings: Set<string>;
  models: string[];
};

export function extractVueFileImpl(
  input: ExtractInput,
  symbols: SymbolRecord[],
  edges: EdgeRecord[],
  moduleSymbolId: string,
  parse: VueTsParse,
  literalPolicy: { minLength: number; maxPerFile: number }
): VueExtractResult {
  const sfc = splitVueSfc(input.source, input.filePath);
  const componentName = vueComponentName(input.filePath);
  const componentId = vueComponentSymbolId(input);
  const lineCount = input.source.split("\n").length;

  const iface: ComponentInterface = {
    props: new Map(),
    events: new Map(),
    emitBindings: new Set(),
    propsBindings: new Set(),
    models: []
  };
  const imports = new Map<string, VueImportBinding>();
  let literals: StringLiteralRecord[] = [];
  let scriptTree: Parser.Tree | null = null;

  try {
    if (sfc.scripts.length > 0) {
      const masked = maskOutsideRanges(
        input.source,
        sfc.scripts.map((s) => ({ start: s.startOffset, end: s.endOffset }))
      );
      const tsx = sfc.scripts.some((s) => s.lang === "tsx" || s.lang === "jsx");
      scriptTree = parse(masked, tsx);
      const root = scriptTree.rootNode;
      // `source` is the masked text so any pass that reads it sees file coordinates too; `language`
      // stays `vue` so string literals are tagged with the file's real language.
      const scriptInput: ExtractInput = { ...input, source: masked };

      extractJavaScriptSymbolsImpl(scriptInput, root, symbols, edges, moduleSymbolId);
      literals = extractStringLiteralsImpl(scriptInput, root, literalPolicy);

      collectImportBindings(root, imports);
      collectComponentInterface(input, root, componentId, symbols, iface);
      emitScriptInterfaceEdges(input, root, moduleSymbolId, iface, edges);
      dropCompilerMacroCalls(edges, iface);
    }

    symbols.push({
      repoId: input.repoId,
      symbolId: componentId,
      filePath: input.filePath,
      name: componentName,
      kind: "component",
      line: 1,
      endLine: lineCount,
      signature: componentSignature(componentName, sfc, iface)
    });

    if (sfc.template?.ast) {
      const scriptCallables = new Map<string, string>();
      for (const symbol of symbols) {
        if ((symbol.kind === "function" || symbol.kind === "method") && !scriptCallables.has(symbol.name)) {
          scriptCallables.set(symbol.name, symbol.symbolId);
        }
      }
      extractVueTemplateEdges({
        input,
        ast: sfc.template.ast,
        componentId,
        imports,
        scriptCallables,
        props: iface.props,
        events: iface.events,
        parse,
        edges
      });
    }

    // `<style>` blocks go through the CSS lane at their own line offset (MCP-ISSUE-075). A block postcss
    // cannot read (SCSS/Less-only syntax) is skipped on its own; the script and template above stand.
    for (const style of sfc.styles) {
      try {
        const css = extractCss(style.content, input, style.startLine - 1, { scoped: style.scoped, moduleSymbolId });
        symbols.push(...css.symbols);
        edges.push(...css.edges);
      } catch {
        // CssSyntaxError on a non-CSS dialect: no CSS symbols for this block.
      }
    }
  } finally {
    // Same reason as `keepTreeAlive` in treeSitterExtractor (MCP-ISSUE-032): nodes do not keep their
    // tree alive, so the tree stays observably reachable until every pass above has finished.
    if (scriptTree && scriptTree.rootNode.endIndex < 0) {
      throw new Error("unreachable: negative endIndex");
    }
  }

  return { literals, sfc };
}

/** `<script setup>` compiler macros: compiled away, never called at runtime, never resolvable. */
const COMPILER_MACROS = ["defineProps", "defineEmits", "defineModel", "defineExpose", "defineSlots", "defineOptions", "withDefaults"];

/**
 * Remove the TS lane's `callee:defineProps`-style tokens, and `callee:emit` for the `defineEmits`
 * binding. The macros are read above as the component's interface, and an `emit('x')` call is already
 * the precise CALLS edge to the `onX` member; left in, each would be an unresolvable token in every
 * component, inflating the unresolved count with things that are not calls.
 */
function dropCompilerMacroCalls(edges: EdgeRecord[], iface: ComponentInterface): void {
  const noise = new Set([...COMPILER_MACROS, ...iface.emitBindings].map((name) => `callee:${name}`));
  for (let i = edges.length - 1; i >= 0; i -= 1) {
    const edge = edges[i];
    if (edge && edge.type === "CALLS" && noise.has(edge.toId)) edges.splice(i, 1);
  }
}

function componentSignature(name: string, sfc: VueSfcSplit, iface: ComponentInterface): string {
  const script = sfc.scripts.find((s) => s.setup) ?? sfc.scripts[0];
  const parts = [`<${name}>`];
  if (script) parts.push(`(${script.setup ? "script setup" : "script"}${script.lang !== "js" ? ` lang=${script.lang}` : ""})`);
  const props = [...iface.props.keys()];
  const events = [...iface.events.keys()];
  if (props.length > 0) parts.push(`props: ${props.join(", ")}`);
  if (events.length > 0) parts.push(`emits: ${events.join(", ")}`);
  const signature = parts.join(" ");
  return signature.length <= 300 ? signature : `${signature.slice(0, 297)}...`;
}

// ── Imports: the names a template tag can resolve to ────────────────────────────────────────

/**
 * Every binding an `import` introduces, with the specifier it came from. A template tag resolves only
 * through these (wec.aria imports every component explicitly); a tag with no binding is a global or
 * auto-registered component and is recorded as a gap by the template pass.
 */
function collectImportBindings(root: Parser.SyntaxNode, imports: Map<string, VueImportBinding>): void {
  for (const node of root.descendantsOfType("import_statement")) {
    const sourceNode = node.childForFieldName("source");
    if (!sourceNode) continue;
    const specifier = stripQuotes(sourceNode.text);
    if (!specifier) continue;
    // `import type { X }` binds nothing a template can render.
    if (/^import\s+type\b/.test(node.text)) continue;

    const clause = node.namedChildren.find((c) => c.type === "import_clause");
    if (!clause) continue;
    for (const part of clause.namedChildren) {
      if (part.type === "identifier") {
        imports.set(part.text, { specifier, imported: "default" });
      } else if (part.type === "named_imports") {
        for (const spec of part.namedChildren.filter((c) => c.type === "import_specifier")) {
          const nameNode = spec.childForFieldName("name");
          const aliasNode = spec.childForFieldName("alias");
          if (!nameNode) continue;
          imports.set((aliasNode ?? nameNode).text, { specifier, imported: nameNode.text });
        }
      } else if (part.type === "namespace_import") {
        const id = part.namedChildren.find((c) => c.type === "identifier");
        if (id) imports.set(id.text, { specifier, imported: "*" });
      }
    }
  }
}

// ── defineProps / defineEmits / defineModel ──────────────────────────────────────────────────

function calleeName(call: Parser.SyntaxNode): string {
  return call.childForFieldName("function")?.text.trim() ?? "";
}

/** The local name a macro call is bound to: `const emit = defineEmits(...)` → `emit`. */
function boundName(call: Parser.SyntaxNode): string | null {
  let node: Parser.SyntaxNode | null = call.parent;
  // `withDefaults(defineProps<...>(), {...})` binds the outer call.
  if (node?.type === "arguments" && node.parent?.type === "call_expression" && calleeName(node.parent) === "withDefaults") {
    node = node.parent.parent;
  }
  if (node?.type !== "variable_declarator") return null;
  const name = node.childForFieldName("name");
  return name?.type === "identifier" ? name.text : null;
}

function collectComponentInterface(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  componentId: string,
  symbols: SymbolRecord[],
  iface: ComponentInterface
): void {
  const existingIds = new Set(symbols.map((s) => s.symbolId));

  const register = (map: Map<string, string>, key: string, memberName: string, node: Parser.SyntaxNode, signature: string): void => {
    if (!key || map.has(key)) return;
    const symbolId = makeSymbolId(input, "property", memberName, node.startPosition.row);
    map.set(key, symbolId);
    // A member of a named `interface Props { … }` is already registered by the TS lane under the same
    // id (same kind, name and row), owned by that interface. It is the same declaration, so it is
    // reused rather than registered twice; the resolver finds child members by file and name.
    if (existingIds.has(symbolId)) return;
    existingIds.add(symbolId);
    symbols.push({
      repoId: input.repoId,
      symbolId,
      filePath: input.filePath,
      name: memberName,
      kind: "property",
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature: signature.length <= 300 ? signature : `${signature.slice(0, 297)}...`,
      parentSymbolId: componentId
    });
  };
  const registerProp = (name: string, node: Parser.SyntaxNode): void =>
    register(iface.props, name, name, node, `prop ${oneLine(node.text)}`);
  const registerEvent = (event: string, node: Parser.SyntaxNode): void =>
    register(iface.events, event, vueListenerKey(event), node, `emits '${event}' ${oneLine(node.text)}`);

  for (const call of root.descendantsOfType("call_expression")) {
    const name = calleeName(call);
    if (name === "defineProps") {
      const bound = boundName(call);
      if (bound) iface.propsBindings.add(bound);
      for (const member of typeArgumentMembers(root, call)) {
        if (member.type === "property_signature" || member.type === "method_signature") {
          const key = memberKey(member);
          if (key) registerProp(key, member);
        }
      }
      for (const [key, node] of runtimeDeclarationKeys(call)) registerProp(key, node);
    } else if (name === "defineEmits") {
      const bound = boundName(call);
      if (bound) iface.emitBindings.add(bound);
      for (const member of typeArgumentMembers(root, call)) {
        if (member.type === "call_signature") {
          // `(e: 'close', id: string): void` — the event is the first parameter's literal type.
          const firstParam = member.childForFieldName("parameters")?.namedChildren[0];
          const typeText = firstParam?.childForFieldName("type")?.text.replace(/^:\s*/, "") ?? "";
          for (const literal of typeText.split("|")) {
            const event = stripQuotes(literal.trim());
            if (event && /^['"]/.test(literal.trim())) registerEvent(event, member);
          }
        } else if (member.type === "property_signature") {
          // 3.3+ shorthand: `close: []`, `save: [id: string]`.
          const key = memberKey(member);
          if (key) registerEvent(key, member);
        }
      }
      for (const [key, node] of runtimeDeclarationKeys(call)) registerEvent(key, node);
    } else if (name === "defineModel") {
      const first = call.childForFieldName("arguments")?.namedChildren[0];
      const model = first?.type === "string" ? stripQuotes(first.text) : "modelValue";
      if (!model) continue;
      iface.models.push(model);
      registerProp(model, call);
      registerEvent(`update:${model}`, call);
    }
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function memberKey(member: Parser.SyntaxNode): string | null {
  const nameNode = member.childForFieldName("name");
  if (!nameNode) return null;
  return stripQuotes(nameNode.text) || null;
}

/**
 * The members of `defineProps<T>()` / `defineEmits<T>()`'s type argument: an inline object type, or a
 * same-file `interface T` / `type T = {…}` (intersections are read part by part). A type imported from
 * another file is not followed — its members are not this component's declarations to register.
 */
function typeArgumentMembers(root: Parser.SyntaxNode, call: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const typeArgs = call.childForFieldName("type_arguments") ?? call.namedChildren.find((c) => c.type === "type_arguments");
  const typeNode = typeArgs?.namedChildren[0];
  return typeNode ? membersOfType(root, typeNode, 0) : [];
}

const MEMBER_NODE_TYPES = new Set(["property_signature", "method_signature", "call_signature"]);

function membersOfType(root: Parser.SyntaxNode, typeNode: Parser.SyntaxNode, depth: number): Parser.SyntaxNode[] {
  if (depth > 3) return [];
  switch (typeNode.type) {
    case "object_type":
    case "interface_body":
      return typeNode.namedChildren.filter((c) => MEMBER_NODE_TYPES.has(c.type));
    case "intersection_type":
    case "parenthesized_type":
      return typeNode.namedChildren.flatMap((c) => membersOfType(root, c, depth + 1));
    case "type_identifier": {
      const name = typeNode.text;
      for (const decl of root.descendantsOfType(["interface_declaration", "type_alias_declaration"])) {
        if (decl.childForFieldName("name")?.text !== name) continue;
        const body = decl.type === "interface_declaration"
          ? decl.childForFieldName("body") ?? decl.namedChildren.find((c) => c.type === "interface_body" || c.type === "object_type")
          : decl.childForFieldName("value");
        return body ? membersOfType(root, body, depth + 1) : [];
      }
      return [];
    }
    default:
      return [];
  }
}

/** Keys of a runtime declaration: `defineProps({ a: String })`, `defineEmits(['close'])`. */
function runtimeDeclarationKeys(call: Parser.SyntaxNode): [string, Parser.SyntaxNode][] {
  const first = call.childForFieldName("arguments")?.namedChildren[0];
  if (!first) return [];
  const out: [string, Parser.SyntaxNode][] = [];
  if (first.type === "object") {
    for (const entry of first.namedChildren) {
      if (entry.type === "pair" || entry.type === "method_definition") {
        const key = entry.childForFieldName(entry.type === "pair" ? "key" : "name");
        if (key && (key.type === "property_identifier" || key.type === "string")) out.push([stripQuotes(key.text), entry]);
      } else if (entry.type === "shorthand_property_identifier") {
        out.push([entry.text, entry]);
      }
    }
  } else if (first.type === "array") {
    for (const element of first.namedChildren) {
      if (element.type === "string") out.push([stripQuotes(element.text), element]);
    }
  }
  return out.filter(([key]) => key.length > 0);
}

/**
 * Script-side uses of the component's own interface:
 * - `emit('close')` (the `defineEmits` binding) → CALLS the `onClose` member: emitting invokes the
 *   parent's listener, which is what that member stands for.
 * - `props.title` (the `defineProps` binding) → PROPERTY_REF the `title` member. The TS lane emits
 *   property edges for `this.<member>` only, and a `<script setup>` component has no `this`.
 */
function emitScriptInterfaceEdges(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  moduleSymbolId: string,
  iface: ComponentInterface,
  edges: EdgeRecord[]
): void {
  if (iface.emitBindings.size > 0 && iface.events.size > 0) {
    for (const call of root.descendantsOfType("call_expression")) {
      if (!iface.emitBindings.has(calleeName(call))) continue;
      const first = call.childForFieldName("arguments")?.namedChildren[0];
      if (first?.type !== "string") continue;
      const target = iface.events.get(stripQuotes(first.text));
      if (!target) continue;
      edges.push({
        repoId: input.repoId,
        fromId: findEnclosingSymbolId(call, input) ?? moduleSymbolId,
        toId: target,
        type: "CALLS",
        confidence: 0.95,
        reason: `vue emit '${stripQuotes(first.text)}' (line ${String(call.startPosition.row + 1)})`
      });
    }
  }

  if (iface.propsBindings.size > 0 && iface.props.size > 0) {
    for (const member of root.descendantsOfType("member_expression")) {
      const object = member.childForFieldName("object");
      const property = member.childForFieldName("property");
      if (object?.type !== "identifier" || !property || !iface.propsBindings.has(object.text)) continue;
      const target = iface.props.get(property.text);
      if (!target) continue;
      edges.push({
        repoId: input.repoId,
        fromId: findEnclosingSymbolId(member, input) ?? moduleSymbolId,
        toId: target,
        type: "PROPERTY_REF",
        confidence: 0.95,
        reason: `vue props.${property.text} (line ${String(member.startPosition.row + 1)})`
      });
    }
  }
}
