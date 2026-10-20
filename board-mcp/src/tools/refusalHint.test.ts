import assert from "node:assert/strict";
import test from "node:test";

import { callBoard } from "./shared.js";
import type { BoardRunner } from "../types/index.js";

/**
 * wec.aria acceptance, non-blocking: the owner-words hint was attached to EVERY refusal of a
 * gate-passing tool, including "not on disk". It belongs only to a refusal about the words.
 */

const refusing = (why: string): BoardRunner => async () => ({ exitCode: 1, stdout: "", stderr: `board: ${why}\n`, timedOut: false });
const HINT = "Pass the owner's verbatim words as gate, with the session UUID.";

test("a refusal about the gate words carries the owner-words hint", async () => {
  const r = await callBoard(refusing("--gate: no user message in session abc contains \"x\""), "new", [], { refusalHint: HINT });
  assert.ok(r.ok);
  assert.equal(r.value.hint, HINT);
});

test("any other refusal keeps the generic hint", async () => {
  const r = await callBoard(refusing("touches: path not on disk: packages/x.ts"), "new", [], { refusalHint: HINT });
  assert.ok(r.ok);
  assert.notEqual(r.value.hint, HINT);
  assert.match(r.value.hint ?? "", /Read `why`/);
});
