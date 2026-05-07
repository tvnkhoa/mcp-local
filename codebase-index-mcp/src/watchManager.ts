import path from "node:path";

import chokidar, { type FSWatcher } from "chokidar";

import type { RepoWatchStatus, WatchConfig } from "./types.js";

type RunIndexer = (repoId: string, repoPath: string, config: WatchConfig) => Promise<void>;
type PruneDeleted = (repoId: string, deletedRelativePaths: string[]) => number;
type WatchActivityMode = "changed" | "deleted";
type WatchActivity = {
  repoId: string;
  repoPath: string;
  relativePath: string;
  mode: WatchActivityMode;
};
type OnWatchActivity = (activity: WatchActivity) => void;

type RepoWatchState = {
  watcher: FSWatcher;
  status: RepoWatchStatus;
  changed: Set<string>;
  deleted: Set<string>;
  timer: NodeJS.Timeout | null;
  runningIndex: boolean;
  rerunRequested: boolean;
};

export class WatchManager {
  private readonly config: WatchConfig;
  private readonly runIndexer: RunIndexer;
  private readonly pruneDeleted: PruneDeleted;
  private readonly onActivity?: OnWatchActivity;
  private readonly states = new Map<string, RepoWatchState>();

  constructor(config: WatchConfig, runIndexer: RunIndexer, pruneDeleted: PruneDeleted, onActivity?: OnWatchActivity) {
    this.config = config;
    this.runIndexer = runIndexer;
    this.pruneDeleted = pruneDeleted;
    this.onActivity = onActivity;
  }

  start(repoId: string, repoPath: string): { started: boolean; message: string } {
    if (this.states.has(repoId)) {
      return { started: false, message: `watch for repoId '${repoId}' is already running` };
    }

    const status: RepoWatchStatus = {
      repoId,
      repoPath,
      running: true,
      startedAt: new Date().toISOString(),
      lastRunAt: null,
      lastError: null,
      eventsReceived: 0,
      eventsDeduped: 0,
      batchesProcessed: 0,
      filesPruned: 0,
      runFailures: 0,
      queuedChanged: 0,
      queuedDeleted: 0
    };

    const state: RepoWatchState = {
      watcher: chokidar.watch(repoPath, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 250,
          pollInterval: 100
        },
        ignored: [
          "**/node_modules/**",
          "**/dist/**",
          "**/build/**",
          "**/.git/**",
          "**/coverage/**"
        ]
      }),
      status,
      changed: new Set<string>(),
      deleted: new Set<string>(),
      timer: null,
      runningIndex: false,
      rerunRequested: false
    };

    state.watcher
      .on("add", (filePath) => this.onEvent(repoId, repoPath, filePath, "changed"))
      .on("change", (filePath) => this.onEvent(repoId, repoPath, filePath, "changed"))
      .on("unlink", (filePath) => this.onEvent(repoId, repoPath, filePath, "deleted"))
      .on("error", (error) => {
        const current = this.states.get(repoId);
        if (!current) return;
        current.status.lastError = error instanceof Error ? error.message : String(error);
      });

    this.states.set(repoId, state);
    return { started: true, message: `watch started for repoId '${repoId}'` };
  }

  async stop(repoId: string): Promise<{ stopped: boolean; message: string }> {
    const state = this.states.get(repoId);
    if (!state) {
      return { stopped: false, message: `watch for repoId '${repoId}' is not running` };
    }

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    await state.watcher.close();
    state.status.running = false;
    this.states.delete(repoId);
    return { stopped: true, message: `watch stopped for repoId '${repoId}'` };
  }

  async stopAll(): Promise<void> {
    const repoIds = [...this.states.keys()];
    for (const repoId of repoIds) {
      await this.stop(repoId);
    }
  }

  getStatus(repoId?: string): RepoWatchStatus[] {
    if (repoId) {
      const state = this.states.get(repoId);
      return state ? [snapshotStatus(state.status)] : [];
    }
    return [...this.states.values()].map((state) => snapshotStatus(state.status));
  }

  private onEvent(repoId: string, repoPath: string, absolutePath: string, mode: "changed" | "deleted"): void {
    const state = this.states.get(repoId);
    if (!state) {
      return;
    }

    const relativePath = normalizeToRelative(repoPath, absolutePath);
    if (!relativePath) {
      return;
    }

    state.status.eventsReceived += 1;

    const queuedCount = state.changed.size + state.deleted.size;
    if (queuedCount >= this.config.maxQueuedEvents && !state.changed.has(relativePath) && !state.deleted.has(relativePath)) {
      state.status.lastError = `watch queue limit reached (${String(this.config.maxQueuedEvents)}); dropping new events`;
      return;
    }

    const alreadyQueued = state.changed.has(relativePath) || state.deleted.has(relativePath);
    if (alreadyQueued) {
      state.status.eventsDeduped += 1;
    }

    if (mode === "deleted") {
      state.changed.delete(relativePath);
      state.deleted.add(relativePath);
    } else {
      if (!state.deleted.has(relativePath)) {
        state.changed.add(relativePath);
      }
    }

    state.status.queuedChanged = state.changed.size;
    state.status.queuedDeleted = state.deleted.size;
    this.onActivity?.({ repoId, repoPath, relativePath, mode });
    this.scheduleFlush(repoId, repoPath);
  }

  private scheduleFlush(repoId: string, repoPath: string): void {
    const state = this.states.get(repoId);
    if (!state) return;

    if (state.timer) {
      clearTimeout(state.timer);
    }

    state.timer = setTimeout(() => {
      state.timer = null;
      void this.flush(repoId, repoPath);
    }, this.config.debounceMs);
  }

  private async flush(repoId: string, repoPath: string): Promise<void> {
    const state = this.states.get(repoId);
    if (!state) {
      return;
    }

    if (state.runningIndex) {
      state.rerunRequested = true;
      return;
    }

    const deleted = [...state.deleted];
    const changed = [...state.changed];
    if (deleted.length === 0 && changed.length === 0) {
      return;
    }

    state.deleted.clear();
    state.changed.clear();
    state.status.queuedChanged = 0;
    state.status.queuedDeleted = 0;
    state.runningIndex = true;

    try {
      if (deleted.length > 0) {
        const pruned = this.pruneDeleted(repoId, deleted);
        state.status.filesPruned += pruned;
      }

      await this.runIndexer(repoId, repoPath, this.config);
      state.status.batchesProcessed += 1;
      state.status.lastRunAt = new Date().toISOString();
      state.status.lastError = null;
    } catch (error) {
      state.status.runFailures += 1;
      state.status.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      state.runningIndex = false;
      if (state.rerunRequested) {
        state.rerunRequested = false;
        if (state.changed.size > 0 || state.deleted.size > 0) {
          this.scheduleFlush(repoId, repoPath);
        }
      }
    }
  }
}

function normalizeToRelative(repoPath: string, absolutePath: string): string | null {
  const relative = path.relative(repoPath, absolutePath).replace(/\\/g, "/");
  if (!relative || relative.startsWith("..")) {
    return null;
  }
  return relative;
}

function snapshotStatus(status: RepoWatchStatus): RepoWatchStatus {
  return { ...status };
}
