/**
 * The JSON lane (MCP-ISSUE-076). Every `.json` file is a `module` symbol whose string values go to the
 * literal lane (the text level of `plainTextExtractor.ts`); two kinds of file also get edges.
 *
 * ## `package.json`
 *
 * - The module symbol's `signature` is `npm:<name>` — the package this file declares, the npm twin of a
 *   `.csproj`'s `nuget:` contract id. The workspace pass reads it.
 * - **`DEPENDS_ON npm:<pkg>`** per entry of `dependencies`, `devDependencies`, `peerDependencies` and
 *   `optionalDependencies`, with the section and the version range in `reason`
 *   (`npm devDependency (^1.2.0)`). Like C#'s `nuget:` tokens these are KEPT as labelled tokens, never
 *   dropped and never counted as unresolved: a package outside the repo is a fact about the repo.
 * - **Workspace edges** are added after the run by `resolveWorkspacePackageEdges`: a dependency that
 *   names a package declared by another `package.json` of the same repo (pnpm/yarn `workspace:*`, or a
 *   plain range on a local package) gets a second `DEPENDS_ON` straight to that package.json's module.
 *   It cannot be done here — a file knows the names it depends on, not which file declares them.
 *
 * ## `tsconfig*.json` / `jsconfig*.json`
 *
 * `IMPORTS` edges, as `import:<spec>` tokens the shared import resolver binds to files:
 * - `extends` (string or array) — a relative spec gets `.json` when it has none, as TypeScript reads it;
 *   a package spec (`@vue/tsconfig/tsconfig.dom.json`) is labelled `npm_package`, like a JS bare import;
 * - `references[].path` — a directory means its `tsconfig.json`;
 * - `compilerOptions.paths` targets, joined to `baseUrl`. A target without `*` resolves to its file
 *   (with the resolver's extension and index rules); a `*` target names a directory pattern, not a file,
 *   and is kept as a labelled token (`tsconfig paths glob (@/* → ./src/*)`).
 *
 * The text is JSONC (comments, trailing commas), parsed through the same scanner `readTsconfigAliases`
 * uses. A file that still does not parse is NOT a parse failure: it keeps its module symbol and its
 * quoted strings, because invalid JSON in a fixture directory is normal.
 */

import path from "node:path";

import type { EdgeRecord, StringLiteralRecord, SymbolRecord } from "../../types/index.js";
import type { ExtractInput } from "./extractorTypes.js";
import { stripJsonComments } from "../graph/moduleResolution.js";
import { LiteralCollector, collectJsonStrings, extractPlainText, type TextLiteralPolicy } from "./plainTextExtractor.js";

export const NPM_TOKEN_PREFIX = "npm:";

const DEPENDENCY_SECTIONS: ReadonlyArray<readonly [string, string]> = [
  ["dependencies", "dependency"],
  ["devDependencies", "devDependency"],
  ["peerDependencies", "peerDependency"],
  ["optionalDependencies", "optionalDependency"]
];

export type JsonExtractResult = { edges: EdgeRecord[]; literals: StringLiteralRecord[]; moduleSignature?: string };

export function extractJson(input: ExtractInput, moduleSymbolId: string, policy: TextLiteralPolicy): JsonExtractResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(input.source));
  } catch {
    return { edges: [], literals: extractPlainText(input, policy) };
  }

  const collector = new LiteralCollector(input, policy);
  collectJsonStrings(parsed, 1, collector);
  const literals = locateLiterals(collector.rows, input.source);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { edges: [], literals };
  const doc = parsed as Record<string, unknown>;
  const basename = (input.filePath.split(/[\\/]/).pop() ?? "").toLowerCase();

  if (basename === "package.json") {
    const edges = packageJsonEdges(input, moduleSymbolId, doc);
    const name = typeof doc.name === "string" && doc.name.trim() ? doc.name.trim() : null;
    return { edges, literals, ...(name ? { moduleSignature: `${NPM_TOKEN_PREFIX}${name}` } : {}) };
  }
  if (/^(tsconfig|jsconfig)([.-][^/]*)?\.json$/.test(basename)) {
    return { edges: tsconfigEdges(input, moduleSymbolId, doc), literals };
  }
  return { edges: [], literals };
}

