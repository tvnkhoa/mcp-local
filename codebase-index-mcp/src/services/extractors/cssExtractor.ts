/**
 * The CSS lane (MCP-ISSUE-075): `.css` files and, through the Vue lane, `<style>` blocks.
 *
 * Parsed with `postcss` (pure JS, no grammar, no native code) — not tree-sitter. The lane is pure:
 * `extractCss` takes a source string and returns symbols and edges, so the Vue lane can call it once
 * per `<style>` block with that block's line offset.
 *
 * ## What becomes a symbol
 *
 * - **`css_variable`** — a custom-property DEFINITION (`--text-tertiary: #999`), named as written,
 *   leading dashes included. **One symbol per definition site.** A design token is routinely defined
 *   more than once — `:root` and `[data-theme="dark"]`, or a base file and a brand override — and those
 *   are different values; go-to-definition must list every site, not the first one.
 * - **`css_class`** — a class selector, named with its leading dot (`.btn`). **One symbol per name per
 *   file**, at its first occurrence. A class is styled by many rules (`.btn`, `.btn:hover`,
 *   `.card .btn`, `@media … .btn`); a symbol per rule would flood `search_symbols` and
 *   `get_file_summary` with the same name, and every consumer refers to a class by name anyway. The
 *   signature carries the first selector and how many rules style it.
 *
 * The leading `.` / `--` is kept in the name on purpose: name-based resolution elsewhere
 * (`callee:foo`, `type:Foo`) matches bare identifiers, and a CSS class named `foo` must never
 * become the target of a JavaScript call `foo()`. FTS still tokenises `.btn` to `btn` and
 * `--text-tertiary` to `text tertiary`, so a search by either spelling finds it.
 *
 * ## What becomes an edge
 *
 * - **`USES_CSS_VAR`** — a `var(--x)` reference. The source is the narrowest symbol that owns the
 *   declaration: the custom property being defined when the `var()` sits in another custom property's
 *   value (`--a: var(--b)` is `--a → --b`), otherwise the rule's subject class (the last class in
 *   each selector of the rule, walking out through nested rules), otherwise the file's module symbol.
 *   The target is ALWAYS the token `cssvar:<name>`, even when the variable is defined in the same
 *   file: a variable can be defined in several files, and only the post-phase
 *   (`resolveCssEdges`) sees all of them. Unresolved tokens are kept and labelled, never dropped.
 * - **`USES_CSS_CLASS`** — a markup use of a class. Not emitted here (a stylesheet does not *use* a
 *   class, it styles it); the Vue lane emits it from template `class` / `:class` literals via
 *   {@link classNamesFromStatic} and {@link cssClassToken}.
 * - **`IMPORTS`** — `@import 'x.css'` / `@import url(x.css)`, as an ordinary `import:<spec>` token,
 *   resolved by the shared import resolver like a JS relative import.
 *
 * A new edge type rather than `TYPE_REF` / `PROPERTY_REF`: those carry C#/TS meaning that several
 * tools read (`find_field_accesses`, the value-contract lane), and a CSS reference is neither.
 * Both CSS edge types are in `CALL_TRAVERSAL_EDGE_TYPES`, which is what makes "who uses
 * `--text-tertiary`" answerable through `get_call_chain` and `find_impact_files`.
 *
 * Parse errors throw (postcss `CssSyntaxError`); the pipeline counts them as parse failures. SCSS
 * and Less are not CSS — a `<style lang="scss">` block is the Vue lane's call to skip or attempt.
 */

import { parse } from "postcss";
import type { AtRule, ChildNode, Container, Declaration, Rule } from "postcss";
import type { EdgeRecord, SymbolRecord } from "../../types/index.js";
import type { ExtractInput } from "./extractorTypes.js";
import { makeSymbolId, stableId } from "./extractorPrimitives.js";

export const CSS_VARIABLE_KIND = "css_variable" as const;
export const CSS_CLASS_KIND = "css_class" as const;
export const CSS_VAR_TOKEN_PREFIX = "cssvar:";
export const CSS_CLASS_TOKEN_PREFIX = "cssclass:";
/** Labels on a CSS token edge before (or without) resolution. */
export const CSS_VAR_UNRESOLVED_REASON = "unresolved css variable token";
export const CSS_CLASS_UNRESOLVED_REASON = "unresolved css class token";
const CSS_TOKEN_CONFIDENCE = 0.5;
const MAX_SIGNATURE = 160;

