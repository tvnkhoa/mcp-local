/**
 * `.codebase-index/citations.json` — a repo's own citation shorthand (format v1,
 * `docs/citations-config.md`). Read by the indexer; the repo writes it, the server holds no pattern of
 * its own. wec.aria cites `docs/15 #737`, `adr/0057`, `SPEC-022`, `09 #10`; another repo cites
 * something else.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

export const CITATIONS_CONFIG_PATH = ".codebase-index/citations.json";

const anchorSchema = z.object({
  kind: z.enum(["file", "heading", "tableRow", "testName"]),
  value: z.string().min(1).max(200).optional(),
  column: z.number().int().min(1).max(20).optional()
});

const citationSchema = z.object({
  id: z.string().min(1).max(64),
  pattern: z.string().min(1).max(500),
  target: z.string().min(1).max(300),
  anchor: anchorSchema
});

const configSchema = z.object({
  version: z.literal(1),
  registryDoc: z.string().min(1).max(300).optional(),
  scan: z.object({ markdown: z.boolean().optional(), codeComments: z.boolean().optional() }).optional(),
  citations: z.array(z.unknown()).max(100)
});

export type CitationAnchorKind = z.infer<typeof anchorSchema>["kind"];

export type CompiledCitation = {
  id: string;
  regex: RegExp;
  target: string;
  anchor: { kind: CitationAnchorKind; value?: string; column: number };
};

export type CitationConfig = {
  registryDoc: string | null;
  scanMarkdown: boolean;
  scanCodeComments: boolean;
  citations: CompiledCitation[];
  /** sha256 of the raw file — a change re-scans every file, not only changed ones. */
  hash: string;
};

export type CitationConfigLoad = {
  /** null when the repo has no file (normal) or the file as a whole is unusable. */
  config: CitationConfig | null;
  /** One line per rejected entry or file-level problem; surfaced by health_check. */
  errors: string[];
  present: boolean;
};

export function loadCitationConfig(repoPath: string): CitationConfigLoad {
  const file = path.join(repoPath, CITATIONS_CONFIG_PATH);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { config: null, errors: [], present: false };
  }
  return parseCitationConfig(raw);
}

/** Pure: raw JSON text in, compiled config plus per-entry errors out. */
export function parseCitationConfig(raw: string): CitationConfigLoad {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { config: null, errors: [`${CITATIONS_CONFIG_PATH}: not valid JSON (${(e as Error).message})`], present: true };
  }
  const top = configSchema.safeParse(json);
  if (!top.success) {
    return {
      config: null,
      errors: top.error.issues.map((i) => `${CITATIONS_CONFIG_PATH}: ${i.path.join(".") || "file"}: ${i.message}`),
      present: true
    };
  }
  const errors: string[] = [];
  const citations: CompiledCitation[] = [];
  const seen = new Set<string>();
  top.data.citations.forEach((entry, index) => {
    const parsed = citationSchema.safeParse(entry);
    if (!parsed.success) {
      errors.push(`citations[${String(index)}]: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")} — entry ignored`);
      return;
    }
    const c = parsed.data;
    if (seen.has(c.id)) {
      errors.push(`citations[${String(index)}] (${c.id}): duplicate id — entry ignored`);
      return;
    }
    if ((c.anchor.kind === "heading" || c.anchor.kind === "tableRow" || c.anchor.kind === "testName") && !c.anchor.value) {
      errors.push(`citations[${String(index)}] (${c.id}): anchor.kind "${c.anchor.kind}" needs anchor.value — entry ignored`);
      return;
    }
    let regex: RegExp;
    try {
      regex = new RegExp(c.pattern, "g");
    } catch (e) {
      errors.push(`citations[${String(index)}] (${c.id}): invalid regex (${(e as Error).message}) — entry ignored`);
      return;
    }
    seen.add(c.id);
    citations.push({ id: c.id, regex, target: c.target, anchor: { kind: c.anchor.kind, ...(c.anchor.value && { value: c.anchor.value }), column: c.anchor.column ?? 1 } });
  });
  return {
    config: {
      registryDoc: top.data.registryDoc ?? null,
      scanMarkdown: top.data.scan?.markdown ?? true,
      scanCodeComments: top.data.scan?.codeComments ?? true,
      citations,
      hash: createHash("sha256").update(raw).digest("hex").slice(0, 16)
    },
    errors,
    present: true
  };
}
