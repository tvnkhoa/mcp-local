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
 * 6. gaps: dynamic `obj[expr]` sites in referencing files;
 * 7. the Vue lane (`vueProgram.ts`): each group is re-asked in the Vue program, `.vue` declarations
 *    form groups of their own, and `.vue` hits are mapped back to real `.vue` lines and classified
 *    like TS sites. When the lane cannot run (plugin unavailable, Vue major mismatch, `vue` not
 *    resolvable) every `.vue` file mentioning the name is a named gap, as before;
 * 8. same-name keys of object literals with no contextual type declaring the field — not sites, but
 *    reported as `nonMatches` of kind `untyped-object-key` (`untypedKeys.ts`).
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
import { dropRepoLanguageService, type RepoLanguageService, type VueLane } from "./languageServiceHost.js";
import { findUntypedObjectKeys } from "./untypedKeys.js";
import type { VueProgram } from "./vueProgram.js";
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

/**
 * This field's references in Volar's generated code that have no source mapping, in a file where
 * every mention of the name IS covered by a mapped site: code-generation duplicates (a `v-if`
 * condition repeated inside an event handler), not missed sites. A file where some mention is not
 * covered is a gap instead, and is not listed here.
 */
export type UnmappedGenerated = { file: string; count: number; note: string };

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
  /** The Vue lane: `in-program` (Volar), `fallback` (`.vue` stays named gaps, with the reason) or absent (no `.vue`). */
  vue?: VueMeta;
};

export type VueMeta =
  | { status: "in-program"; languageCore: string; repoVersion: string | null; tsconfig: string | null; vueFiles: number; rootFiles: number; programFiles: number; cold: boolean; coldMs: number | null; unmappedGenerated: number; unmappedGeneratedFiles?: UnmappedGenerated[] }
  | { status: "fallback"; reason: string; repoVersion: string | null; vueFiles: number };

export type FieldAnswer =
  | { status: "ok"; field: string; selected: FieldCandidate; candidates: FieldCandidate[]; sites: FieldSite[]; nonMatches: FieldNonMatch[]; gaps: FieldGap[]; meta: FieldAnswerMeta }
  | { status: "ambiguous" | "pick_not_found"; field: string; candidates: FieldCandidate[]; nonMatches: FieldNonMatch[]; gaps: FieldGap[]; meta: FieldAnswerMeta }
  | { status: "no_declaration"; field: string; nonMatches: FieldNonMatch[]; gaps: FieldGap[]; meta: FieldAnswerMeta }
  | { status: "cap_breach"; field: string; breach: { kind: TsLsCapBreach["kind"]; detail: string }; meta: Pick<FieldAnswerMeta, "engine" | "cold" | "totalMs" | "rssMb" | "rootFiles"> };

type Group = {
  decls: FieldDeclaration[];
  /** Real locations of `decls` (a `.vue` declaration is mapped out of Volar's generated code). */
  declSites: { file: string; line: number }[];
  /** Owner override for a `.vue` declaration (`defineProps` renders as `__VLS_Props`). */
  ownerName?: string;
  sites: Map<string, FieldSite>;
  keys: Set<string>;
  files: Set<string>;
  gaps: FieldGap[];
};

export function findFieldReferences(svc: RepoLanguageService, field: string, pick: FieldPick = {}, caps: TsLsCaps = DEFAULT_TS_LS_CAPS): FieldAnswer {
  const budget = new AnswerBudget(caps);
  const lane = svc.vueLane();
  const cold = !svc.isBuilt || (lane.state === "ready" && !lane.program.isBuilt);
  try {
    return svc.withBudget(budget, () => answer(svc, lane, field, pick, budget, cold));
  } catch (error) {
    const breach = budget.breachFrom(error);
    if (!breach) throw error;
    if (breach.kind === "memory") dropRepoLanguageService(svc.repoId);
    return {
      status: "cap_breach",
      field,
      breach: { kind: breach.kind, detail: breach.detail },
      meta: { engine: "typescript-language-service", cold, totalMs: budget.elapsedMs(), rssMb: currentRssMb(), rootFiles: svc.rootFiles.length + (lane.state === "ready" ? lane.program.rootFiles.length : 0) }
    };
  }
}

