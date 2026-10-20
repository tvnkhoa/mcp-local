/**
 * R3 exact — every read and write of one field, from the TypeScript LanguageService.
 *
 * Pipeline for one answer (all inside one {@link AnswerBudget}):
 * 1. program (built on a cold call — the expensive step);
 * 2. declarations of the name, split into property-like candidates and named non-matches
 *    (`fieldDeclarations.ts`);
 * 3. candidates grouped by `findReferences`: a candidate already among an earlier group's references
 *    is the same field (an interface property and the class implementing it; a field-bag key and the
 *    `z.infer` property derived from it) and joins that group;
 * 4. each reference classified DEFINITION / WRITE / READ (`fieldClassify.ts`);
 * 5. the Zod parse pass adds `X.parse({...})` writes and parse gaps (`zodParsePass.ts`);
 * 6. gaps: dynamic `obj[expr]` sites in referencing files, and `.vue` files mentioning the name
 *    (`.vue` is not in the program until the Volar lane).
 *
 * **Homonym policy.** With one candidate group the answer is that group. With several and no pick,
 * every group is still resolved (counts are exact per group) but no site list is returned — the
 * response is `ambiguous` with the candidates, and the caller re-asks with `declarationFile` (+
 * `declarationLine`) or `ownerName`. Returning one merged list would conflate different fields, which
 * is the failure this lane exists to remove; returning every group's full list multiplies the payload
 * for the common case where the caller wants one.
 */

import fs from "node:fs";
import path from "node:path";

import ts from "typescript";

import { AnswerBudget, currentRssMb, DEFAULT_TS_LS_CAPS, type TsLsCaps, type TsLsCapBreach } from "./caps.js";
import { classify, enclosingName, type AccessKind } from "./fieldClassify.js";
import { collectFieldDeclarations, wordRegex, type FieldDeclaration } from "./fieldDeclarations.js";
import { collectProgramFilesFromDisk, dropRepoLanguageService, type RepoLanguageService } from "./languageServiceHost.js";
import { findDynamicAccessGaps, runZodParsePass, siteKey } from "./zodParsePass.js";

export type FieldSite = {
  kind: AccessKind;
  how: string;
  notes: string[];
  file: string;
  line: number;
  col: number;
  enclosingName: string | null;
  viaParse: boolean;
};

export type FieldCandidate = {
  /** `file:line` of the primary declaration — what `declarationFile`/`declarationLine` pick. */
  id: string;
  file: string;
  line: number;
  declarationKind: FieldDeclaration["kind"];
  ownerName: string;
  /** For a field bag: the schemas it is spread into (also accepted as `ownerName`). */
  spreadInto: string[];
  /** Further declarations TypeScript proved to be the same field (z.infer property, implementing class). */
  aliases: { file: string; line: number }[];
  readCount: number;
  writeCount: number;
};

export type FieldGap = { file: string; line: number | null; reason: string };
export type FieldNonMatch = { file: string; line: number; kind: string; container: string | null };

export type FieldPick = { declarationFile?: string; declarationLine?: number; ownerName?: string };

export type FieldAnswerMeta = {
  engine: "typescript-language-service";
  typescriptVersion: string;
  tsconfig: string | null;
  rootFiles: number;
  programFiles: number;
  cold: boolean;
  /** Program build + first answer, measured on the call that built it. */
  coldMs: number | null;
  /** This answer's wall-clock when the program was already warm. */
  warmMs: number | null;
  totalMs: number;
  rssMb: number;
};

export type FieldAnswer =
  | { status: "ok"; field: string; selected: FieldCandidate; candidates: FieldCandidate[]; sites: FieldSite[]; nonMatches: FieldNonMatch[]; gaps: FieldGap[]; meta: FieldAnswerMeta }
  | { status: "ambiguous" | "pick_not_found"; field: string; candidates: FieldCandidate[]; nonMatches: FieldNonMatch[]; gaps: FieldGap[]; meta: FieldAnswerMeta }
  | { status: "no_declaration"; field: string; nonMatches: FieldNonMatch[]; gaps: FieldGap[]; meta: FieldAnswerMeta }
  | { status: "cap_breach"; field: string; breach: { kind: TsLsCapBreach["kind"]; detail: string }; meta: Pick<FieldAnswerMeta, "engine" | "cold" | "totalMs" | "rssMb" | "rootFiles"> };

