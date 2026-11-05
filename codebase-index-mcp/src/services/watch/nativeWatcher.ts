/**
 * MCP-ISSUE-121: one recursive `fs.watch` per repo, for Windows.
 *
 * chokidar opens a separate `fs.watch` for every file and every directory, synchronously, on the server thread. A
 * 3.9k-entry wec.aria worktree took 6.7–7.0 s to get ready and stalled the event loop for up to 1 s at a time;
 * every read that arrived meanwhile waited behind it. On Windows, `fs.watch(root, { recursive: true })` is one
 * ReadDirectoryChangesW handle over the whole subtree and opens in 1–2 ms.
 *
 * What it reports, in chokidar's terms:
 * - `changed`: a path that exists and is a file after the event (add or change; fs.watch does not tell them apart,
 *   and the watcher treats both alike);
 * - `deleted`: a path that no longer exists.
 * A directory is not reported itself: the files a directory move brings in or takes out reach the run through
 * git status (watcherRunPlan's unvouched paths) and through the per-file events the move produces.
 * The same subtrees chokidar ignored are ignored here: any path with a node_modules, dist, build, .git or coverage
 * segment.
 *
 * When the root itself is gone (a removed worktree), `onRootGone` fires once and the watcher closes.
 */

import fs from "node:fs";
import path from "node:path";

/** The directory names whose subtrees no watcher reports (chokidar's `**\/<name>/**` ignore list). */
const WATCH_IGNORED_SEGMENTS: ReadonlySet<string> = new Set(["node_modules", "dist", "build", ".git", "coverage"]);

export interface RepoWatcherHandlers {
  onChange(absolutePath: string): void;
  onDelete(absolutePath: string): void;
  onError(error: unknown): void;
  onRootGone(): void;
}

export interface RepoWatcher {
  close(): Promise<void>;
}

/** True when a repo-relative path (either slash) lies in an ignored subtree. */
export function isIgnoredWatchPath(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((segment) => WATCH_IGNORED_SEGMENTS.has(segment));
}

export function startNativeRecursiveWatcher(repoPath: string, handlers: RepoWatcherHandlers): RepoWatcher {
  let closed = false;
  // One classification in flight per path; an event arriving meanwhile asks for one more after it.
  const inFlight = new Map<string, boolean>();

  const rootGone = async (): Promise<boolean> => {
    try {
      await fs.promises.access(repoPath);
      return false;
    } catch {
      return true;
    }
  };

  const goneOnce = (): void => {
    if (closed) return;
    closed = true;
    try {
      watcher.close();
    } catch {
      // already closed
    }
    handlers.onRootGone();
  };

  const classify = async (absolute: string): Promise<void> => {
    do {
      inFlight.set(absolute, false);
      try {
        const st = await fs.promises.stat(absolute);
        if (!closed && st.isFile()) handlers.onChange(absolute);
      } catch (error) {
        if (closed) return;
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          if (await rootGone()) {
            goneOnce();
            return;
          }
          handlers.onDelete(absolute);
        }
        // EPERM/EBUSY on a file being written or deleted: the next event for it classifies it again.
      }
    } while (!closed && inFlight.get(absolute) === true);
    inFlight.delete(absolute);
  };

  const watcher = fs.watch(repoPath, { recursive: true, persistent: true }, (_event, filename) => {
    if (closed) return;
    if (filename === null || filename === undefined) {
      // No name: Windows says this for the watched directory itself — check whether the root is still there.
      void rootGone().then((gone) => {
        if (gone) goneOnce();
      });
      return;
    }
    const relative = String(filename);
    if (relative.length === 0 || isIgnoredWatchPath(relative)) return;
    const absolute = path.join(repoPath, relative);
    if (inFlight.has(absolute)) {
      inFlight.set(absolute, true);
      return;
    }
    void classify(absolute);
  });

  watcher.on("error", (error) => {
    if (closed) return;
    // Windows reports a deleted watched root as EPERM on the handle.
    void rootGone().then((gone) => {
      if (gone) goneOnce();
      else handlers.onError(error);
    });
  });

  return {
    close: async () => {
      if (closed) return;
      closed = true;
      watcher.close();
    }
  };
}
