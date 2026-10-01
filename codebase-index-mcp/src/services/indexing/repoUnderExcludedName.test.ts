import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { GraphStore } from "../../repositories/graphStore.js";
import { createIndexRunner } from "./indexRunner.js";

/**
 * MCP-ISSUE-066 follow-up. `shouldIndexFile` used to receive the ABSOLUTE path, so a repository that
 * itself lives under a directory whose name is an excluded segment (`assets`, `public`, `logs`,
 * `build`, …) had every file rejected as `excluded_path` — an empty graph with status `ok`. The
 * pipeline now passes the repo-relative path; exclusions apply to what is inside the repo only.
 */
test("a repo checked out under an excluded directory name still indexes its own files", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "excluded-name-"));
  const repoPath = path.join(parent, "assets", "repo");
  mkdirSync(path.join(repoPath, "src"), { recursive: true });
  mkdirSync(path.join(repoPath, "public"), { recursive: true });
  writeFileSync(path.join(repoPath, "src", "a.ts"), "export function a(): number {\n  return 1;\n}\n");
  writeFileSync(path.join(repoPath, "public", "gen.ts"), "export function gen(): number {\n  return 2;\n}\n");
  const store = new GraphStore(path.join(parent, "index.db"));
  try {
    const run = createIndexRunner({
      store,
      limits: {
        subtxSize: 20,
        checkpointEveryNBatches: 1,
        largeFileThresholdBytes: 512 * 1024,
        maxFileSizeBytes: 500 * 1024,
        parseWorkers: 0,
        parseJobTimeoutMs: 20_000
      },
      resolvePerformanceProfileOverride: () => "auto"
    });
    await run("excluded-name", repoPath, "full", false, 1000, 50);

    const { rows } = store.runReadOnlyGraphQuery(
      "select name from symbols where repo_id = :repoId and kind = 'function' order by name",
      { repoId: "excluded-name" },
      10,
      5000
    );
    // `a` is indexed despite the `assets/` ancestor; `public/gen.ts` inside the repo is still excluded.
    assert.deepEqual(rows.map((r) => r.name), ["a"]);
  } finally {
    store.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
