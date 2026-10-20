import assert from "node:assert/strict";
import test from "node:test";

import { parseStatusPorcelainV2 } from "./gitHelpers.js";

/**
 * The R1 gate reads HEAD and the dirty set from one `git status --porcelain=v2 --branch -z` call
 * before every read query. The path set must equal what dirty-mode indexing re-reads.
 */

const SHA = "704eb34ffd375c72ffb7c843f60e8bebac0cb033";

test("head, modified, staged, untracked, a path with spaces, and both sides of a rename", () => {
  const out = [
    `# branch.oid ${SHA}`,
    "# branch.head develop",
    "1 .M N... 100644 100644 100644 aaa bbb packages/core/turn/index.ts",
    "1 A. N... 000000 100644 100644 000 ccc docs/new doc.md",
    "2 R. N... 100644 100644 100644 ddd eee R100 src/renamed.ts",
    "src/original.ts",
    "u UU N... 100644 100644 100644 100644 f1 f2 f3 conflicted.ts",
    "? zz-r1-probe.mjs",
    ""
  ].join("\0");
  const s = parseStatusPorcelainV2(out);
  assert.equal(s.head, SHA);
  assert.deepEqual(s.dirty.sort(), ["conflicted.ts", "docs/new doc.md", "packages/core/turn/index.ts", "src/original.ts", "src/renamed.ts", "zz-r1-probe.mjs"]);
});

test("a clean tree has a head and no paths; before the first commit there is no head", () => {
  assert.deepEqual(parseStatusPorcelainV2(`# branch.oid ${SHA}\0# branch.head main\0`), { head: SHA, dirty: [] });
  assert.equal(parseStatusPorcelainV2("# branch.oid (initial)\0# branch.head main\0? a.ts\0").head, null);
});
