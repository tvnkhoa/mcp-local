import fs from "node:fs";

import type { GraphStore } from "../store/graphStore.js";
import { assertSafeRepoFilePath, escapeRegExp } from "../refactor/refactorUtils.js";

/**
 * ENH-029-E — cross-repo value/literal contract lane (`get_value_contract_impact`).
 *
 * A storage-format migration (e.g. `conversations.status` int `5` → string `"resolved"`) is gated
 * not by a code symbol but by the **stored/wire value**: who across all repos reads or writes that
 * token. `get_cross_repo_impact` is symbol-oriented and can't answer this. This fans `search_literals`
 * across every registered repo, keeps exact-value hits, and classifies each as producer / consumer
 * (where inferable from the surrounding line) so a data-contract change can be reviewed repo by repo.
 */

export type ValueContractRole = "producer" | "consumer" | "unknown";

export type ValueContractHit = {
  filePath: string;
  line: number;
  role: ValueContractRole;
  enclosingSymbol: { symbolId: string; name: string; kind: string } | null;
  lineText: string | null;
};

export type ValueContractRepoGroup = {
  repoId: string;
  total: number;
  producers: number;
  consumers: number;
  unknown: number;
  hits: ValueContractHit[];
};

export type ValueContractResult = {
  value: string;
  column: string | null;
  reposScanned: number;
  totalHits: number;
  groups: ValueContractRepoGroup[];
};

const PER_REPO_LIMIT = 500;

/**
 * Classify a literal occurrence as producing (assigned/written) or consuming (compared/read) the value.
 * Heuristic over the source line: a single `=` assignment (or SQL INSERT/SET) writes; `==`/`!=`/`WHERE`/
 * `case`/`.Equals(` reads. When a `column` is given, an assignment to that column strengthens "producer".
 */
function classifyRole(lineText: string | null, value: string, column: string | null): ValueContractRole {
  if (!lineText) return "unknown";
  const line = lineText;
  const v = escapeRegExp(value);
  const quoted = new RegExp(`["'\`]${v}["'\`]`);

  // Consumer signals first — comparison/branch contexts are unambiguous reads.
  if (new RegExp(`==\\s*["'\`]${v}|["'\`]${v}["'\`]\\s*==|!=\\s*["'\`]${v}`).test(line)) return "consumer";
  if (/\bcase\b/.test(line) && quoted.test(line)) return "consumer";
  if (/\.Equals\s*\(/.test(line) && quoted.test(line)) return "consumer";
  if (/\bWHERE\b/i.test(line) && quoted.test(line)) return "consumer";

  // Producer signals — a single-`=` assignment, or SQL INSERT/SET writing the value.
  if (column) {
    if (new RegExp(`\\b${escapeRegExp(column)}\\b\\s*=(?!=)`).test(line) && quoted.test(line)) return "producer";
    if (/\b(INSERT|VALUES|SET)\b/i.test(line) && quoted.test(line)) return "producer";
  }
  if (new RegExp(`=(?!=)\\s*["'\`]${v}["'\`]`).test(line)) return "producer";
  if (/\breturn\b/.test(line) && quoted.test(line)) return "producer";

  return "unknown";
}

function readLine(repoPath: string, filePath: string, line: number): string | null {
  try {
    const abs = assertSafeRepoFilePath(repoPath, filePath);
    if (!fs.existsSync(abs)) return null;
    const content = fs.readFileSync(abs, "utf8");
    const lines = content.split(/\r?\n/);
    return (lines[line - 1] ?? "").trim() || null;
  } catch {
    return null;
  }
}

/** Trace a storage/wire value across every registered repo, grouped and producer/consumer-classified. */
export function getValueContractImpact(
  store: GraphStore,
  args: { value: string; column?: string; repoIds?: string[] }
): ValueContractResult {
  const value = args.value;
  const column = args.column ?? null;
  const allRepos = store.listRepositories();
  const repos = args.repoIds && args.repoIds.length > 0
    ? allRepos.filter((r) => args.repoIds!.includes(r.repoId))
    : allRepos;

  const groups: ValueContractRepoGroup[] = [];
  let totalHits = 0;

  for (const repo of repos) {
    const rawHits = store.searchLiterals(repo.repoId, value, PER_REPO_LIMIT, null)
      .filter((h) => h.value === value); // exact token only — the contract is the literal itself

    if (rawHits.length === 0) continue;

    const hits: ValueContractHit[] = rawHits.map((h) => {
      const lineText = readLine(repo.repoPath, h.filePath, h.line);
      return {
        filePath: h.filePath,
        line: h.line,
        role: classifyRole(lineText, value, column),
        enclosingSymbol: h.enclosingSymbol,
        lineText
      };
    });
    hits.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line);

    groups.push({
      repoId: repo.repoId,
      total: hits.length,
      producers: hits.filter((h) => h.role === "producer").length,
      consumers: hits.filter((h) => h.role === "consumer").length,
      unknown: hits.filter((h) => h.role === "unknown").length,
      hits
    });
    totalHits += hits.length;
  }

  groups.sort((a, b) => b.total - a.total || a.repoId.localeCompare(b.repoId));

  return { value, column, reposScanned: repos.length, totalHits, groups };
}
