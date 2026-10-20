import assert from "node:assert/strict";
import test from "node:test";

import { skipExtensionOf, tallySkip, toSkipBuckets, type SkipTally } from "./skipReport.js";

/**
 * `skippedByReason` answers "which files are not in the index, and why" in one `health_check` — the
 * acceptance call for wec.aria's every-language requirement. Its shape must be stable across runs
 * and machines, or a before/after comparison of two runs is noise.
 */

test("an extensionless file is labelled by its basename; extensions are lower-cased", () => {
  assert.equal(skipExtensionOf("deploy/Dockerfile"), "Dockerfile");
  assert.equal(skipExtensionOf("Makefile"), "Makefile");
  assert.equal(skipExtensionOf("src\\App.VUE"), ".vue");
  assert.equal(skipExtensionOf(".gitignore"), ".gitignore");
});

test("buckets are grouped by (reason, extension), largest first, with a deterministic tie order", () => {
  const tally: SkipTally = new Map();
  for (const f of ["a.vue", "b.vue", "c.vue"]) tallySkip(tally, "unknown_extension", f);
  tallySkip(tally, "unknown_extension", "x.sql");
  tallySkip(tally, "excluded_extension", "y.png");
  tallySkip(tally, "file_too_large", "docs/15.md");

  assert.deepEqual(toSkipBuckets(tally), [
    { reason: "unknown_extension", extension: ".vue", count: 3 },
    { reason: "excluded_extension", extension: ".png", count: 1 },
    { reason: "file_too_large", extension: ".md", count: 1 },
    { reason: "unknown_extension", extension: ".sql", count: 1 }
  ]);
});
