import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { GraphStore } from "../../repositories/graphStore.js";
import { createIndexRunner } from "./indexRunner.js";
import type { IndexMode } from "../../types/index.js";

/**
 * Inbound edges survive an incremental re-index of their TARGET file.
 *
 * A symbol id hashes its declaration row, so inserting lines above a function in `callee.ts` gives it
 * a new id. `replaceSymbolsForFile` clears only the changed file's OUTBOUND edges, and the orphan
 * prune checks `from_id` only — so the CALLS edge that unchanged `caller.ts` had resolved into
 * `callee.ts` kept the old id and pointed at nothing. The reference is a full index of the same
 * tree: the incremental graph must have no dangling `to_id` and the same resolved edges.
 *
 * Runs the real runner (pipeline + resolution post-phase) on a temp directory that is not a git
 * repo, which also keeps `evaluateIncrementalSkip` from short-circuiting the incremental run.
 */

const REPO = "inbound-edges";

const CALLER = `import { helper, other } from "./callee";

export function main(): number {
  return helper() + other();
}
`;

const CALLEE = `export function helper(): number {
  return 1;
}

export function other(): number {
  return 2;
}
`;

function runnerFor(store: GraphStore) {
  return createIndexRunner({
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
}

async function index(store: GraphStore, repoPath: string, mode: IndexMode): Promise<void> {
  await runnerFor(store)(REPO, repoPath, mode, false, 1000, 50);
}

function dangling(store: GraphStore): number {
  const { rows } = store.runReadOnlyGraphQuery(
    `select count(*) as n from edges e
     where e.repo_id = :repoId and e.to_id not like '%:%'
       and not exists (select 1 from symbols s where s.repo_id = e.repo_id and s.symbol_id = e.to_id)`,
    { repoId: REPO },
    1,
    5000
  );
  return Number(rows[0]?.n ?? -1);
}

/** Every edge, by endpoint names rather than ids, so two databases can be compared. */
function edgeShapes(store: GraphStore): string[] {
  const { rows } = store.runReadOnlyGraphQuery(
    `select e.type as type, src.file_path as fromFile, src.name as fromName,
            coalesce(dst.file_path || '#' || dst.name, e.to_id) as target
     from edges e
     join symbols src on src.repo_id = e.repo_id and src.symbol_id = e.from_id
     left join symbols dst on dst.repo_id = e.repo_id and dst.symbol_id = e.to_id
     where e.repo_id = :repoId`,
    { repoId: REPO },
    500,
    5000
  );
  return rows.map((r) => `${String(r.type)} ${String(r.fromFile)}:${String(r.fromName)} -> ${String(r.target)}`.replaceAll("\\", "/")).sort();
}

function callTargets(store: GraphStore): string[] {
  return edgeShapes(store).filter((e) => e.startsWith("CALLS "));
}

test("an incremental re-index of a callee whose lines shifted leaves no dangling inbound edge and matches a full index", async () => {
  const repoPath = mkdtempSync(path.join(tmpdir(), "cim-inbound-"));
  const dbDir = mkdtempSync(path.join(tmpdir(), "cim-inbound-db-"));
  const incremental = new GraphStore(path.join(dbDir, "incremental.db"));
  const reference = new GraphStore(path.join(dbDir, "reference.db"));
  try {
    writeFileSync(path.join(repoPath, "caller.ts"), CALLER);
    writeFileSync(path.join(repoPath, "callee.ts"), CALLEE);
    await index(incremental, repoPath, "full");

    const before = callTargets(incremental);
    assert.ok(before.some((e) => e.endsWith("-> callee.ts#helper")), `precondition: main -> helper resolved. got ${JSON.stringify(before)}`);
    assert.equal(dangling(incremental), 0, "precondition: a full index has no dangling edges");

    // Shift every declaration in callee.ts down three rows. caller.ts is untouched.
    writeFileSync(path.join(repoPath, "callee.ts"), `// one\n// two\n// three\n${CALLEE}`);
    await index(incremental, repoPath, "incremental");

    assert.equal(dangling(incremental), 0, "resolved edges must not point at a symbol id that no longer exists");

    await index(reference, repoPath, "full");
    assert.deepEqual(edgeShapes(incremental), edgeShapes(reference), "incremental graph must equal a full index of the same tree");
    assert.ok(callTargets(incremental).some((e) => e.endsWith("-> callee.ts#helper")), "main -> helper is re-resolved, not dropped");
  } finally {
    incremental.close();
    reference.close();
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test("deleting a callee file leaves no dangling inbound edge and matches a full index", async () => {
  const repoPath = mkdtempSync(path.join(tmpdir(), "cim-inbound-"));
  const dbDir = mkdtempSync(path.join(tmpdir(), "cim-inbound-db-"));
  const incremental = new GraphStore(path.join(dbDir, "incremental.db"));
  const reference = new GraphStore(path.join(dbDir, "reference.db"));
  try {
    writeFileSync(path.join(repoPath, "caller.ts"), CALLER);
    writeFileSync(path.join(repoPath, "callee.ts"), CALLEE);
    await index(incremental, repoPath, "full");

    unlinkSync(path.join(repoPath, "callee.ts"));
    await index(incremental, repoPath, "incremental");
    assert.equal(dangling(incremental), 0);

    await index(reference, repoPath, "full");
    assert.deepEqual(edgeShapes(incremental), edgeShapes(reference));
  } finally {
    incremental.close();
    reference.close();
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});
