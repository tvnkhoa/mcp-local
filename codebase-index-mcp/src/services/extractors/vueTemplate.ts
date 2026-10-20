/**
 * Vue template → edges (MCP-ISSUE-074, stages 2 and 3).
 *
 * Reads the template AST `@vue/compiler-sfc` already built during the block split (it is the
 * `@vue/compiler-dom` parser's output, with absolute `.vue` locations). Every edge leaves the file's
 * `component` symbol, because a template has no smaller owner; the template line is carried in
 * `reason` (`… (line N)`) since an edge row has no line column of its own.
 *
 * What a template says, and the edge it becomes:
 *
 * | Template | Edge |
 * |---|---|
 * | `<AppCard>` / `<app-card>`, imported in the script | `USES_COMPONENT` → `component:<specifier>` (resolved to the child's `component` symbol after the run) |
 * | `<component :is="c ? A : B">` | one `USES_COMPONENT` per imported branch; an intrinsic tag string (`'div'`) is ignored; any other branch is a labelled gap |
 * | a component tag with no import (global / auto-registered) | labelled gap |
 * | `:title="x"` / `title="x"` / `v-model:title` on a child | `PROPERTY_WRITE` → the child's `title` member, `assignedExpression` = the bound text |
 * | `@close="h"` on a child | `PROPERTY_WRITE` → the child's `onClose` member (Vue compiles the listener to that prop) |
 * | `@close="onClose"` | `CALLS` → the script's `onClose` |
 * | `@click="save(x)"`, `{{ fmt(x) }}` — any expression | parsed with the TS grammar: calls → `CALLS`, `a.b` → `PROPERTY_REF property:b`, a bare own prop → `PROPERTY_REF` |
 * | `$emit('close')` | `CALLS` → this component's `onClose` member |
 *
 * PROPERTY_WRITE for a binding, not PROPERTY_REF: the parent supplies the child's prop value, which is
 * the "who sets this field, and to what" question `find_field_accesses` answers for a write — and the
 * bound expression rides along as `assignedExpression` exactly as a C# assignment's right-hand side does.
 *
 * Names declared by the template itself (`v-for` aliases, `v-slot` props, arrow parameters) are
 * scoped and never resolved against the script.
 */

import type Parser from "tree-sitter";

import type { EdgeRecord } from "../../types/index.js";
import type { ExtractInput } from "./extractorTypes.js";

import { BUILTIN_SKIP_NAMES, emitPropertyAccessEdge, shouldSkipJavaScriptMemberCall, stripQuotes } from "./extractorUtils.js";

export type VueImportBinding = {
  specifier: string;
  /** `default`, `*` (namespace import) or the imported name. */
  imported: string;
};

export type VueTemplateContext = {
  input: ExtractInput;
  /** `descriptor.template.ast` — a compiler-core `RootNode`. */
  ast: unknown;
  componentId: string;
  imports: Map<string, VueImportBinding>;
  /** Script function/method name → symbol id. */
  scriptCallables: Map<string, string>;
  props: Map<string, string>;
  events: Map<string, string>;
  parse: (source: string, tsx: boolean) => Parser.Tree;
  edges: EdgeRecord[];
};

/** The subset of compiler-core's node shapes this pass reads. */
type Loc = { start: { line: number; offset: number } };
type TemplateNode = {
  type: number;
  loc: Loc;
  tag?: string;
  tagType?: number;
  props?: TemplateProp[];
  children?: TemplateNode[];
  content?: SimpleExpression | string;
};
type SimpleExpression = { type: number; content: string; isStatic?: boolean; loc: Loc };
type TemplateProp = {
  type: number;
  name: string;
  loc: Loc;
  value?: { content: string; loc: Loc };
  arg?: SimpleExpression;
  exp?: SimpleExpression;
};

// compiler-core `NodeTypes` / `ElementTypes` (stable since Vue 3.0; a const enum, so not importable at runtime).
const NODE_ELEMENT = 1;
const NODE_INTERPOLATION = 5;
const NODE_ATTRIBUTE = 6;
const NODE_DIRECTIVE = 7;
const TAG_COMPONENT = 1;

/** Vue's built-in components and the dynamic `<component>`: rendered by the runtime, never imported. */
const BUILTIN_TAGS = new Set([
  "component", "transition", "transition-group", "keep-alive", "teleport", "suspense", "slot", "template",
  "Transition", "TransitionGroup", "KeepAlive", "Teleport", "Suspense", "Component"
]);