export type CssExtractOptions = {
  /** `<style scoped>`: recorded in each symbol's signature so a caller can tell a scoped class apart. */
  scoped?: boolean;
  /**
   * The symbol an edge falls back to when no class or variable owns it. Defaults to the file's module
   * symbol, minted exactly as `extractGraphData` mints it — so a `.vue` file and a `.css` file both
   * get their own module.
   */
  moduleSymbolId?: string;
};

export type CssExtractResult = { symbols: SymbolRecord[]; edges: EdgeRecord[] };

/** Token a `var(--x)` reference points at until the post-phase binds it. */
export function cssVarToken(name: string): string {
  return `${CSS_VAR_TOKEN_PREFIX}${name}`;
}

/** Token a markup class use points at: `cssClassToken("btn")` and `cssClassToken(".btn")` both give `cssclass:.btn`. */
export function cssClassToken(className: string): string {
  return `${CSS_CLASS_TOKEN_PREFIX}${className.startsWith(".") ? className : `.${className}`}`;
}

/**
 * The class names in a static `class="a b"` attribute value, or in the string literals of a
 * `:class` binding the caller has already pulled out. Whitespace-separated, de-duplicated, order
 * kept. A token that is not a plausible class name (`{{ x }}`, `${y}`, empty) is skipped, never
 * guessed at.
 */