function answer(svc: RepoLanguageService, lane: VueLane, field: string, pick: FieldPick, budget: AnswerBudget, cold: boolean): FieldAnswer {
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
      groups[existing]!.declSites.push({ file: rel(decl.sf.fileName), line: lineOf(decl.sf, decl.pos).line });
      continue;
    }
    const index = groups.length;
    const group: Group = { decls: [decl], declSites: [{ file: rel(decl.sf.fileName), line: lineOf(decl.sf, decl.pos).line }], sites: new Map(), keys: new Set([key]), files: new Set(), gaps: [] };
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

  // ── untyped same-name keys (TS/JS) ──
  const known = new Set<string>([...groupOfKey.keys(), ...groups.flatMap((g) => [...g.sites.keys()])]);
  const untyped = findUntypedObjectKeys(program, field, isRepoFile, known, () => budget.check("untyped key scan"));
  const outNonMatches: FieldNonMatch[] = [
    ...nonMatches.map((n) => ({ file: rel(n.sf.fileName), ...pickLine(lineOf(n.sf, n.pos)), kind: n.kind, container: n.container })),
    ...untyped.map((u) => ({ file: rel(u.sf.fileName), line: lineOf(u.sf, u.pos).line, kind: "untyped-object-key", container: u.container }))
  ];

  // ── the Vue lane ──
  let vueGaps: FieldGap[] = [];
  let vueMeta: VueMeta | undefined;
  if (lane.state === "fallback") {
    vueGaps = vueFileGaps(svc.repoPath, lane.vueFiles, field, lane.reason);
    vueMeta = { status: "fallback", reason: lane.reason, repoVersion: lane.repoVersion?.version ?? null, vueFiles: lane.vueFiles.length };
  } else if (lane.state === "ready") {
    const vp = lane.program;
    const vueCold = !vp.isBuilt;
    const pass = runVuePass({ vp, budget, field, groups, groupOfKey, isRepoFile, rel, vueFiles: lane.vueFiles, repoPath: svc.repoPath });
    vueGaps = pass.gaps;
    outNonMatches.push(...pass.nonMatches);
    vueMeta = {
      status: "in-program",
      languageCore: lane.ourVersion,
      repoVersion: lane.repoVersion?.version ?? null,
      tsconfig: vp.tsconfig ? rel(vp.tsconfig) : null,
      vueFiles: vp.vueRootCount,
      rootFiles: vp.rootFiles.length,
      programFiles: pass.programFiles,
      cold: vueCold,
      coldMs: vp.coldMs,
      unmappedGenerated: pass.unmappedGenerated,
      ...(pass.unmappedFiles.length > 0 && { unmappedGeneratedFiles: pass.unmappedFiles })
    };
  }

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
    rssMb: currentRssMb(),
    ...(vueMeta && { vue: vueMeta })
  };
  if (cold) svc.coldMs = totalMs;

  const candidates = groups.map((g) => toCandidate(g));
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

function toCandidate(g: Group): FieldCandidate {
  const primary = g.decls[0]!;
  const { file, line } = g.declSites[0]!;
  const aliasSites = [...g.sites.values()].filter((s) => s.kind === "DEFINITION" && !(s.file === file && s.line === line));
  const extraDecls = g.declSites.slice(1);
  const aliases = dedupe([...extraDecls, ...aliasSites.map((s) => ({ file: s.file, line: s.line }))]);
  let readCount = 0;
  let writeCount = 0;
  for (const s of g.sites.values()) {
    if (s.kind === "READ") readCount++;
    else if (s.kind === "WRITE") writeCount++;
  }
  return { id: `${file}:${String(line)}`, file, line, declarationKind: primary.kind, ownerName: g.ownerName ?? primary.ownerName, spreadInto: primary.spreadInto, aliases, readCount, writeCount };
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

// ── .vue ──

function mentionOffsets(text: string, field: string): number[] {
  const re = new RegExp(wordRegex(field).source, "g");
  const out: number[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m.index);
  return out;
}

function lineAt(text: string, offset: number): { line: number; col: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) {
    line++;
    lineStart = i + 1;
  }
  return { line, col: offset - lineStart + 1 };
}

