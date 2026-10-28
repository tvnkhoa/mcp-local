import assert from "node:assert/strict";
import test from "node:test";

import { checkUtf8, isTextPath } from "./textEncoding.mjs";

test("valid UTF-8 passes, including multibyte", () => {
  assert.equal(checkUtf8(Buffer.from("plain — “quoted” ✓ tiếng Việt\n", "utf8")), null);
  assert.equal(checkUtf8(Buffer.alloc(0)), null);
});

test("a cp1252 em dash byte (0x97) fails at its offset", () => {
  const bad = checkUtf8(Buffer.concat([Buffer.from("ab "), Buffer.from([0x97]), Buffer.from(" cd")]));
  assert.deepEqual(bad, { offset: 3, reason: "not valid UTF-8" });
});

test("a truncated multibyte sequence at the end fails", () => {
  const bad = checkUtf8(Buffer.concat([Buffer.from("ok"), Buffer.from([0xe2, 0x80])]));
  assert.equal(bad?.offset, 2);
});

test("a BOM fails at offset 0", () => {
  const bad = checkUtf8(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("x")]));
  assert.deepEqual(bad, { offset: 0, reason: "starts with a UTF-8 BOM" });
});

test("isTextPath keeps text, drops binaries", () => {
  for (const f of ["a/SKILL.md", "x.ts", ".gitignore", ".github/CODEOWNERS", "a/.env.example"]) assert.ok(isTextPath(f), f);
  for (const f of ["a.png", "b.zip", "c.node"]) assert.ok(!isTextPath(f), f);
});