type Group = { decls: FieldDeclaration[]; sites: Map<string, FieldSite>; keys: Set<string>; files: Set<string>; gaps: FieldGap[] };

export function findFieldReferences(svc: RepoLanguageService, field: string, pick: FieldPick = {}, caps: TsLsCaps = DEFAULT_TS_LS_CAPS): FieldAnswer {
  const budget = new AnswerBudget(caps);
  const cold = !svc.isBuilt;
  try {
    return svc.withBudget(budget, () => answer(svc, field, pick, budget, cold));
  } catch (error) {
    const breach = budget.breachFrom(error);
    if (!breach) throw error;
    if (breach.kind === "memory") dropRepoLanguageService(svc.repoId);
    return {
      status: "cap_breach",
      field,
      breach: { kind: breach.kind, detail: breach.detail },
      meta: { engine: "typescript-language-service", cold, totalMs: budget.elapsedMs(), rssMb: currentRssMb(), rootFiles: svc.rootFiles.length }
    };
  }
}

function answer(svc: RepoLanguageService, field: string, pick: FieldPick, budget: AnswerBudget, cold: boolean): FieldAnswer {
  const program = svc.program(budget);
  const repoRoot = normalizeRoot(svc.repoPath);
  const caseInsensitive = !ts.sys.useCaseSensitiveFileNames;
  const isRepoFile = (fileName: string): boolean => {
    const f = caseInsensitive ? fileName.toLowerCase() : fileName;
    const root = caseInsensitive ? repoRoot.toLowerCase() : repoRoot;
    return f.startsWith(`${root}/`) && !f.includes("/node_modules/");
  };
  const rel = (fileName: string): string => path.relative(svc.repoPath, fileName).replace(/\\/g, "/");
  const lineOf = (sf: ts.SourceFile, pos: number): { line: number; col: number } => {
    const lc = sf.getLineAndCharacterOfPosition(pos);
    return { line: lc.line + 1, col: lc.character + 1 };
  };

  const { declarations, nonMatches } = collectFieldDeclarations(svc.ls, program, field, isRepoFile);
  budget.check("declaration scan");

  // ── group candidates by findReferences ──
  const groups: Group[] = [];
  const groupOfKey = new Map<string, number>();
  for (const decl of declarations) {
    const key = siteKey(decl.sf.fileName, decl.pos);
    const existing = groupOfKey.get(key);
    if (existing !== undefined) {
      groups[existing]!.decls.push(decl);
      continue;
    }
    const index = groups.length;
    const group: Group = { decls: [decl], sites: new Map(), keys: new Set([key]), files: new Set(), gaps: [] };
    groups.push(group);
    groupOfKey.set(key, index);
    const referenced = svc.ls.findReferences(decl.sf.fileName, decl.pos) ?? [];
    budget.check("findReferences");
    for (const symbol of referenced) {
      for (const ref of symbol.references) {
        if (!isRepoFile(ref.fileName)) continue;
        const sf = program.getSourceFile(ref.fileName);
        if (!sf) continue;
        const refKey = siteKey(ref.fileName, ref.textSpan.start);
        const cls = classify(sf, ref.textSpan.start, ref.isDefinition === true);
        const declared = declarations.find((d) => d.sf.fileName === ref.fileName && d.pos === ref.textSpan.start);
        if (declared && cls.kind === "DEFINITION") cls.how = declared.kind === "zod-field-bag" ? `zod field bag \`${declared.ownerName}\` (spread into ${declared.spreadInto.join(", ")})` : declared.kind;
        if (cls.kind === "DEFINITION") {
          group.keys.add(refKey);
          if (!groupOfKey.has(refKey)) groupOfKey.set(refKey, index);
        }
        group.files.add(ref.fileName);
        const { line, col } = lineOf(sf, ref.textSpan.start);
        group.sites.set(refKey, { ...cls, file: rel(ref.fileName), line, col, enclosingName: enclosingName(sf, ref.textSpan.start), viaParse: false });
      }
    }
  }

  // ── Zod parse pass + dynamic access gaps ──
  const parse = runZodParsePass(program, field, groupOfKey, isRepoFile, () => budget.check("zod parse pass"));
  for (const w of parse.writes) {
    const group = groups[w.groupIndex]!;
    const key = siteKey(w.sf.fileName, w.pos);
    if (group.sites.has(key)) continue;
    const { line, col } = lineOf(w.sf, w.pos);
    group.sites.set(key, { kind: "WRITE", how: w.how, notes: [`schema: ${w.schemaExpression}`], file: rel(w.sf.fileName), line, col, enclosingName: enclosingName(w.sf, w.pos), viaParse: true });
    group.files.add(w.sf.fileName);
  }
  for (const g of parse.gaps) groups[g.groupIndex]!.gaps.push({ file: rel(g.sf.fileName), line: lineOf(g.sf, g.pos).line, reason: g.reason });
  budget.check("zod parse pass");
  for (const g of findDynamicAccessGaps(program, dynamicScanFiles(program, groups, isRepoFile), field, groupOfKey)) {
    groups[g.groupIndex]!.gaps.push({ file: rel(g.sf.fileName), line: lineOf(g.sf, g.pos).line, reason: g.reason });
  }
  budget.check("gap scan");
  const vueGaps = vueFileGaps(svc, field);

  const totalMs = budget.elapsedMs();
  const meta: FieldAnswerMeta = {
    engine: "typescript-language-service",
    typescriptVersion: ts.version,
    tsconfig: svc.tsconfig ? rel(svc.tsconfig) : null,
    rootFiles: svc.rootFiles.length,
    programFiles: program.getSourceFiles().length,
    cold,
    coldMs: cold ? totalMs : svc.coldMs,
    warmMs: cold ? null : totalMs,
    totalMs,
    rssMb: currentRssMb()
  };
  if (cold) svc.coldMs = totalMs;

  const outNonMatches = nonMatches.map((n) => ({ file: rel(n.sf.fileName), ...pickLine(lineOf(n.sf, n.pos)), kind: n.kind, container: n.container }));
  const candidates = groups.map((g) => toCandidate(g, rel, lineOf));
  if (groups.length === 0) return { status: "no_declaration", field, nonMatches: outNonMatches, gaps: vueGaps, meta };

  const chosen = choose(groups, candidates, pick);
  if (chosen === null || chosen === "none") {
    return { status: chosen === "none" ? "pick_not_found" : "ambiguous", field, candidates, nonMatches: outNonMatches, gaps: vueGaps, meta };
  }
  const group = groups[chosen]!;
  const sites = [...group.sites.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col);
  return { status: "ok", field, selected: candidates[chosen]!, candidates, sites, nonMatches: outNonMatches, gaps: [...group.gaps, ...vueGaps], meta };
}

