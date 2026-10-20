/**
 * The HTML lane (MCP-ISSUE-077): an `.html` page is the entry of a Vite / static build, and what it
 * loads is the edge worth having. A `module` symbol plus one `IMPORTS` edge per local reference:
 *
 * | Tag | Attribute |
 * |---|---|
 * | `<script>` | `src` |
 * | `<link>` (stylesheet, icon, modulepreload, manifest — any rel) | `href` |
 * | `<img>`, `<source>` | `src` |
 * | `<use>`, `<image>` (inline SVG) | `href`, `xlink:href` |
 *
 * As `import:<spec>` tokens, bound to files by the shared import resolver after the run — the same path
 * a JS relative import takes, so `find_impact_files` on `src/main.ts` or `favicon.svg` lists the page.
 * IMPORTS rather than a new edge type: a bundler compiles exactly these references into module imports
 * (Vite's HTML entry, Vue's `transformAssetUrls`), and reusing it means every IMPORTS consumer —
 * `importedBy`, the dependency graph, impact — sees them without a change.
 *
 * Spec rules:
 * - remote (`https:`, `//cdn`), `data:`, `#frag`, `mailto:` and templated values (`%BASE_URL%`, `{{ }}`,
 *   `${}`) are not files and are skipped;
 * - `?query` and `#fragment` are cut (`sprite.svg#icon`);
 * - root-absolute `/src/main.ts` is relative to the page's directory, which is Vite's project root; a
 *   root-absolute STATIC asset (`/favicon.svg`) is served from `public/` by Vite, so it is looked for
 *   at `./public/favicon.svg`;
 * - only a target the index can hold gets an edge (a `.png` is never a node, so an edge to it could only
 *   ever be an unresolved token).
 *
 * Regex, not a parser: the six tag/attribute pairs above are all this lane reads, and a malformed page
 * still yields its well-formed tags rather than nothing.
 */

import type { EdgeRecord } from "../../types/index.js";
import type { ExtractInput } from "./extractorTypes.js";
import { languageForPath } from "../indexing/fileFilter.js";

const TAG_ATTRIBUTES: Record<string, readonly string[]> = {
  script: ["src"],
  link: ["href"],
  img: ["src"],
  source: ["src"],
  use: ["href", "xlink:href"],
  image: ["href", "xlink:href"]
};

const TAG_RE = /<(script|link|img|source|use|image)\b([^>]*)>/gi;
const ATTR_RE = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

/** Extensions Vite serves from `public/` when written root-absolute. */
const STATIC_ASSET_RE = /\.(svg|ico|png|jpe?g|gif|webp|avif|txt|webmanifest|json|xml)$/i;

export function extractHtml(input: ExtractInput, moduleSymbolId: string): { edges: EdgeRecord[] } {
  const edges: EdgeRecord[] = [];
  const seen = new Set<string>();
  // Comments hide tags (`<!-- <script src="old.js"> -->`); blank them, keeping offsets irrelevant.
  const source = input.source.replace(/<!--[\s\S]*?-->/g, "");

  for (const tagMatch of source.matchAll(TAG_RE)) {
    const tag = (tagMatch[1] ?? "").toLowerCase();
    const wanted = TAG_ATTRIBUTES[tag];
    if (!wanted) continue;
    for (const attrMatch of (tagMatch[2] ?? "").matchAll(ATTR_RE)) {
      const name = (attrMatch[1] ?? "").toLowerCase();
      if (!wanted.includes(name)) continue;
      const spec = localAssetSpec(attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "", true);
      if (!spec) continue;
      const toId = `import:${spec}`;
      if (seen.has(toId)) continue;
      seen.add(toId);
      edges.push({ repoId: input.repoId, fromId: moduleSymbolId, toId, type: "IMPORTS" });
    }
  }
  return { edges };
}

/**
 * The import specifier a markup reference stands for, or null when it is not a local, indexable file.
 * `rootAbsolute`: whether `/x` may be resolved (an HTML page's directory is the build root; a Vue
 * component's is not, so the Vue lane passes false).
 */
export function localAssetSpec(raw: string, rootAbsolute: boolean): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) return null; // https:, data:, mailto:, //cdn, #frag
  if (/[%{}$<>]/.test(value)) return null; // %BASE_URL%, {{ x }}, ${x}
  const spec = value.replace(/[?#].*$/, "");
  if (!spec || !languageForPath(spec)) return null;
  if (spec.startsWith("/")) {
    if (!rootAbsolute) return null;
    return STATIC_ASSET_RE.test(spec) ? `./public${spec}` : `.${spec}`;
  }
  if (spec.startsWith(".") || spec.startsWith("@/") || spec.startsWith("~")) {
    // Vue/webpack `~pkg/x.svg` is a module request for `pkg/x.svg`; `~/x` and `@/x` are aliases.
    return spec.startsWith("~") && !spec.startsWith("~/") ? spec.slice(1) : spec;
  }
  // A bare `main.ts` / `img/logo.svg` is relative to the page.
  return `./${spec}`;
}
