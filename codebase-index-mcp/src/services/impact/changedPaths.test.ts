import assert from "node:assert/strict";
import test from "node:test";

import { changedPathsFromNameStatus, changedPathsFromStatus } from "./changeAnalysis.js";

/**
 * MCP-ISSUE-087 (release K2): `detect_changes` reads status-carrying git output, so a rename reports
 * both paths. These pin the mapping from git's codes; `test:detect-changes-rename` runs it end to end.
 */

const SHA = "704eb34ffd375c72ffb7c843f60e8bebac0cb033";

test("porcelain v2: a staged rename pairs both paths; a copy, a staged add, deletes and untracked map by code", () => {
  const out = [
    `# branch.oid ${SHA}`,
    "1 .M N... 100644 100644 100644 aaa bbb edited.ts",
    "1 A. N... 000000 100644 100644 000 ccc staged-new.ts",
    "1 D. N... 100644 000000 000000 ddd 000 staged-delete.ts",
    "1 .D N... 100644 100644 000000 eee eee unstaged-delete.ts",
    "2 R. N... 100644 100644 100644 fff fff R100 b2.ts",
    "b.ts",
    "2 C. N... 100644 100644 100644 ggg ggg C100 copy.ts",
    "orig.ts",
    "? loose.ts",
    ""
  ].join("\0");
  assert.deepEqual(changedPathsFromStatus(out, true), [
    { path: "edited.ts", change: "modified" },
    { path: "staged-new.ts", change: "added" },
    { path: "staged-delete.ts", change: "deleted" },
    { path: "unstaged-delete.ts", change: "deleted" },
    { path: "b2.ts", change: "added", renamedFrom: "b.ts" },
    { path: "b.ts", change: "deleted", renamedTo: "b2.ts" },
    { path: "copy.ts", change: "added" },
    { path: "loose.ts", change: "added" }
  ]);
  assert.equal(changedPathsFromStatus(out, false).some((c) => c.path === "loose.ts"), false, "untracked only on request");
});

test("name-status: R pairs both paths, C adds the copy, A/D/M map directly", () => {
  const out = ["M", "edited.ts", "R087", "old/b.ts", "new/b.ts", "C100", "orig.ts", "copy.ts", "A", "new.ts", "D", "gone.ts", ""].join("\0");
  assert.deepEqual(changedPathsFromNameStatus(out), [
    { path: "edited.ts", change: "modified" },
    { path: "new/b.ts", change: "added", renamedFrom: "old/b.ts" },
    { path: "old/b.ts", change: "deleted", renamedTo: "new/b.ts" },
    { path: "copy.ts", change: "added" },
    { path: "new.ts", change: "added" },
    { path: "gone.ts", change: "deleted" }
  ]);
});
