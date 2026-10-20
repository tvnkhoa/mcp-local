/**
 * Resolve a citation's target spec + anchor to a file and line, at query time, from the files as they
 * are on disk. Query time on purpose: a dirty-mode run sees only a few files, and "show row #737"
 * should show the row as it reads now.
 */

import fs from "node:fs";
import path from "node:path";

import { glob } from "glob";

import { listHeadings, matchHeadings } from "../analysis/docSection.js";

export type CitationResolution = {
  targetSpec: string;
  anchorKind: string;
  anchorValue: string | null;
  status: "resolved" | "anchor_not_found" | "target_missing" | "target_ambiguous";
  file?: string;
  line?: number;
  /** The cited table row or heading text, when the anchor is one. */
  text?: string;
  candidates?: string[];
};

const MAX_TEXT = 2000;

function cellKey(cell: string): string {
  return cell.replace(/[`*_~]/g, "").replace(/^#/, "").trim().toLowerCase();
}

/** Split a markdown table row into cells; null when the line is not a row (or is the separator). */
function tableCells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  if (/^\|?\s*:?-{2,}/.test(t)) return null;
  return t.replace(/^\|/, "").replace(/\|\s*$/, "").split("|");
}

export class CitationResolver {
  private readonly fileCache = new Map<string, string[] | null>();
  private readonly specCache = new Map<string, string[]>();

  constructor(private readonly repoPath: string) {}

  private filesFor(spec: string): string[] {
    const hit = this.specCache.get(spec);
    if (hit) return hit;
    let files: string[];
    if (/[*?[\]{}]/.test(spec)) {
      files = glob.sync(spec, { cwd: this.repoPath, nodir: true, dot: true, windowsPathsNoEscape: true }).map((p) => p.replace(/\\/g, "/")).sort();
    } else {
      files = fs.existsSync(path.join(this.repoPath, spec)) ? [spec] : [];
    }
    this.specCache.set(spec, files);
    return files;
  }

  private lines(file: string): string[] | null {
    if (!this.fileCache.has(file)) {
      try {
        this.fileCache.set(file, fs.readFileSync(path.join(this.repoPath, file), "utf8").split(/\r?\n/));
      } catch {
        this.fileCache.set(file, null);
      }
    }
    return this.fileCache.get(file) ?? null;
  }

  resolve(c: { targetSpec: string; anchorKind: string; anchorValue: string | null; anchorColumn?: number }): CitationResolution {
    const base = { targetSpec: c.targetSpec, anchorKind: c.anchorKind, anchorValue: c.anchorValue };
    const files = this.filesFor(c.targetSpec);
    if (files.length === 0) return { ...base, status: "target_missing" };
    if (files.length > 1) return { ...base, status: "target_ambiguous", candidates: files.slice(0, 10) };
    const file = files[0]!;
    if (c.anchorKind === "file" || !c.anchorValue) return { ...base, status: "resolved", file, line: 1 };
    const lines = this.lines(file);
    if (!lines) return { ...base, status: "target_missing" };

    if (c.anchorKind === "tableRow") {
      const want = cellKey(c.anchorValue);
      const col = Math.max(1, c.anchorColumn ?? 1) - 1;
      for (let i = 0; i < lines.length; i++) {
        const cells = tableCells(lines[i]!);
        if (cells && cells[col] !== undefined && cellKey(cells[col]) === want) {
          return { ...base, status: "resolved", file, line: i + 1, text: lines[i]!.slice(0, MAX_TEXT) };
        }
      }
      return { ...base, status: "anchor_not_found", file };
    }
    if (c.anchorKind === "heading") {
      const headings = listHeadings(lines);
      const m = matchHeadings(headings, c.anchorValue)[0];
      return m ? { ...base, status: "resolved", file, line: m.line, text: m.text } : { ...base, status: "anchor_not_found", file };
    }
    if (c.anchorKind === "testName") {
      const name = c.anchorValue.trim();
      for (let i = 0; i < lines.length; i++) {
        const m = /\b(?:it|test|describe)(?:\.\w+)?\(\s*(['"`])(.*?)\1/.exec(lines[i]!);
        if (m && m[2]!.includes(name)) return { ...base, status: "resolved", file, line: i + 1, text: lines[i]!.trim().slice(0, MAX_TEXT) };
      }
      return { ...base, status: "anchor_not_found", file };
    }
    return { ...base, status: "resolved", file, line: 1 };
  }
}