function listLines(lines: number[]): string {
  return `${lines.slice(0, 8).join(", ")}${lines.length > 8 ? ", …" : ""}`;
}

/** Fallback: every `.vue` file mentioning the name is a named gap, saying why the Vue lane did not run. */
function vueFileGaps(repoPath: string, vueFiles: readonly string[], field: string, why: string): FieldGap[] {
  const gaps: FieldGap[] = [];
  for (const rel of vueFiles) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(repoPath, rel), "utf8");
    } catch {
      continue;
    }
    const lines = [...new Set(mentionOffsets(text, field).map((o) => lineAt(text, o).line))];
    if (lines.length > 0) {
      gaps.push({ file: rel, line: lines[0]!, reason: `.vue file mentions the name on line(s) ${listLines(lines)}; its sites are not classified: ${why}` });
    }
  }
  return gaps;
}

/** The enclosing name inside Volar's generated script; its own `__VLS_*` scaffolding reads as the SFC's script. */
function vueEnclosing(sf: ts.SourceFile, pos: number): string {
  const name = enclosingName(sf, pos);
  return name === null || name.startsWith("__VLS_") ? "<script setup>" : name;
}

type VuePassInput = {
  vp: VueProgram;
  budget: AnswerBudget;
  field: string;
  groups: Group[];
  groupOfKey: Map<string, number>;
  isRepoFile: (fileName: string) => boolean;
  rel: (fileName: string) => string;
  vueFiles: readonly string[];
  repoPath: string;
};

/**
 * The Vue program's contribution: every group re-asked there (its `.vue` sites, and TS sites the
 * union program missed), `.vue` declarations as groups of their own, the Zod parse pass, dynamic
 * access and untyped keys inside `.vue` — every generated position mapped back to the real file.
 */