export function classNamesFromStatic(classAttr: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // An interpolation is dynamic; drop it whole so `{{ x }}` does not leave a bare `x` behind.
  const staticPart = classAttr.replace(/\{\{[\s\S]*?\}\}|\$\{[^}]*\}/g, " ");
  for (const raw of staticPart.split(/\s+/)) {
    const name = raw.trim();
    if (!name || !/^-?[_a-zA-Z][\w-]*$/.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** Class names in one selector, in order of appearance, without the dot. Handles `\:` escapes. */
export function classNamesInSelector(selector: string): string[] {
  // Attribute selectors and strings can contain dots (`[href$=".pdf"]`) — drop them first.
  const cleaned = selector.replace(/\[[^\]]*\]/g, " ").replace(/"[^"]*"|'[^']*'/g, " ");
  const out: string[] = [];
  const re = /\.((?:-?[_a-zA-Z]|\\.)(?:[\w-]|\\.)*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    out.push(m[1]!.replace(/\\(.)/g, "$1"));
  }
  return out;
}

/** Custom-property names referenced through `var(--x)` in a declaration value, fallbacks included. */
export function cssVarReferences(value: string): string[] {
  const out: string[] = [];
  const re = /var\(\s*(--[\w-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) out.push(m[1]!);
  return out;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_SIGNATURE ? flat : `${flat.slice(0, MAX_SIGNATURE)}...`;
}

function insideKeyframes(node: ChildNode): boolean {
  let p = node.parent as (Container & { type?: string; name?: string }) | undefined;
  while (p) {
    if (p.type === "atrule" && /keyframes$/i.test((p as unknown as AtRule).name)) return true;
    p = p.parent as (Container & { type?: string; name?: string }) | undefined;
  }
  return false;
}

/** The nearest enclosing rule, walking out through at-rules (`@media`, `@supports`, `@layer`). */
function enclosingRule(node: ChildNode): Rule | null {
  let p = node.parent as Container | undefined;
  while (p) {
    if ((p as { type?: string }).type === "rule") return p as unknown as Rule;
    p = p.parent as Container | undefined;
  }
  return null;
}

/**
 * Extract CSS symbols and edges from `source`.
 *
 * `lineOffset` is added to every postcss line: pass `blockStartLine - 1` for a `<style>` block whose
 * content starts on `blockStartLine` of the host file. Symbol ids are minted by `makeSymbolId` on the
 * absolute 0-indexed row, so a style block's ids are stable against edits elsewhere in the block
 * exactly as a script symbol's are.
 */
export function extractCss(
  source: string,
  input: { repoId: string; filePath: string },
  lineOffset = 0,
  options: CssExtractOptions = {}
): CssExtractResult {
  const idInput: ExtractInput = { repoId: input.repoId, filePath: input.filePath, language: "css", source: "" };
  const moduleSymbolId = options.moduleSymbolId ?? stableId(`${input.repoId}:${input.filePath}:module`);
  const scopedSuffix = options.scoped ? " [scoped]" : "";
  const root = parse(source, { from: undefined });

  const symbols: SymbolRecord[] = [];
  const edges: EdgeRecord[] = [];
  const edgeKeys = new Set<string>();

  // Pass 1 — class symbols, one per name per file (first occurrence wins; rule count accumulates).
  const classByName = new Map<string, { record: SymbolRecord; rules: number; firstSelector: string }>();
  root.walkRules((rule) => {
    if (insideKeyframes(rule)) return;
    const line = (rule.source?.start?.line ?? 1) + lineOffset;
    for (const selector of rule.selectors) {
      for (const cls of new Set(classNamesInSelector(selector))) {
        const name = `.${cls}`;
        const existing = classByName.get(name);
        if (existing) {
          existing.rules += 1;
          continue;
        }
        const record: SymbolRecord = {
          repoId: input.repoId,
          symbolId: makeSymbolId(idInput, CSS_CLASS_KIND, name, line - 1),
          filePath: input.filePath,
          name,
          kind: CSS_CLASS_KIND,
          line,
          endLine: (rule.source?.end?.line ?? line - lineOffset) + lineOffset
        };
        classByName.set(name, { record, rules: 1, firstSelector: selector });
      }
    }
  });
  for (const { record, rules, firstSelector } of classByName.values()) {
    record.signature = clip(`${firstSelector}${rules > 1 ? ` (${String(rules)} rules)` : ""}`) + scopedSuffix;
    symbols.push(record);
  }

  // The subject class of a rule: the last class of each selector, walking out through nested rules
  // until one has a class. `&:hover` inside `.btn {}` is still `.btn`.
  const subjectIds = (rule: Rule | null): string[] => {
    let current: Rule | null = rule;
    while (current) {
      const ids = new Set<string>();
      for (const selector of current.selectors) {
        const classes = classNamesInSelector(selector);
        const last = classes[classes.length - 1];
        const sym = last ? classByName.get(`.${last}`) : undefined;
        if (sym) ids.add(sym.record.symbolId);
      }
      if (ids.size > 0) return [...ids];
      current = enclosingRule(current as unknown as ChildNode);
    }
    return [];
  };

  const pushEdge = (fromId: string, varName: string): void => {
    const toId = cssVarToken(varName);
    const key = `${fromId}\u0000${toId}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({
      repoId: input.repoId,
      fromId,
      toId,
      type: "USES_CSS_VAR",
      confidence: CSS_TOKEN_CONFIDENCE,
      reason: CSS_VAR_UNRESOLVED_REASON
    });
  };

  // Pass 2 — variable definitions (one symbol per site) and var() uses.
  root.walkDecls((decl: Declaration) => {
    const line = (decl.source?.start?.line ?? 1) + lineOffset;
    const isDefinition = decl.prop.startsWith("--");
    let ownerIds: string[];
    if (isDefinition) {
      const rule = enclosingRule(decl);
      const where = rule ? clip(rule.selector) : "";
      const symbolId = makeSymbolId(idInput, CSS_VARIABLE_KIND, decl.prop, line - 1);
      symbols.push({
        repoId: input.repoId,
        symbolId,
        filePath: input.filePath,
        name: decl.prop,
        kind: CSS_VARIABLE_KIND,
        line,
        endLine: (decl.source?.end?.line ?? line - lineOffset) + lineOffset,
        signature: clip(`${decl.prop}: ${decl.value}${where ? ` @ ${where}` : ""}`) + scopedSuffix
      });
      ownerIds = [symbolId];
    } else {
      ownerIds = insideKeyframes(decl) ? [] : subjectIds(enclosingRule(decl));
      if (ownerIds.length === 0) ownerIds = [moduleSymbolId];
    }
    for (const ref of cssVarReferences(decl.value)) {
      for (const fromId of ownerIds) {
        // `--a: var(--a, …)` is a fallback chain on the same property, not a use of itself.
        if (isDefinition && ref === decl.prop) continue;
        pushEdge(fromId, ref);
      }
    }
  });

  // @import — the shared import resolver binds relative specs; bare package specs stay tokens.
  root.walkAtRules("import", (at) => {
    const m = /^\s*(?:url\(\s*)?["']?([^"')\s]+)["']?/i.exec(at.params);
    const spec = m?.[1];
    if (!spec) return;
    const toId = `import:${spec}`;
    const key = `${moduleSymbolId}\u0000${toId}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    // A remote stylesheet (Google Fonts, a CDN) can never resolve in-repo: classify it now as an
    // external boundary, the label the import resolver gives a provably-outside target, so it is
    // not counted as an unresolved import.
    const remote = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(spec);
    edges.push({
      repoId: input.repoId,
      fromId: moduleSymbolId,
      toId,
      type: "IMPORTS",
      ...(remote ? { confidence: 0.1, reason: "external boundary" } : {})
    });
  });

  return { symbols, edges };
}
