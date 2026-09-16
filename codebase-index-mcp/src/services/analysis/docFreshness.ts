/**
 * docFreshness.ts — "this document is older than the code it describes".
 *
 * MCP-ISSUE-061 Stage 3. `query_docs{ mode:"stale" }` answers a different question: *which documents
 * mention these symbols*, for a set of symbols the caller already knows changed. That requires
 * knowing what changed. This answers the question you actually start with — **which of my documents
 * have fallen behind** — and it answers it from git rather than from a heuristic.
 *
 * The comparison is per file: the last commit that touched the document, against the latest commit
 * touching any file that defines a symbol the document mentions. A document committed before the code
 * it describes is not proof of staleness — a typo fix bumps a source file without invalidating its
 * prose — which is why the output reports the gap and names the evidence instead of asserting a
 * verdict. It is a review queue, ordered by how far behind.
 *
 * NO-LLM CONSTRAINT: git plumbing, a SQL join and integer arithmetic. No model, no network.
 *
 * Cost note: the naive shape is one `git log -1` per file, which is hundreds of process spawns on a
 * real repo. One `git log --name-only` walk over the whole history builds the same map in a single
 * spawn, because the FIRST time a path appears walking newest-first IS its last commit.
 */

import { runGit } from "../git/gitHelpers.js";
import type { GraphStore } from "../../repositories/graphStore.js";

export type DocBehindRow = {
  filePath: string;
  docCommittedAt: string;
  codeCommittedAt: string;
  daysBehind: number;
  /** The mentioned symbols whose files are newer than the document, newest first. */
  newerCode: { symbolName: string; filePath: string; committedAt: string }[];
};

/**
 * path → unix seconds of the most recent commit touching it. Forward-slashed, as git reports.
 *
 * `--no-renames` keeps a path's history attached to its current name: with rename detection on, git
 * reports the OLD path for the commit that moved a file, so a recently renamed file would look
 * untouched for as long as its old name had been quiet.
 */
export function lastCommitTimeByFile(repoPath: string): Map<string, number> {
  const out = new Map<string, number>();

  /**
   * A registered repo can be a SUBDIRECTORY of the git working tree — `codebase-index-mcp` is,
   * inside `mcp-local`. `git log` always reports paths from the repository root, while
   * `docs.file_path` is relative to the registered root, so without this the two never match and the
   * report came back `docsCompared: 0` for that repo while working fine for its parent. Stripping
   * the prefix makes both repoIds answer.
   */
  let prefix = "";
  try {
    prefix = runGit(repoPath, ["rev-parse", "--show-prefix"]).trim();
  } catch {
    return out; // not a git working tree
  }

  let raw: string;
  try {
    // 30s, not the 5s default: this is an on-demand report, and the walk is O(history).
    raw = runGit(repoPath, ["log", "--no-renames", "--pretty=format:@%ct", "--name-only"], 30_000);
  } catch {
    return out;
  }

  let currentTime = 0;
  for (const line of raw.split("\n")) {
    if (line.startsWith("@")) {
      currentTime = Number.parseInt(line.slice(1), 10) || 0;
      continue;
    }
    const gitPath = line.trim();
    if (gitPath === "" || currentTime === 0) continue;
    if (prefix !== "" && !gitPath.startsWith(prefix)) continue; // outside the registered root
    const path = prefix === "" ? gitPath : gitPath.slice(prefix.length);
    // Newest-first, so the first sighting wins and later (older) ones are ignored.
    if (!out.has(path)) out.set(path, currentTime);
  }
  return out;
}

const DAY_SECONDS = 86_400;
const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

export function findDocsBehindCode(
  store: GraphStore,
  repoId: string,
  options: { minDaysBehind?: number; limit?: number } = {}
): { rows: DocBehindRow[]; total: number; filesCompared: number; note?: string } {
  const minDaysBehind = options.minDaysBehind ?? 1;
  const limit = Math.max(1, options.limit ?? 50);

  const repo = store.getRepository(repoId);
  if (!repo) return { rows: [], total: 0, filesCompared: 0, note: `unknown repoId '${repoId}'` };

  const commitTimes = lastCommitTimeByFile(repo.repoPath);
  if (commitTimes.size === 0) {
    return {
      rows: [],
      total: 0,
      filesCompared: 0,
      note: "could not read git history for this repo path — it is not a git working tree, or the history walk exceeded its 30s budget. This is not a statement that the docs are fresh."
    };
  }

  const norm = (p: string) => p.replace(/\\/g, "/");
  const pairs = store.listDocMentionTargets(repoId);

  // doc file → the newest mentioned code files
  const byDoc = new Map<string, { symbolName: string; filePath: string; committedAt: number }[]>();
  for (const pair of pairs) {
    const codeTime = commitTimes.get(norm(pair.symbolFilePath));
    if (codeTime === undefined) continue; // untracked or never committed
    const bucket = byDoc.get(norm(pair.docFilePath));
    const entry = { symbolName: pair.symbolName, filePath: norm(pair.symbolFilePath), committedAt: codeTime };
    if (bucket) bucket.push(entry);
    else byDoc.set(norm(pair.docFilePath), [entry]);
  }

  const rows: DocBehindRow[] = [];
  for (const [docPath, code] of byDoc) {
    const docTime = commitTimes.get(docPath);
    if (docTime === undefined) continue;

    const newer = code
      .filter((c) => c.committedAt > docTime)
      .sort((a, b) => b.committedAt - a.committedAt);
    if (newer.length === 0) continue;

    const daysBehind = Math.floor((newer[0].committedAt - docTime) / DAY_SECONDS);
    if (daysBehind < minDaysBehind) continue;

    rows.push({
      filePath: docPath,
      docCommittedAt: iso(docTime),
      codeCommittedAt: iso(newer[0].committedAt),
      daysBehind,
      // Deduplicated by code file: ten symbols in one file is one reason to look, not ten.
      newerCode: [...new Map(newer.map((c) => [c.filePath, c])).values()]
        .slice(0, 5)
        .map((c) => ({ symbolName: c.symbolName, filePath: c.filePath, committedAt: iso(c.committedAt) }))
    });
  }

  rows.sort((a, b) => b.daysBehind - a.daysBehind);
  return { rows: rows.slice(0, limit), total: rows.length, filesCompared: byDoc.size };
}