function runVuePass(input: VuePassInput): { gaps: FieldGap[]; nonMatches: FieldNonMatch[]; programFiles: number; unmappedGenerated: number; unmappedFiles: UnmappedGenerated[] } {
  const { vp, budget, field, groups, groupOfKey, isRepoFile, rel } = input;
  const program = vp.program(budget);
  const caseInsensitive = !ts.sys.useCaseSensitiveFileNames;
  const canon = (f: string): string => (caseInsensitive ? f.toLowerCase() : f);
  const isVue = (f: string): boolean => /\.vue$/i.test(f) && isRepoFile(f);
  const textOf = (f: string): string => vp.sourceText(f) ?? "";
  const covered = new Map<string, Set<number>>();
  const unmapped = new Map<string, number>();
  const genKeys = new Set<string>();
  const touched = new Set<string>();
  const cover = (fileName: string, offset: number): void => {
    const k = canon(fileName);
    let set = covered.get(k);
    if (!set) covered.set(k, (set = new Set()));
    set.add(offset);
  };
  const miss = (fileName: string): void => {
    unmapped.set(canon(fileName), (unmapped.get(canon(fileName)) ?? 0) + 1);
  };
  const mapOne = (fileName: string, pos: number, length: number): { fileName: string; offset: number; line: number; col: number; block: "template" | "script" } | null => {
    const t = vp.toSource(fileName, pos, length)[0];
    if (!t) return null;
    cover(t.fileName, t.offset);
    return { fileName: t.fileName, offset: t.offset, block: t.block, ...lineAt(textOf(t.fileName), t.offset) };
  };

  const addRef = (gi: number, ref: ts.ReferencedSymbolEntry): void => {
    if (!isRepoFile(ref.fileName)) return;
    const sf = program.getSourceFile(ref.fileName);
    if (!sf) return;
    const group = groups[gi]!;
    const cls = classify(sf, ref.textSpan.start, ref.isDefinition === true);
    const genKey = siteKey(ref.fileName, ref.textSpan.start);
    if (cls.kind === "DEFINITION" && !groupOfKey.has(genKey)) groupOfKey.set(genKey, gi);
    if (!isVue(ref.fileName)) {
      // A TS file the union program also holds: same text, same position, same key — usually a duplicate.
      if (group.sites.has(genKey)) return;
      const lc = sf.getLineAndCharacterOfPosition(ref.textSpan.start);
      group.sites.set(genKey, { ...cls, notes: [...cls.notes, "found by the Vue program"], file: rel(ref.fileName), line: lc.line + 1, col: lc.character + 1, enclosingName: enclosingName(sf, ref.textSpan.start), viaParse: false });
      group.files.add(ref.fileName);
      return;
    }
    genKeys.add(genKey);
    touched.add(ref.fileName);
    const targets = vp.toSource(ref.fileName, ref.textSpan.start, ref.textSpan.length);
    if (targets.length === 0) {
      miss(ref.fileName);
      return;
    }
    for (const t of targets) {
      cover(t.fileName, t.offset);
      const key = `${siteKey(t.fileName, t.offset)}:vue`;
      if (group.sites.has(key)) continue;
      const { line, col } = lineAt(textOf(t.fileName), t.offset);
      group.sites.set(key, {
        ...cls,
        how: t.block === "template" ? `${cls.how} (template)` : cls.how,
        notes: [...cls.notes, `vue ${t.block}`],
        file: rel(t.fileName),
        line,
        col,
        enclosingName: t.block === "template" ? "<template>" : vueEnclosing(sf, ref.textSpan.start),
        viaParse: false
      });
    }
  };

  // 1. Every TS group, re-asked in the Vue program (when its declaration is reachable from it).
  const tsGroupCount = groups.length;
  for (let gi = 0; gi < tsGroupCount; gi++) {
    const decl = groups[gi]!.decls[0]!;
    if (!program.getSourceFile(decl.sf.fileName)) continue;
    const referenced = vp.ls.findReferences(decl.sf.fileName, decl.pos) ?? [];
    budget.check("vue findReferences");
    for (const symbol of referenced) for (const ref of symbol.references) addRef(gi, ref);
  }

  // 2. Declarations inside `.vue` (a `defineProps<{ f: … }>()` prop, an SFC-local interface).
  const nonMatches: FieldNonMatch[] = [];
  const vueDecls = collectFieldDeclarations(vp.ls, program, field, isVue);
  budget.check("vue declaration scan");
  for (const n of vueDecls.nonMatches) {
    const at = mapOne(n.sf.fileName, n.pos, field.length);
    if (at) nonMatches.push({ file: rel(at.fileName), line: at.line, kind: n.kind, container: n.container });
  }
  for (const decl of vueDecls.declarations) {
    const key = siteKey(decl.sf.fileName, decl.pos);
    const at = mapOne(decl.sf.fileName, decl.pos, field.length);
    if (!at) continue; // generated-only
    const where = { file: rel(at.fileName), line: at.line };
    const existing = groupOfKey.get(key);
    if (existing !== undefined) {
      const g = groups[existing]!;
      if (!g.declSites.some((d) => d.file === where.file && d.line === where.line)) {
        g.decls.push(decl);
        g.declSites.push(where);
      }
      continue;
    }
    const gi = groups.length;
    const ownerName = decl.ownerName.startsWith("__VLS_") ? `${path.basename(at.fileName)} props` : decl.ownerName;
    groups.push({ decls: [decl], declSites: [where], ownerName, sites: new Map(), keys: new Set([key]), files: new Set(), gaps: [] });
    groupOfKey.set(key, gi);
    const referenced = vp.ls.findReferences(decl.sf.fileName, decl.pos) ?? [];
    budget.check("vue findReferences");
    for (const symbol of referenced) for (const ref of symbol.references) addRef(gi, ref);
  }

  // 3. `X.parse({...})` inside `.vue`.
  const parse = runZodParsePass(program, field, groupOfKey, isVue, () => budget.check("vue zod parse pass"));
  for (const w of parse.writes) {
    genKeys.add(siteKey(w.sf.fileName, w.pos));
    const at = mapOne(w.sf.fileName, w.pos, field.length);
    if (!at) {
      miss(w.sf.fileName);
      continue;
    }
    const group = groups[w.groupIndex]!;
    const key = `${siteKey(at.fileName, at.offset)}:vue`;
    if (group.sites.has(key)) continue;
    group.sites.set(key, { kind: "WRITE", how: w.how, notes: [`schema: ${w.schemaExpression}`, `vue ${at.block}`], file: rel(at.fileName), line: at.line, col: at.col, enclosingName: at.block === "template" ? "<template>" : vueEnclosing(w.sf, w.pos), viaParse: true });
  }
  for (const g of parse.gaps) {
    const at = mapOne(g.sf.fileName, g.pos, 1);
    groups[g.groupIndex]!.gaps.push({ file: rel(at?.fileName ?? g.sf.fileName), line: at?.line ?? null, reason: g.reason });
  }

  // 4. Dynamic `obj[key]` inside `.vue` files that reference a group; unmapped ones are codegen.
  for (const g of findDynamicAccessGaps(program, touched, field, groupOfKey)) {
    const at = mapOne(g.sf.fileName, g.pos, 1);
    if (at) groups[g.groupIndex]!.gaps.push({ file: rel(at.fileName), line: at.line, reason: g.reason });
  }
  budget.check("vue gap scan");

  // 5. Untyped same-name keys inside `.vue`.
  const known = new Set<string>([...genKeys, ...groupOfKey.keys()]);
  for (const u of findUntypedObjectKeys(program, field, isVue, known, () => budget.check("vue untyped key scan"))) {
    const at = mapOne(u.sf.fileName, u.pos, field.length);
    if (at) nonMatches.push({ file: rel(at.fileName), line: at.line, kind: "untyped-object-key", container: at.block === "template" ? "<template>" : u.container });
  }

  // 6. Gaps: a `.vue` mentioning the name that is not in the program, and an unmapped generated hit
  //    in a file where some mention is accounted for by no mapped site.
  const gaps: FieldGap[] = [];
  const root = input.repoPath.replace(/\\/g, "/").replace(/\/$/, "");
  let unmappedGenerated = 0;
  const unmappedFiles: UnmappedGenerated[] = [];
  for (const relVue of input.vueFiles) {
    const abs = `${root}/${relVue.replace(/\\/g, "/")}`;
    const text = vp.sourceText(abs);
    if (!text) continue;
    const mentions = mentionOffsets(text, field);
    if (mentions.length === 0) continue;
    if (!program.getSourceFile(abs)) {
      gaps.push({ file: relVue, line: lineAt(text, mentions[0]!).line, reason: ".vue file mentions the name but is not in the Vue program (Volar generated no TypeScript for it), so its sites are not classified" });
      continue;
    }
    const count = unmapped.get(canon(abs)) ?? 0;
    unmappedGenerated += count;
    if (count === 0) continue;
    const seen = covered.get(canon(abs)) ?? new Set<number>();
    const lines = [...new Set(mentions.filter((o) => !seen.has(o)).map((o) => lineAt(text, o).line))];
    if (lines.length === 0) {
      unmappedFiles.push({ file: relVue, count, note: "every mention of the name in this file is covered by a mapped site, so the unmapped reference(s) are code-generation duplicates, not missed sites" });
    } else {
      gaps.push({ file: relVue, line: lines[0]!, reason: `${String(count)} reference(s) in Volar's generated code for this file have no source mapping, and the name on line(s) ${listLines(lines)} is not accounted for by a mapped site` });
    }
  }
  return { gaps, nonMatches, programFiles: program.getSourceFiles().length, unmappedGenerated, unmappedFiles };
}
