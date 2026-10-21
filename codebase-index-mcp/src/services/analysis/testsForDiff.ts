/**
 * R11 (wec.aria release G): "which tests does my working-tree diff need, and how do I run them".
 *
 *   dirty files (staged + unstaged + untracked, the same `git status` read the R1 freshness gate uses)
 *     → reverse closure over IMPORTS + USES_COMPONENT + workspace-package imports (bounded depth and
 *       file count; truncation reported)
 *     → the test files reached, every dirty test file itself, and name/score links >= minScore
 *     → per package: the vitest config that would run them, and one command line. Nothing runs.
 *
 * Every test carries `why`. Two rules from the wec.aria acceptance review are load-bearing:
 *   - a CHANGED test file is itself a test to run ("changed itself"), never "no linked test";
 *   - a name/score link under `minScore` is dropped, not listed, and counted in `belowMinScore`.
 */

import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { isTestPath } from "../indexing/fileFilter.js";
import { loadReverseFileGraph, type ReverseEdge } from "./testDiffGraph.js";
import { planTestRuns, type PlanFs, type RunGroup } from "./testRunPlan.js";

export type TestLink = { testFile: string; sourceFile: string; score: number; reasons: string[] };

export type TestsForDiffOptions = {
  db: Database.Database;
  repoId: string;
  repoPath: string;
  /** Repo-relative dirty paths (already re-rooted to `repoPath`). */
  dirty: readonly string[];
  maxDepth: number;
  maxFiles: number;
  minScore: number;
  limit: number;
  /** Name/score links for one source file, with NO score floor (this module applies minScore). */
  linkTests: (sourceFile: string) => TestLink[];
};

export type DiffTest = {
  testFile: string;
  why: string[];
  /** Hops from the nearest changed file; 0 = changed itself, absent = name link only. */
  depth?: number;
  chain?: string[];
  runner?: "vitest" | "unknown";
  package?: string | null;
  hint?: string;
  excludedReason?: string;
  deleted?: boolean;
};

/** Runnable test files: the `isTestPath` set minus helpers that merely live in a test folder. */
export function isRunnableTestFile(p: string): boolean {
  return isTestPath(p) && /(\.(test|spec)\.[^/]+$)|((^|\/)test_[^/]+\.py$)|(_test\.py$)|(Tests\.cs$)/i.test(p);
}

const NON_CODE = /\.(md|markdown|mdx|txt|rst|adoc|json|ya?ml|xml|csv|lock|ini|toml|cfg|conf|svg|png|jpe?g|gif|ico)$/i;
const NAME_LINK_PROBE_CAP = 50;

/**
 * The name an import would use for a file: its stem, or its folder for an `index` file
 * (`audit/index.ts` is imported as `./audit`). Used only to NAME gaps, never to add a test.
 */