/** Attributes a parent sets on any child that are not the child's props. */
const NON_PROP_ATTRIBUTES = new Set(["key", "ref", "ref_for", "ref_key", "class", "style", "is", "slot"]);

/** A handler that is a reference rather than a statement: `onClose`, `store.reset`, `a?.b`. */
const SIMPLE_PATH = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*$/;

const GAP_CONFIDENCE = 0.2;
const MAX_ASSIGNED_EXPRESSION = 200;

function pascalCase(tag: string): string {
  return tag.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase());
}

function camelize(name: string): string {
  return name.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
}

function listenerKey(event: string): string {
  const camel = camelize(event);
  return `on${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
}

/** `'div'`, `'span'`: a lowercase single word is a native element, not something to resolve. */
function isIntrinsicTagName(name: string): boolean {
  return /^[a-z][a-z0-9]*$/.test(name);
}

export function extractVueTemplateEdges(ctx: VueTemplateContext): void {
  const root = ctx.ast as TemplateNode;
  for (const child of root.children ?? []) walkNode(ctx, child, new Set());
}

function walkNode(ctx: VueTemplateContext, node: TemplateNode, outerLocals: ReadonlySet<string>): void {
  if (node.type === NODE_INTERPOLATION && typeof node.content === "object" && node.content) {
    walkExpression(ctx, node.content.content, node.content.loc.start.line, "value", outerLocals);
    return;
  }
  if (node.type !== NODE_ELEMENT) return;

  const props = node.props ?? [];
  // `v-for` and `v-slot` names are in scope for the element's own other directives and its children.
  let locals: Set<string> | null = null;
  for (const prop of props) {
    if (prop.type !== NODE_DIRECTIVE || !prop.exp) continue;
    if (prop.name === "for") {
      const lhs = prop.exp.content.split(/\s+(?:in|of)\s+/)[0] ?? "";
      locals ??= new Set(outerLocals);
      for (const name of patternNames(ctx, lhs.trim().replace(/^\(|\)$/g, ""))) locals.add(name);
    } else if (prop.name === "slot") {
      locals ??= new Set(outerLocals);
      for (const name of patternNames(ctx, prop.exp.content)) locals.add(name);
    }
  }
  const scope: ReadonlySet<string> = locals ?? outerLocals;

  const tag = node.tag ?? "";
  const isDynamic = tag === "component" || tag === "Component";
  let childToken: string | null = null;

  if (isDynamic) {
    resolveDynamicIs(ctx, props, scope);
  } else {
    const binding = tagBinding(ctx, tag);
    if (binding) {
      childToken = `component:${binding.specifier}`;
      pushEdge(ctx, childToken, "USES_COMPONENT", 0.5, "unresolved component token");
    } else if (node.tagType === TAG_COMPONENT && !BUILTIN_TAGS.has(tag)) {
      pushEdge(ctx, `component:${tag}`, "USES_COMPONENT", GAP_CONFIDENCE, "vue tag not imported (global or auto-registered component)");
    }
  }

  for (const prop of props) {
    if (prop.type === NODE_ATTRIBUTE) {
      if (childToken && isChildProp(prop.name)) {
        const value = prop.value?.content;
        pushEdge(ctx, `${childToken}#${camelize(prop.name)}`, "PROPERTY_WRITE", 0.5, "unresolved component token", value === undefined ? "true" : JSON.stringify(value));
      }
      continue;
    }
    if (prop.type !== NODE_DIRECTIVE) continue;

    const arg = prop.arg && prop.arg.isStatic !== false ? prop.arg.content : null;
    const exp = prop.exp;
    switch (prop.name) {
      case "bind":
        if (isDynamic && arg === "is") break; // read by resolveDynamicIs
        if (childToken && arg && isChildProp(arg)) {
          pushEdge(ctx, `${childToken}#${camelize(arg)}`, "PROPERTY_WRITE", 0.5, "unresolved component token", clip(exp?.content ?? "true"));
        }
        if (exp) walkExpression(ctx, exp.content, exp.loc.start.line, "value", scope);
        break;
      case "on":
        if (childToken && arg) {
          pushEdge(ctx, `${childToken}#${listenerKey(arg)}`, "PROPERTY_WRITE", 0.5, "unresolved component token", clip(exp?.content ?? ""));
        }
        if (exp) walkExpression(ctx, exp.content, exp.loc.start.line, "handler", scope, arg ? `@${arg}` : "v-on");
        break;
      case "model": {
        if (childToken) {
          const model = arg ?? "modelValue";
          pushEdge(ctx, `${childToken}#${model}`, "PROPERTY_WRITE", 0.5, "unresolved component token", clip(exp?.content ?? ""));
          pushEdge(ctx, `${childToken}#${listenerKey(`update:${model}`)}`, "PROPERTY_WRITE", 0.5, "unresolved component token", clip(exp?.content ?? ""));
        }
        if (exp) walkExpression(ctx, exp.content, exp.loc.start.line, "value", scope);
        break;
      }
      case "for":
        if (exp) {
          const rhs = exp.content.split(/\s+(?:in|of)\s+/).slice(1).join(" in ");
          if (rhs) walkExpression(ctx, rhs, exp.loc.start.line, "value", scope);
        }
        break;
      case "slot":
        break; // declares names; nothing to read
      default:
        // v-if / v-else-if / v-show / v-text / v-html / v-memo and custom directives.
        if (exp) walkExpression(ctx, exp.content, exp.loc.start.line, "value", scope);
    }
  }

  for (const child of node.children ?? []) walkNode(ctx, child, scope);
}

