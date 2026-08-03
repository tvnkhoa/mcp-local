/**
 * The watch lifecycle: activating a watcher for a repo, the idle TTL that stops
 * it again, and the two paths that trigger activation — boot auto-start and
 * per-tool-call auto-activation.
 *
 * Before S-27 this existed **twice**. `index.ts` and `tools/handlers/indexHandler.ts`
 * each carried their own `activateWatchForRepo` / `armWatchInactivityTimer` /
 * `clearWatchInactivityTimer`, and which pair ran depended on how the watcher was
 * triggered: the `watch_repo` tool went through the handler's copy, while boot
 * auto-start and per-call auto-activation went through the entry point's. The two
 * had not drifted — verified line by line before the merge — but they shared
 * mutable state (`activeWatchRef`, `watchInactivityTimers`) while being separately
 * editable, which is the setup where a fix applied to one path silently does not
 * apply to the other.
 *
 * Dependencies arrive through a context object rather than module state, so the
 * same functions serve both callers. {@link WatchContext} is deliberately
 * structural: `HandlerContext` satisfies it without this module importing from
 * `tools/handlers/`.
 */

import process from "node:process";

import { assertPathAllowed } from "../../middleware/indexGuardrails.js";
import type { GraphStore } from "../../repositories/graphStore.js";
import type { WatchManager } from "./watchManager.js";

export interface WatchTarget {
  repoId: string;
  repoPath: string;
}

/** What activating and expiring a watcher needs. `HandlerContext` satisfies this. */
export interface WatchContext {
  readonly watchManager: WatchManager;
  /** Which repo currently holds the single active watcher, under WATCH_ACTIVE_ONLY. */
  readonly activeWatchRef: { current: string | null };
  readonly watchInactivityTimers: Map<string, NodeJS.Timeout>;
  readonly constants: {
    readonly WATCH_ACTIVE_ONLY: boolean;
    readonly WATCH_ACTIVE_TTL_MS: number;
    readonly allowedRoots: string[];
  };
}

/** Additionally what *deciding whether to* activate needs. */
export interface WatchBootstrapContext extends WatchContext {
  readonly store: GraphStore;
  readonly constants: WatchContext["constants"] & { readonly WATCH_AUTO_START: boolean };
}

export function clearWatchInactivityTimer(repoId: string, timers: Map<string, NodeJS.Timeout>): void {
  const timer = timers.get(repoId);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  timers.delete(repoId);
}

/**
 * (Re)start the idle countdown for a repo. Called on every activation and on
 * every watcher event, so an actively-edited repo never expires.
 */
export function armWatchInactivityTimer(repoId: string, ctx: WatchContext): void {
  const { watchManager, activeWatchRef, watchInactivityTimers, constants } = ctx;
  clearWatchInactivityTimer(repoId, watchInactivityTimers);
  const timer = setTimeout(() => {
    if (constants.WATCH_ACTIVE_ONLY && activeWatchRef.current === repoId) {
      activeWatchRef.current = null;
    }
    void watchManager.stop(repoId);
    watchInactivityTimers.delete(repoId);
    process.stderr.write(`[watch-idle-stop] repoId=${repoId} ttlMs=${String(constants.WATCH_ACTIVE_TTL_MS)}\n`);
  }, constants.WATCH_ACTIVE_TTL_MS);
  watchInactivityTimers.set(repoId, timer);
}

/**
 * Start watching `repoId`, stopping whatever else was active first when the
 * server is in single-watcher mode. Idempotent: an already-running watcher is
 * reported as such rather than restarted, but its idle timer is still re-armed.
 */
export async function activateWatchForRepo(
  repoId: string,
  repoPath: string,
  reason: string,
  ctx: WatchContext
): Promise<{ started: boolean; message: string }> {
  const { watchManager, activeWatchRef, watchInactivityTimers, constants } = ctx;
  assertPathAllowed(repoPath, constants.allowedRoots);

  if (constants.WATCH_ACTIVE_ONLY && activeWatchRef.current && activeWatchRef.current !== repoId) {
    clearWatchInactivityTimer(activeWatchRef.current, watchInactivityTimers);
    await watchManager.stop(activeWatchRef.current);
  }

  const currentStatus = watchManager.getStatus(repoId);
  let result: { started: boolean; message: string };
  if (currentStatus.length === 0) {
    result = watchManager.start(repoId, repoPath);
  } else {
    result = { started: false, message: `watch already active for repoId '${repoId}'` };
  }

  activeWatchRef.current = repoId;
  armWatchInactivityTimer(repoId, ctx);
  if (result.started) {
    process.stderr.write(`[watch-activate] repoId=${repoId} reason=${reason}\n`);
  }
  return result;
}

/** Configured targets if any, otherwise every registered repo. */
export function resolveAutoWatchTargets(
  store: GraphStore,
  configured: readonly WatchTarget[]
): WatchTarget[] {
  if (configured.length > 0) {
    return [...configured];
  }
  return store.listRepositories().map((r) => ({ repoId: r.repoId, repoPath: r.repoPath }));
}

/**
 * Boot-time activation. A target that fails — an unregistered path, a watcher
 * that will not start — is reported to stderr and skipped; one bad entry must not
 * stop the server from coming up.
 */
export async function startAutoWatchers(
  ctx: WatchBootstrapContext,
  configured: readonly WatchTarget[]
): Promise<void> {
  if (!ctx.constants.WATCH_AUTO_START) {
    return;
  }

  const targets = resolveAutoWatchTargets(ctx.store, configured);
  const selectedTargets = ctx.constants.WATCH_ACTIVE_ONLY ? targets.slice(0, 1) : targets;
  for (const target of selectedTargets) {
    try {
      assertPathAllowed(target.repoPath, ctx.constants.allowedRoots);
      const started = await activateWatchForRepo(target.repoId, target.repoPath, "auto-start", ctx);
      if (started.started) {
        process.stderr.write(`[watch-start] repoId=${target.repoId} path=${target.repoPath}\n`);
      }
    } catch (error) {
      process.stderr.write(
        `[watch-start-error] repoId=${target.repoId}: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }
}

/**
 * Follow the user: any tool call naming a repo makes that repo the active watch
 * target. `watch_repo` and `list_repositories` are excluded — the first because
 * it is the explicit control and must not be second-guessed, the second because
 * it is a survey rather than a statement of intent.
 *
 * Silent on every miss. This is a convenience running before every call; a repo
 * it cannot resolve is not an error the caller asked about.
 */
export async function maybeAutoActivateWatchFromArgs(
  toolName: string,
  args: Record<string, unknown>,
  ctx: WatchBootstrapContext
): Promise<void> {
  if (!ctx.constants.WATCH_AUTO_START) {
    return;
  }

  if (toolName === "watch_repo" || toolName === "list_repositories") {
    return;
  }

  const rawRepoId = args["repoId"];
  if (typeof rawRepoId !== "string" || rawRepoId.trim().length === 0) {
    return;
  }

  const repoId = rawRepoId.trim();
  const rawRepoPath = args["repoPath"];
  const repoPath = typeof rawRepoPath === "string" && rawRepoPath.trim().length > 0
    ? rawRepoPath.trim()
    : ctx.store.getRepository(repoId)?.repoPath;

  if (!repoPath) {
    return;
  }

  await activateWatchForRepo(repoId, repoPath, `interaction:${toolName}`, ctx);
}