export function importKeyOf(p: string): string {
  const parts = p.replace(/[?#].*$/, "").split("/").filter((x) => x && x !== "." && x !== "..");
  const stem = (parts.pop() ?? "").replace(/\.[^.]+$/, "");
  return stem === "index" ? (parts.pop() ?? "") : stem;
}

function edgeWhy(e: ReverseEdge, target: string): string {
  if (e.kind === "component") return `renders ${target} (USES_COMPONENT)`;
  if (e.kind === "workspace") {
    return e.packageLevel
      ? `imports workspace package '${e.specifier ?? ""}', which contains ${target} (package-level: no exports entry for that subpath)`
      : `imports ${target} via workspace package specifier '${e.specifier ?? ""}'`;
  }
  return `imports ${target}`;
}

export function computeTestsForDiff(opts: TestsForDiffOptions) {
  const started = Date.now();
  const graph = loadReverseFileGraph(opts.db, opts.repoId, opts.repoPath);
  const onDisk = (rel: string) => {
    try {
      return fs.statSync(path.join(opts.repoPath, rel)).isFile();
    } catch {
      return false;
    }
  };

  const dirty = [...new Set(opts.dirty)].sort();
  const deleted = dirty.filter((f) => !onDisk(f));
  const notIndexed = dirty.filter((f) => !graph.indexedFiles.has(f) && onDisk(f));

  // Nearest workspace package dir for a file (package-level edges hang off it).
  const pkgDirs = graph.packages.map((p) => p.dir).sort((a, b) => b.length - a.length);
  const packageDirOf = (f: string) => pkgDirs.find((d) => d === "" || f.startsWith(`${d}/`)) ?? null;

  // ── reverse closure (BFS: the first, shortest path to each file wins) ──
  type Visit = { depth: number; parent: string | null; edge: ReverseEdge | null; seed: string };
  const visited = new Map<string, Visit>();
  for (const f of dirty) visited.set(f, { depth: 0, parent: null, edge: null, seed: f });
  let frontier = [...dirty];
  let truncationReason: string | null = null;
  let fileCapHit = false;
  let packageLevelUsed = 0;
  const importersOf = (f: string): ReverseEdge[] => {
    const pd = packageDirOf(f);
    return [...(graph.reverse.get(f) ?? []), ...(pd !== null ? graph.packageImporters.get(pd) ?? [] : [])];
  };
  for (let depth = 1; depth <= opts.maxDepth && frontier.length > 0 && !truncationReason; depth++) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const e of importersOf(f)) {
        if (visited.has(e.importer)) continue;
        if (visited.size >= opts.maxFiles) {
          truncationReason = `file cap ${String(opts.maxFiles)} reached at depth ${String(depth)}`;
          fileCapHit = true;
          break;
        }
        if (e.packageLevel) packageLevelUsed++;
        visited.set(e.importer, { depth, parent: f, edge: e, seed: visited.get(f)!.seed });
        next.push(e.importer);
      }
      if (truncationReason) break;
    }
    frontier = next;
  }
  // Depth cap: name the files one hop further that were not walked (a named gap, not a silent stop).
  const unwalked = new Set<string>();
  if (!truncationReason) for (const f of frontier) for (const e of importersOf(f)) if (!visited.has(e.importer)) unwalked.add(e.importer);
  if (unwalked.size > 0) {
    const names = [...unwalked].sort();
    truncationReason = `depth cap ${String(opts.maxDepth)} reached; ${String(names.length)} file(s) one hop further were not walked: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""}`;
  }

  const tests = new Map<string, DiffTest>();
  const chainOf = (f: string): string[] => {
    const out: string[] = [];
    let cur = visited.get(f);
    let at = f;
    while (cur && cur.parent) {
      out.push(cur.parent);
      at = cur.parent;
      cur = visited.get(at);
    }
    return out;
  };
  let supportFilesReached = 0;
  for (const [f, v] of visited) {
    if (!isTestPath(f)) continue;
    if (!isRunnableTestFile(f)) {
      if (v.depth > 0) supportFilesReached++;
      continue;
    }
    if (v.depth === 0) {
      tests.set(f, { testFile: f, why: ["changed itself"], depth: 0, ...(deleted.includes(f) ? { deleted: true } : {}) });
      continue;
    }
    const chain = chainOf(f); // [parent, ..., seed]
    const seed = chain[chain.length - 1]!;
    const lastHop = visited.get(chain.length > 1 ? chain[chain.length - 2]! : f)!;
    const why = chain.length === 1
      ? edgeWhy(v.edge!, seed)
      : `reaches changed ${seed} via ${chain.slice(0, -1).join(" → ")} (last hop: ${edgeWhy(lastHop.edge!, seed)})`;
    tests.set(f, { testFile: f, why: [why], depth: v.depth, chain });
  }

  // ── name/score links, floor applied HERE (reviewer: a 0.076 suggestion must not be listed) ──
  const probes = dirty.filter((f) => !isTestPath(f) && !NON_CODE.test(f) && graph.indexedFiles.has(f)).slice(0, NAME_LINK_PROBE_CAP);
  const below = new Map<string, number>();
  for (const src of probes) {
    for (const link of opts.linkTests(src)) {
      if (link.sourceFile !== src) continue;
      if (link.score >= opts.minScore) {
        const why = `name link score ${String(link.score)} to ${src} (${link.reasons.join(", ")})`;
        const t = tests.get(link.testFile);
        if (t) t.why.push(why);
        else tests.set(link.testFile, { testFile: link.testFile, why: [why] });
      } else {
        const k = `${link.testFile}\u0000${src}`;
        below.set(k, Math.max(below.get(k) ?? 0, link.score));
      }
    }
  }
  const belowMinScore = [...below.keys()].filter((k) => !tests.has(k.split("\u0000")[0]!)).length;

  // ── run plan (lexical; nothing executes) ──
  const planFs: PlanFs = {
    exists: (rel) => {
      try {
        return fs.existsSync(path.join(opts.repoPath, rel));
      } catch {
        return false;
      }
    },
    read: (rel) => {
      try {
        return fs.readFileSync(path.join(opts.repoPath, rel), "utf8");
      } catch {
        return null;
      }
    }
  };
  const runnable = [...tests.values()].filter((t) => !t.deleted).map((t) => t.testFile);
  const plan = planTestRuns(runnable, planFs);
  const groupOf = new Map<string, RunGroup>();
  for (const g of plan.groups) for (const f of g.files) groupOf.set(g.root ? `${g.root}/${f}` : f, g);
  for (const t of tests.values()) {
    const g = groupOf.get(t.testFile);
    if (g) {
      t.runner = "vitest";
      t.package = g.package;
      continue;
    }
    const ex = plan.excluded.find((x) => x.testFile === t.testFile);
    if (ex) {
      t.runner = "vitest";
      t.excludedReason = ex.reason;
      continue;
    }
    const o = plan.other.find((x) => x.testFile === t.testFile);
    if (o) {
      t.runner = "unknown";
      if (o.package !== undefined) t.package = o.package;
      if (o.hint) t.hint = o.hint;
    }
  }

  const rank = (t: DiffTest) => (t.depth === 0 ? 0 : t.depth !== undefined ? t.depth : 100);
  const allTests = [...tests.values()].sort((a, b) => rank(a) - rank(b) || a.testFile.localeCompare(b.testFile));
  const listed = allTests.slice(0, opts.limit);

  // ── coverage: anything not seen is a named gap ──
  const knownGaps: string[] = [];
  if (truncationReason) knownGaps.push(`closure truncated: ${truncationReason}`);
  if (graph.edgeRowsCapped) knownGaps.push("edge read capped; the reverse graph is partial");
  const notIndexedCode = notIndexed.filter((f) => !NON_CODE.test(f));
  if (notIndexedCode.length > 0) knownGaps.push(`changed file(s) not in the index, so nothing reaching them can be seen: ${notIndexedCode.slice(0, 10).join(", ")}`);
  const changedKeys = new Map<string, string>();
  for (const f of dirty) if (!NON_CODE.test(f) && importKeyOf(f)) changedKeys.set(importKeyOf(f), f);
  const suspicious = graph.unresolvedSpecifiers.filter((u) => {
    const k = importKeyOf(u.specifier);
    return !u.specifier.includes("*") && changedKeys.has(k) && !visited.has(u.importer) && !NON_CODE.test(u.importer);
  });
  for (const u of suspicious.slice(0, 10)) {
    knownGaps.push(`${u.importer} has an unresolved import '${u.specifier}' that may name changed ${changedKeys.get(importKeyOf(u.specifier))}`);
  }
  if (suspicious.length > 10) knownGaps.push(`${String(suspicious.length - 10)} more unresolved import(s) may name a changed file`);
  if (packageLevelUsed > 0) knownGaps.push(`${String(packageLevelUsed)} file(s) reached through a package-level workspace import (no exports entry for the subpath): over-reported, not missed`);
  for (const c of plan.configs) if (c.status === "unreadable") knownGaps.push(`${c.configFile} not statically readable: ${c.unreadable.join("; ")}`);
  // A file-cap stop can hide whole packages: low. A depth stop names what it did not walk: medium.
  const confidence: "high" | "medium" | "low" = fileCapHit || graph.edgeRowsCapped ? "low" : knownGaps.length > 0 ? "medium" : "high";

  return {
    changedFiles: {
      count: dirty.length,
      files: dirty.slice(0, 100),
      ...(dirty.length > 100 ? { filesTruncatedAt: 100 } : {}),
      ...(deleted.length > 0 ? { deleted } : {}),
      ...(notIndexed.length > 0 ? { notIndexed: notIndexed.slice(0, 50) } : {})
    },
    testCount: allTests.length,
    tests: listed,
    ...(allTests.length > listed.length ? { testsTruncatedAt: opts.limit } : {}),
    runPlan: {
      packageManager: plan.packageManager,
      commands: plan.groups.map((g) => ({
        package: g.package,
        packageDir: g.packageDir || ".",
        configFile: g.configFile,
        configStatus: g.configStatus,
        root: g.root || ".",
        include: g.include,
        ...(g.exclude.length > 0 ? { exclude: g.exclude } : {}),
        files: g.files,
        ...(g.projectsByFile ? { projectsByFile: g.projectsByFile } : {}),
        command: g.command,
        ...(g.notes.length > 0 ? { notes: g.notes } : {})
      }))
    },
    excluded: plan.excluded,
    minScore: opts.minScore,
    belowMinScore,
    closure: {
      maxDepth: opts.maxDepth,
      maxFiles: opts.maxFiles,
      filesReached: visited.size - dirty.length,
      supportFilesReached,
      truncated: truncationReason !== null,
      ...(truncationReason ? { truncationReason } : {}),
      edgeKinds: ["IMPORTS", "USES_COMPONENT", "workspace-package import"],
      workspacePackages: graph.packages.length
    },
    coverage: { confidence, knownGaps, suggestFallback: confidence === "high" ? null : "run the package's whole suite for the files named in knownGaps" },
    note: "Nothing was executed: the commands are for you to run.",
    timingMs: Date.now() - started
  };
}