function isChildProp(name: string): boolean {
  return !NON_PROP_ATTRIBUTES.has(name) && !name.startsWith("data-") && !name.startsWith("aria-");
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_ASSIGNED_EXPRESSION ? flat : `${flat.slice(0, MAX_ASSIGNED_EXPRESSION - 3)}...`;
}

function tagBinding(ctx: VueTemplateContext, tag: string): VueImportBinding | null {
  if (!tag) return null;
  // `<Form.Item>` renders a member of the `Form` binding.
  const head = tag.split(".")[0] ?? tag;
  return ctx.imports.get(head) ?? ctx.imports.get(pascalCase(head)) ?? null;
}

function pushEdge(
  ctx: VueTemplateContext,
  toId: string,
  type: EdgeRecord["type"],
  confidence: number,
  reason: string,
  assignedExpression?: string
): void {
  ctx.edges.push({
    repoId: ctx.input.repoId,
    fromId: ctx.componentId,
    toId,
    type,
    confidence,
    reason,
    ...(assignedExpression !== undefined ? { assignedExpression } : {})
  });
}

// ── <component :is> ─────────────────────────────────────────────────────────────────────────

function resolveDynamicIs(ctx: VueTemplateContext, props: TemplateProp[], scope: ReadonlySet<string>): void {
  for (const prop of props) {
    if (prop.type === NODE_ATTRIBUTE && prop.name === "is") {
      const literal = prop.value?.content ?? "";
      if (literal && !isIntrinsicTagName(literal)) {
        pushEdge(ctx, `component:${clip(literal)}`, "USES_COMPONENT", GAP_CONFIDENCE, "vue :is names a component by string (registration not resolvable)");
      }
      continue;
    }
    if (prop.type !== NODE_DIRECTIVE || prop.name !== "bind" || prop.arg?.content !== "is" || !prop.exp) continue;

    const exp = prop.exp;
    const tree = ctx.parse(`(${exp.content})`, false);
    try {
      const statement = tree.rootNode.namedChildren[0];
      const expression = statement?.type === "expression_statement" ? statement.namedChildren[0] : statement;
      for (const branch of isBranches(expression ?? null)) classifyIsBranch(ctx, branch, exp.loc.start.line, scope);
    } finally {
      // Keep the tree reachable while its nodes are read (MCP-ISSUE-032).
      if (tree.rootNode.endIndex < 0) throw new Error("unreachable: negative endIndex");
    }
    // Calls inside the expression (`:is="pick(kind)"`) are still calls.
    walkExpression(ctx, exp.content, exp.loc.start.line, "value", scope, undefined, true);
  }
}

/** The values an `:is` expression can take, branch by branch. */
function isBranches(node: Parser.SyntaxNode | null): Parser.SyntaxNode[] {
  if (!node) return [];
  switch (node.type) {
    case "parenthesized_expression":
      return isBranches(node.namedChildren[0] ?? null);
    case "ternary_expression":
      return [...isBranches(node.childForFieldName("consequence")), ...isBranches(node.childForFieldName("alternative"))];
    case "binary_expression": {
      const operator = node.childForFieldName("operator")?.text;
      if (operator === "||" || operator === "??") {
        return [...isBranches(node.childForFieldName("left")), ...isBranches(node.childForFieldName("right"))];
      }
      return [node];
    }
    default:
      return [node];
  }
}

