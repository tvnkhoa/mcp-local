/**
 * Vue single-file component → its blocks (MCP-ISSUE-074, stage 1).
 *
 * The split is `@vue/compiler-sfc`'s own `parse`, not a regex: a `<script>` inside a template string,
 * a `</template>` in a comment or a second `<script setup>` are exactly the inputs a hand-rolled
 * splitter gets wrong, and the compiler is what Vite runs on the same file. It is pure JavaScript, so
 * nothing native is added to the build.
 *
 * Everything here keeps FILE coordinates. The compiler reports each block's `loc` against the whole
 * `.vue` source, and the template AST it builds (`descriptor.template.ast`) carries absolute offsets
 * and lines too, so no caller ever has to add an offset back.
 *
 * **The CSS hook.** `styles` is returned for the CSS lane (`cssExtractor.ts`, a separate change) to
 * plug into: each `<style>` block with its content, start line, `lang`, `scoped` and `module`. This
 * file deliberately does nothing else with them.
 */

import { createRequire } from "node:module";

import type { SFCDescriptor, SFCParseOptions, SFCParseResult } from "@vue/compiler-sfc";

export type VueScriptBlock = {
  content: string;
  /** Offset of the first content character in the `.vue` source (UTF-16 index). */
  startOffset: number;
  endOffset: number;
  /** 1-indexed line of the first content character in the `.vue` source. */
  startLine: number;
  /** `ts`, `tsx`, `js`, `jsx` — `js` when the block declares no `lang`. */
  lang: string;
  setup: boolean;
};

export type VueStyleBlock = {
  content: string;
  startOffset: number;
  startLine: number;
  /** `css` when the block declares no `lang` (`scss`, `less`, `stylus`, `postcss` otherwise). */
  lang: string;
  scoped: boolean;
  /** `<style module>` / `<style module="name">`: true or the module name. */
  module: boolean | string;
};

export type VueTemplateBlock = {
  startOffset: number;
  startLine: number;
  /** `html` when the block declares no `lang`. */
  lang: string;
  /**
   * The compiler's template AST (`@vue/compiler-core` `RootNode`), absolute locations. Null for a
   * non-HTML template (`lang="pug"`), which the compiler does not parse — reported as a gap.
   */
  ast: unknown;
};

export type VueSfcSplit = {
  scripts: VueScriptBlock[];
  template: VueTemplateBlock | null;
  styles: VueStyleBlock[];
  /** Parse errors as `line: message`; the split is best effort and still returns what it read. */
  errors: string[];
};

type CompilerSfc = { parse: (source: string, options?: SFCParseOptions) => SFCParseResult };

let compilerSfc: CompilerSfc | null = null;

/**
 * Loaded on first use, not at module load: the extraction worker imports this lane for every
 * repository, and a repo with no `.vue` file should not pay for postcss and the Babel parser that
 * the compiler pulls in.
 */
function loadCompilerSfc(): CompilerSfc {
  if (!compilerSfc) {
    const require = createRequire(import.meta.url);
    compilerSfc = require("@vue/compiler-sfc") as CompilerSfc;
  }
  return compilerSfc;
}

function errorLine(error: unknown): string {
  if (error && typeof error === "object") {
    const loc = (error as { loc?: { start?: { line?: number } } }).loc;
    const message = (error as { message?: unknown }).message;
    return `${String(loc?.start?.line ?? 0)}: ${typeof message === "string" ? message : String(error)}`;
  }
  return `0: ${String(error)}`;
}

export function splitVueSfc(source: string, filePath: string): VueSfcSplit {
  let descriptor: SFCDescriptor;
  let rawErrors: unknown[];
  try {
    const result = loadCompilerSfc().parse(source, {
      filename: filePath,
      sourceMap: false,
      // An empty `<script setup></script>` is still a script block whose position matters.
      ignoreEmpty: false
    });
    descriptor = result.descriptor;
    rawErrors = result.errors;
  } catch (error) {
    return { scripts: [], template: null, styles: [], errors: [errorLine(error)] };
  }

  const scripts: VueScriptBlock[] = [];
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block) continue;
    scripts.push({
      content: block.content,
      startOffset: block.loc.start.offset,
      endOffset: block.loc.end.offset,
      startLine: block.loc.start.line,
      lang: block.lang ?? "js",
      setup: Boolean(block.setup)
    });
  }
  scripts.sort((a, b) => a.startOffset - b.startOffset);

  const template = descriptor.template
    ? {
        startOffset: descriptor.template.loc.start.offset,
        startLine: descriptor.template.loc.start.line,
        lang: descriptor.template.lang ?? "html",
        ast: descriptor.template.ast ?? null
      }
    : null;

  const styles: VueStyleBlock[] = descriptor.styles.map((style) => ({
    content: style.content,
    startOffset: style.loc.start.offset,
    startLine: style.loc.start.line,
    lang: style.lang ?? "css",
    scoped: Boolean(style.scoped),
    module: style.module ?? false
  }));

  return { scripts, template, styles, errors: rawErrors.map(errorLine) };
}

/**
 * The source with every character outside `ranges` blanked to a space, newlines kept.
 *
 * This is how the script blocks are handed to the TypeScript extractor "at a line offset" without any
 * offset arithmetic: the masked text has the same length and the same line breaks as the `.vue`
 * file, so every tree-sitter row IS the real `.vue` row. That matters beyond display — `makeSymbolId`
 * keys a symbol id on its row, and an edge's `fromId` is re-minted from the row of its enclosing
 * node; a block-relative row would mint ids that are right inside the block and wrong in the file.
 */
export function maskOutsideRanges(source: string, ranges: readonly { start: number; end: number }[]): string {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const range of sorted) {
    const start = Math.max(cursor, range.start);
    const end = Math.min(source.length, Math.max(start, range.end));
    out += blank(source.slice(cursor, start));
    out += source.slice(start, end);
    cursor = end;
  }
  out += blank(source.slice(cursor));
  return out;
}

function blank(text: string): string {
  return text.replace(/[^\r\n]/g, " ");
}

/**
 * The script blocks of a `.vue` source, every other character blanked — for the comment and citation
 * scanners, which read raw text and run in the main thread where the compiler is not worth loading.
 *
 * A scan rather than `splitVueSfc` on purpose: those scanners only need "is this character inside a
 * `<script>` block", and template prose (`it's`, `don't`) read as C-like source opens string literals
 * that swallow the comments after them.
 */
export function maskVueToScripts(source: string): string {
  const ranges: { start: number; end: number }[] = [];
  const pattern = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const contentStart = match.index + match[0].indexOf(">") + 1;
    ranges.push({ start: contentStart, end: contentStart + (match[1]?.length ?? 0) });
  }
  return maskOutsideRanges(source, ranges);
}