/**
 * Files worth checking for `obj[key]`: those that already reference a group, plus those that mention
 * an owner by name — the schema / bag / interface names, and every top-level type or interface the
 * declaring files define (`type AuditEvent = z.infer<typeof audit_event_schema>` is how a reader names
 * the owner without ever writing the field). A text prefilter; the checker then decides each site.
 */
function dynamicScanFiles(program: ts.Program, groups: Group[], isRepoFile: (f: string) => boolean): Set<string> {
  const files = new Set(groups.flatMap((g) => [...g.files]));
  const tokens = new Set<string>();
  const declaringFiles = new Set<ts.SourceFile>();
  for (const g of groups) {
    for (const d of g.decls) {
      declaringFiles.add(d.sf);
      if (!d.ownerName.startsWith("<")) tokens.add(d.ownerName);
      d.spreadInto.forEach((s) => tokens.add(s));
    }
  }
  for (const sf of declaringFiles) {
    for (const st of sf.statements) {
      if ((ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isClassDeclaration(st)) && st.name) tokens.add(st.name.text);
    }
  }
  if (tokens.size === 0) return files;
  const res = [...tokens].map((t) => wordRegex(t));
  for (const sf of program.getSourceFiles()) {
    if (files.has(sf.fileName) || !isRepoFile(sf.fileName) || !sf.text.includes("[")) continue;
    if (res.some((re) => re.test(sf.text))) files.add(sf.fileName);
  }
  return files;
}

