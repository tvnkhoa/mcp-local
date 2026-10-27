/**
 * The issue registry is one file per entry plus a generated list. Pinned: a split gives the text back,
 * a `## ` line inside a fence starts no section, an entry is named by its id and any other section by a
 * slug, and the committed list is current (the check the docs lane relies on).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sectionFileName, splitRegistry } from "../issue-index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const text = [
  "# Registry\n", "\n", "## Index\n", "narrative\n", "### sub\n",
  "## MCP-ISSUE-001 — first\n", "```\n", "## not a section\n", "```\n",
  "## ISSUE-CR-002 — cross repo\n", "body\n",
  "## Confirmed fixed — 2026-08-05 wave\n", "tail\n"
].join("");
const { head, sections } = splitRegistry(text);
assert.equal(head + sections.map((s) => s.text).join(""), text);
assert.deepEqual(sections.map((s) => s.file), ["MCP-ISSUE-001.md", "ISSUE-CR-002.md", "confirmed-fixed-2026-08-05-wave.md"]);
assert.ok(head.includes("### sub") && !head.includes("MCP-ISSUE-001"));
assert.ok(sections[0].text.includes("## not a section"));
assert.equal(sectionFileName("## MCP-ISSUE-101 follow-ups (row 5)"), "mcp-issue-101-follow-ups-row-5.md");

const check = spawnSync(process.execPath, [path.join(ROOT, "scripts", "issue-index.mjs"), "--check"], { encoding: "utf8" });
assert.equal(check.status, 0, `the generated list is stale — run node scripts/issue-index.mjs\n${check.stderr}`);
console.log("issue-index: ok");