function classifyIsBranch(ctx: VueTemplateContext, branch: Parser.SyntaxNode, baseLine: number, scope: ReadonlySet<string>): void {
  if (branch.type === "identifier" && !scope.has(branch.text)) {
    const binding = ctx.imports.get(branch.text);
    if (binding) {
      pushEdge(ctx, `component:${binding.specifier}`, "USES_COMPONENT", 0.5, "unresolved component token");
      return;
    }
  }
  if (branch.type === "string" || (branch.type === "template_string" && !branch.namedChildren.some((c) => c.type === "template_substitution"))) {
    const literal = stripQuotes(branch.text.replace(/^`|`$/g, ""));
    if (isIntrinsicTagName(literal)) return; // `'div'` — a native element, nothing to link
  }
  pushEdge(
    ctx,
    `component:${clip(branch.text)}`,
    "USES_COMPONENT",
    GAP_CONFIDENCE,
    `vue dynamic :is branch not resolvable to an import (line ${String(baseLine + branch.startPosition.row)})`
  );
}

// ── Expressions ─────────────────────────────────────────────────────────────────────────────

/** Identifiers a `v-for` alias or `v-slot` pattern declares: `(item, i)`, `{ row, index }`. */
function patternNames(ctx: VueTemplateContext, pattern: string): string[] {
  if (!pattern.trim()) return [];
  const tree = ctx.parse(`(${pattern}) => 0`, false);
  try {
    const params = tree.rootNode.descendantsOfType("formal_parameters")[0];
    if (!params) return [];
    const names: string[] = [];
    for (const id of params.descendantsOfType(["identifier", "shorthand_property_identifier_pattern"])) {
      // `{ a: b }` declares `b`, not `a`; the key side is a property_identifier, never collected here.
      names.push(id.text);
    }
    return names;
  } finally {
    if (tree.rootNode.endIndex < 0) throw new Error("unreachable: negative endIndex");
  }
}

type ExpressionMode = "value" | "handler";

function walkExpression(
  ctx: VueTemplateContext,
  text: string,
  baseLine: number,
  mode: ExpressionMode,
  scope: ReadonlySet<string>,
  eventLabel?: string,
  callsOnly = false
): void {
  const trimmed = text.trim();
  if (!trimmed) return;

  // `@close="onClose"` — the handler is referenced, and the runtime calls it with the event payload.
  const handlerReference = mode === "handler" && SIMPLE_PATH.test(trimmed);
  if (handlerReference && trimmed.includes(".")) {
    // `@click="store.reset"` — a method reference on another object: a call to `reset`, bound by the
    // call resolver like any `obj.reset()`.
    const segments = trimmed.split(/\??\./);
    const callee = segments[segments.length - 1] ?? "";
    if (callee && !segments[0]?.startsWith("$") && !scope.has(callee) && !BUILTIN_SKIP_NAMES.has(callee)) {
      ctx.edges.push({ repoId: ctx.input.repoId, fromId: ctx.componentId, toId: `callee:${callee}`, type: "CALLS" });
    }
    return;
  }
  // A handler statement (`count++; save()`) is parsed as statements; everything else as one expression.
  const source = mode === "handler" && !handlerReference ? trimmed : `(${trimmed})`;
  const lineOffset = text.slice(0, text.indexOf(trimmed)).split("\n").length - 1;
  const tree = ctx.parse(source, false);
  try {
    visit(ctx, tree.rootNode, baseLine + lineOffset, scope, {
      handlerLabel: handlerReference ? (eventLabel ?? "v-on") : undefined,
      callsOnly
    });
  } finally {
    if (tree.rootNode.endIndex < 0) throw new Error("unreachable: negative endIndex");
  }
}

type VisitOptions = { handlerLabel: string | undefined; callsOnly: boolean };