function pickLine(lc: { line: number }): { line: number } {
  return { line: lc.line };
}

function toCandidate(
  g: Group,
  rel: (f: string) => string,
  lineOf: (sf: ts.SourceFile, pos: number) => { line: number; col: number }
): FieldCandidate {
  const primary = g.decls[0]!;
  const file = rel(primary.sf.fileName);
  const line = lineOf(primary.sf, primary.pos).line;
  const aliasSites = [...g.sites.values()].filter((s) => s.kind === "DEFINITION" && !(s.file === file && s.line === line));
  const extraDecls = g.decls.slice(1).map((d) => ({ file: rel(d.sf.fileName), line: lineOf(d.sf, d.pos).line }));
  const aliases = dedupe([...extraDecls, ...aliasSites.map((s) => ({ file: s.file, line: s.line }))]);
  let readCount = 0;
  let writeCount = 0;
  for (const s of g.sites.values()) {
    if (s.kind === "READ") readCount++;
    else if (s.kind === "WRITE") writeCount++;
  }
  return { id: `${file}:${String(line)}`, file, line, declarationKind: primary.kind, ownerName: primary.ownerName, spreadInto: primary.spreadInto, aliases, readCount, writeCount };
}

function dedupe(xs: { file: string; line: number }[]): { file: string; line: number }[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = `${x.file}:${String(x.line)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Index of the picked group; null = ambiguous (no pick, several groups); "none" = a pick matched nothing. */
function choose(groups: Group[], candidates: FieldCandidate[], pick: FieldPick): number | null | "none" {
  const hasPick = pick.declarationFile !== undefined || pick.ownerName !== undefined;
  if (!hasPick) return groups.length === 1 ? 0 : null;
  const wantFile = pick.declarationFile?.replace(/\\/g, "/").replace(/^\.\//, "");
  const matches = candidates
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => {
      if (pick.ownerName !== undefined && c.ownerName !== pick.ownerName && !c.spreadInto.includes(pick.ownerName)) return false;
      if (wantFile !== undefined) {
        const places = [{ file: c.file, line: c.line }, ...c.aliases];
        return places.some((p) => (p.file === wantFile || p.file.endsWith(`/${wantFile}`)) && (pick.declarationLine === undefined || p.line === pick.declarationLine));
      }
      return true;
    });
  if (matches.length === 1) return matches[0]!.i;
  return matches.length === 0 ? "none" : null;
}

function normalizeRoot(repoPath: string): string {
  let root = repoPath.replace(/\\/g, "/").replace(/\/$/, "");
  try {
    root = fs.realpathSync.native(repoPath).replace(/\\/g, "/").replace(/\/$/, "");
  } catch {
    // keep the given spelling
  }
  return root;
}

// ── .vue: a named gap per file until the Volar lane ──

const vueFilesCache = new WeakMap<RepoLanguageService, { runKey: string; files: string[] }>();

function vueFileGaps(svc: RepoLanguageService, field: string): FieldGap[] {
  let cached = vueFilesCache.get(svc);
  if (!cached || cached.runKey !== svc.runKey) {
    cached = { runKey: svc.runKey, files: collectProgramFilesFromDisk(svc.repoPath, [".vue"]) };
    vueFilesCache.set(svc, cached);
  }
  const re = wordRegex(field);
  const gaps: FieldGap[] = [];
  for (const rel of cached.files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(svc.repoPath, rel), "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    const hits: number[] = [];
    lines.forEach((l, i) => {
      if (re.test(l)) hits.push(i + 1);
    });
    if (hits.length > 0) {
      gaps.push({ file: rel, line: hits[0]!, reason: `.vue file mentions the name on line(s) ${hits.slice(0, 8).join(", ")}${hits.length > 8 ? ", …" : ""}; Vue SFCs are not in the TypeScript program yet (Volar lane), so these sites are not classified` });
    }
  }
  return gaps;
}
