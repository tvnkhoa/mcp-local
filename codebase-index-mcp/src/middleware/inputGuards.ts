/**
 * MCP-ISSUE-060 — "I found nothing" and "you asked me something meaningless" are different answers.
 *
 * Measured, before this existed:
 *
 * - `get_call_chain(repoId:"totally-bogus-repo-id-xyz", symbolId:<a real id from another repo>)`
 *   returned `{"edges":[],"coverage":{"confidence":"high",...}}`.
 * - `find_impact_files(filePath:"src/does/not/exist.ts")` returned `totalImpactedCount: 0` with
 *   `graphHealth.note: "graph data complete"` and `reliabilitySummary.medianConfidence: 1`.
 * - `query_graph` against an unknown repoId returned a clean `{"rowCount":1,"rows":[{"c":0}]}` — and
 *   `query_graph` is the tool an agent reaches for to VERIFY the others.
 * - `find_symbol_at_line` for a path that is not in the index returned an object with no `symbol`
 *   key, no error and no hint, because the formatter drops null fields.
 *
 * Asserting *confidence* on a structurally impossible question is worse than returning nothing:
 * silence invites another attempt, "high" tells the agent to stop looking.
 *
 * Seven handlers had already grown their own copy of the repo check
 * (`searchHandler`, `indexHandler`, `bundleHandler`, `refactorPreviewHandlers`, `resourceHandler`);
 * this is that idiom, named once, so the ~20 handlers that lacked it can adopt it without inventing
 * a twentieth message format.
 */

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

/** The slice of `GraphStore` these guards need — kept structural so unit tests can pass a stub. */
export type RepoLookup = {
  getRepository: (repoId: string) => { repoId: string; repoPath: string } | null | undefined;
};

/** The slice needed to tell "file absent from the index" from "file genuinely has no symbols". */
export type FileLookup = {
  isFileIndexed: (repoId: string, filePath: string) => boolean;
};

/**
 * Throw `InvalidParams` when `repoId` names no indexed repository.
 *
 * The message is the one the existing hand-rolled copies already used, so nothing an agent has
 * learned to recognise changes.
 */
export function assertRepoIndexed(store: RepoLookup, repoId: string, toolName: string): void {
  if (!store.getRepository(repoId)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${toolName}: unknown repoId '${repoId}'. Run list_repositories to see the indexed repos, or index_repository first.`
    );
  }
}

/**
 * A file the index has never seen is reported, not silently answered as empty.
 *
 * Deliberately NOT an error. Asking about a file that exists on disk but postdates the last index
 * run is an ordinary thing to do — a whole 29-file server was added to this workspace after its last
 * index and every tool answered `{}` for it. The caller needs the distinction, not a refusal.
 */
export function fileIndexedNote(
  store: FileLookup,
  repoId: string,
  filePath: string
): { fileIndexed: false; fileNotIndexedNote: string } | Record<string, never> {
  if (store.isFileIndexed(repoId, filePath)) return {};
  return {
    fileIndexed: false,
    fileNotIndexedNote:
      "this path has no rows in the index, so an empty result here means 'not indexed', not 'no dependents'. Re-index if the file was added or renamed since the last run; check the path spelling otherwise."
  };
}

/**
 * Tools for which an unknown `repoId` is a legitimate input rather than a mistake.
 *
 * `index_repository` is the one that REGISTERS a repo, so its repoId cannot exist yet.
 * `health_check` is explicitly designed to answer for an unregistered repo — that is how an agent
 * discovers it needs to index. `watch_repo` may start before the first run completes.
 */
const REPO_ID_MAY_BE_UNKNOWN = new Set(["index_repository", "health_check", "watch_repo"]);

/**
 * MCP-ISSUE-060: one repoId check, at the seam every tool call passes through.
 *
 * Deliberately central rather than copied into each handler. Seven handlers had already grown their
 * own copy and roughly twenty had not, which is exactly the drift a per-handler convention produces:
 * the tools that skipped it are not the ones anyone chose to skip. Putting it in `wrapCall` — the
 * place `createServer`'s own doc comment calls "the only place a server-wide pre- or post-dispatch
 * policy can live" — also means a tool added next year inherits it without anyone remembering to.
 *
 * An ABSENT repoId is left alone: several tools legitimately search across every indexed repo.
 */
export function assertRepoIdResolves(
  toolName: string,
  args: Record<string, unknown>,
  store: RepoLookup
): void {
  if (REPO_ID_MAY_BE_UNKNOWN.has(toolName)) return;
  const repoId = args.repoId;
  if (typeof repoId !== "string" || repoId.length === 0) return;
  assertRepoIndexed(store, repoId, toolName);
}