function visit(ctx: VueTemplateContext, node: Parser.SyntaxNode, baseLine: number, scope: ReadonlySet<string>, options: VisitOptions): void {
  const line = baseLine + node.startPosition.row;

  switch (node.type) {
    case "call_expression": {
      const fn = node.childForFieldName("function");
      if (fn?.type === "identifier") {
        emitCall(ctx, node, fn.text, line, scope);
      } else if (fn?.type === "member_expression") {
        const property = fn.childForFieldName("property");
        const object = fn.childForFieldName("object");
        const callee = property?.type === "property_identifier" ? property.text : "";
        const rootName = rootIdentifier(object);
        if (callee && !rootName?.startsWith("$") && !shouldSkipJavaScriptMemberCall(fn, callee)) {
          ctx.edges.push({ repoId: ctx.input.repoId, fromId: ctx.componentId, toId: `callee:${callee}`, type: "CALLS" });
        }
        if (object) visit(ctx, object, baseLine, scope, options);
      } else if (fn) {
        visit(ctx, fn, baseLine, scope, options);
      }
      const args = node.childForFieldName("arguments");
      if (args) visit(ctx, args, baseLine, scope, options);
      return;
    }

    case "member_expression": {
      const object = node.childForFieldName("object");
      const property = node.childForFieldName("property");
      const rootName = rootIdentifier(object);
      if (!options.callsOnly && property?.type === "property_identifier" && !rootName?.startsWith("$")) {
        emitPropertyAccessEdge(ctx.input, ctx.componentId, property.text, false, ctx.edges);
      } else if (!options.callsOnly && property && rootName === "$props" && object?.type === "identifier") {
        emitOwnPropRead(ctx, property.text, line);
      }
      if (object) visit(ctx, object, baseLine, scope, options);
      return;
    }

    case "arrow_function":
    case "function_expression":
    case "function": {
      // Parameters are template-local: `@click="(e) => save(e)"`.
      const inner = new Set(scope);
      const params = node.childForFieldName("parameters") ?? node.childForFieldName("parameter");
      for (const id of params?.descendantsOfType(["identifier", "shorthand_property_identifier_pattern"]) ?? []) inner.add(id.text);
      if (params?.type === "identifier") inner.add(params.text);
      const body = node.childForFieldName("body");
      if (body) visit(ctx, body, baseLine, inner, { ...options, handlerLabel: undefined });
      return;
    }

    case "identifier":
    case "shorthand_property_identifier":
      if (!options.callsOnly) emitIdentifierRead(ctx, node.text, line, scope, options.handlerLabel);
      return;

    default:
      for (const child of node.namedChildren) visit(ctx, child, baseLine, scope, options);
  }
}

function rootIdentifier(node: Parser.SyntaxNode | null): string | null {
  let current = node;
  while (current && (current.type === "member_expression" || current.type === "subscript_expression" || current.type === "call_expression")) {
    current = current.childForFieldName(current.type === "call_expression" ? "function" : "object");
  }
  return current?.type === "identifier" ? current.text : null;
}

function emitCall(ctx: VueTemplateContext, call: Parser.SyntaxNode, name: string, line: number, scope: ReadonlySet<string>): void {
  if (scope.has(name)) return;
  if (name === "$emit") {
    const first = call.childForFieldName("arguments")?.namedChildren[0];
    const event = first?.type === "string" ? stripQuotes(first.text) : "";
    const target = event ? ctx.events.get(event) : undefined;
    if (target) {
      ctx.edges.push({
        repoId: ctx.input.repoId,
        fromId: ctx.componentId,
        toId: target,
        type: "CALLS",
        confidence: 0.95,
        reason: `vue template $emit '${event}' (line ${String(line)})`
      });
    }
    return;
  }
  if (name.startsWith("$") || BUILTIN_SKIP_NAMES.has(name)) return;

  const target = ctx.scriptCallables.get(name);
  if (target) {
    ctx.edges.push({
      repoId: ctx.input.repoId,
      fromId: ctx.componentId,
      toId: target,
      type: "CALLS",
      confidence: 0.9,
      reason: `vue template call (line ${String(line)})`
    });
    return;
  }
  // Not declared in this file — an imported helper or a global; the call resolver binds it.
  ctx.edges.push({ repoId: ctx.input.repoId, fromId: ctx.componentId, toId: `callee:${name}`, type: "CALLS" });
}

function emitIdentifierRead(
  ctx: VueTemplateContext,
  name: string,
  line: number,
  scope: ReadonlySet<string>,
  handlerLabel: string | undefined
): void {
  if (scope.has(name) || name.startsWith("$")) return;

  const callable = ctx.scriptCallables.get(name);
  if (callable) {
    ctx.edges.push({
      repoId: ctx.input.repoId,
      fromId: ctx.componentId,
      toId: callable,
      type: "CALLS",
      confidence: 0.9,
      // A handler reference is invoked by the event; any other function reference (`:formatter="fmt"`)
      // is handed to a child that invokes it. Either way the template is its caller.
      reason: handlerLabel ? `vue template ${handlerLabel} handler (line ${String(line)})` : `vue template function reference (line ${String(line)})`
    });
    return;
  }
  emitOwnPropRead(ctx, name, line);
}

function emitOwnPropRead(ctx: VueTemplateContext, name: string, line: number): void {
  const prop = ctx.props.get(name);
  if (!prop) return;
  ctx.edges.push({
    repoId: ctx.input.repoId,
    fromId: ctx.componentId,
    toId: prop,
    type: "PROPERTY_REF",
    confidence: 0.95,
    reason: `vue template prop read (line ${String(line)})`
  });
}