function packageJsonEdges(input: ExtractInput, moduleSymbolId: string, doc: Record<string, unknown>): EdgeRecord[] {
  const edges: EdgeRecord[] = [];
  const seen = new Set<string>();
  for (const [section, label] of DEPENDENCY_SECTIONS) {
    const deps = doc[section];
    if (!deps || typeof deps !== "object" || Array.isArray(deps)) continue;
    for (const [name, range] of Object.entries(deps as Record<string, unknown>)) {
      const pkg = name.trim();
      if (!pkg) continue;
      const toId = `${NPM_TOKEN_PREFIX}${pkg}`;
      // A package listed in two sections (peer + dev is common) is one dependency: first section wins.
      if (seen.has(toId)) continue;
      seen.add(toId);
      const version = typeof range === "string" && range.trim() ? range.trim() : null;
      edges.push({
        repoId: input.repoId,
        fromId: moduleSymbolId,
        toId,
        type: "DEPENDS_ON",
        confidence: 0.9,
        reason: version ? `npm ${label} (${version})` : `npm ${label}`
      });
    }
  }
  return edges;
}

function tsconfigEdges(input: ExtractInput, moduleSymbolId: string, doc: Record<string, unknown>): EdgeRecord[] {
  const edges: EdgeRecord[] = [];
  const seen = new Set<string>();
  const push = (spec: string, extra: Partial<EdgeRecord> = {}): void => {
    const toId = `import:${spec}`;
    if (seen.has(toId)) return;
    seen.add(toId);
    edges.push({ repoId: input.repoId, fromId: moduleSymbolId, toId, type: "IMPORTS", ...extra });
  };

  const extendsValue = doc.extends;
  const extendsList = typeof extendsValue === "string" ? [extendsValue] : Array.isArray(extendsValue) ? extendsValue : [];
  for (const raw of extendsList) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const spec = raw.trim();
    if (spec.startsWith(".")) {
      push(/\.json$/i.test(spec) ? spec : `${spec}.json`);
    } else {
      push(spec, { confidence: 0.8, reason: "npm_package" });
    }
  }

  const references = doc.references;
  if (Array.isArray(references)) {
    for (const ref of references) {
      const refPath = ref && typeof ref === "object" ? (ref as Record<string, unknown>).path : null;
      if (typeof refPath !== "string" || !refPath.trim()) continue;
      const target = /\.json$/i.test(refPath.trim()) ? refPath.trim() : `${refPath.trim().replace(/\/+$/, "")}/tsconfig.json`;
      push(asRelativeSpec(target));
    }
  }

  const options = doc.compilerOptions;
  if (options && typeof options === "object" && !Array.isArray(options)) {
    const opts = options as Record<string, unknown>;
    const baseUrl = typeof opts.baseUrl === "string" ? opts.baseUrl : ".";
    const paths = opts.paths;
    if (paths && typeof paths === "object" && !Array.isArray(paths)) {
      for (const [pattern, targets] of Object.entries(paths as Record<string, unknown>)) {
        if (!Array.isArray(targets)) continue;
        for (const target of targets) {
          if (typeof target !== "string" || !target.trim()) continue;
          const spec = asRelativeSpec(path.posix.join(baseUrl.replace(/\\/g, "/"), target.trim().replace(/\\/g, "/")));
          if (spec.includes("*")) {
            push(spec, { confidence: 0.6, reason: `tsconfig paths glob (${pattern} → ${spec})` });
          } else {
            push(spec);
          }
        }
      }
    }
  }
  return edges;
}

/** `packages/core/tsconfig.json` → `./packages/core/tsconfig.json`; `../x` stays as it is. */
function asRelativeSpec(target: string): string {
  const normalized = path.posix.normalize(target.replace(/\\/g, "/"));
  if (normalized.startsWith("../") || normalized === "..") return normalized;
  if (normalized.startsWith("/")) return `.${normalized}`;
  return normalized.startsWith("./") ? normalized : `./${normalized}`;
}

/**
 * The JSON walk sees values, not positions. Put each literal on the first line its quoted form appears
 * on (one pass over the lines, a value matched once), so `search_literals` points at the right line of a
 * multi-line file. A value whose escaped form is not found keeps line 1.
 */
function locateLiterals(rows: StringLiteralRecord[], source: string): StringLiteralRecord[] {
  if (rows.length === 0) return rows;
  const lines = source.split(/\r?\n/);
  if (lines.length === 1) return rows;
  const pending = new Map(rows.map((row) => [JSON.stringify(row.value), row]));
  for (let i = 0; i < lines.length && pending.size > 0; i += 1) {
    const line = lines[i] ?? "";
    if (!line.includes('"')) continue;
    for (const [quoted, row] of pending) {
      if (line.includes(quoted)) {
        row.line = i + 1;
        pending.delete(quoted);
      }
    }
  }
  return rows;
}

/** For the module symbol: the declared package, so the workspace pass can find it by name. */
export function applyModuleSignature(symbols: SymbolRecord[], moduleSymbolId: string, signature: string | undefined): void {
  if (!signature) return;
  const moduleSymbol = symbols.find((s) => s.symbolId === moduleSymbolId);
  if (moduleSymbol) moduleSymbol.signature = signature;
}
