#!/usr/bin/env node

/**
 * The issue registry is one file per entry, so parallel rows never edit the same lines:
 *
 *   docs/issues/<ID>.md                         an entry (`## MCP-ISSUE-040 — title`), or a section
 *                                               slug for one that is not an entry
 *   docs/mcp-codebase-index-issue-registry.md   the preface and the narrative index, plus a generated
 *                                               list of every file under docs/issues/ (old links keep working)
 *
 *   node scripts/issue-index.mjs           rewrite the generated list in the registry
 *   node scripts/issue-index.mjs --check   exit 1 when the list is stale (`npm run test:issue-index`)
 *
 * Adding an entry: create docs/issues/MCP-ISSUE-<n>.md, then run this script. If two branches both added
 * one and the list conflicts, take either side and re-run it: the list is derived, never edited by hand.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "docs");
export const REGISTRY = path.join(DOCS, "mcp-codebase-index-issue-registry.md");
export const ISSUES_DIR = path.join(DOCS, "issues");

export const BEGIN = "<!-- BEGIN GENERATED: issue-files -->";
export const END = "<!-- END GENERATED: issue-files -->";

const ENTRY_ID = /^## ((?:MCP-)?ISSUE-(?:[A-Z]+-)?\d+) — /;

/** Where a `##` section's file name comes from: its id for an entry, a slug of the title otherwise. */
export function sectionFileName(headingLine) {
  const id = ENTRY_ID.exec(headingLine)?.[1];
  if (id) return `${id}.md`;
  const slug = headingLine.replace(/^##\s+/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
  return `${slug}.md`;
}

/**
 * Cut the pre-split registry into its head (the preface and `## Index`, up to the next `##`) and its
 * sections, each from its `## ` line to just before the next one. Fenced blocks are skipped, so a `## `
 * line inside one never starts a section. Concatenating the head and the sections gives the text back.
 */
export function splitRegistry(text) {
  const lines = text.split(/(?<=\n)/);
  const starts = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    else if (!fenced && /^## /.test(line)) starts.push(i);
  });
  if (starts.length < 2) throw new Error("expected a `## Index` section followed by at least one more `##` section");
  const sections = starts.slice(1).map((start, k) => {
    const end = starts[k + 2] ?? lines.length;
    return { heading: lines[start].trimEnd(), file: sectionFileName(lines[start]), text: lines.slice(start, end).join("") };
  });
  return { head: lines.slice(0, starts[1]).join(""), sections };
}

/** The title line of an issue file: its first `## ` heading. */
function headingOf(file) {
  const line = fs.readFileSync(file, "utf-8").split(/\r?\n/).find((l) => l.startsWith("## "));
  if (!line) throw new Error(`${file} has no \`## \` heading`);
  return line.replace(/^##\s+/, "");
}

/** The generated block: every issue file, entries in id order first, then the other sections. */
export function renderBlock(issuesDir = ISSUES_DIR) {
  const files = fs.existsSync(issuesDir) ? fs.readdirSync(issuesDir).filter((f) => f.endsWith(".md")) : [];
  const isEntry = (f) => /^(?:MCP-)?ISSUE-/.test(f);
  const byName = (a, b) => a.localeCompare(b, "en", { numeric: true });
  const ordered = [...files.filter(isEntry).sort(byName), ...files.filter((f) => !isEntry(f)).sort(byName)];
  const rows = ordered.map((f) => `- [${headingOf(path.join(issuesDir, f))}](issues/${f})`);
  return `${BEGIN}\n\n## Entries (one file each, \`docs/issues/\`)\n\n${rows.join("\n")}\n\n${END}\n`;
}

/** The registry text with the generated block replaced, or appended when the markers are absent. */
export function withBlock(registryText, block) {
  const a = registryText.indexOf(BEGIN);
  const b = registryText.indexOf(END);
  if (a === -1 && b === -1) return `${registryText.replace(/\s*$/, "\n")}\n${block}`;
  if (a === -1 || b === -1 || b < a) throw new Error("the registry has one generated-block marker without the other");
  return registryText.slice(0, a) + block + registryText.slice(b + END.length).replace(/^\r?\n/, "");
}

function main() {
  const check = process.argv.includes("--check");
  const current = fs.readFileSync(REGISTRY, "utf-8");
  const next = withBlock(current, renderBlock());
  if (next === current) return;
  if (check) {
    console.error("issue registry list is stale — run: node scripts/issue-index.mjs");
    process.exit(1);
  }
  fs.writeFileSync(REGISTRY, next);
  console.log(`updated ${path.relative(process.cwd(), REGISTRY)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
