/**
 * Tests for `deriveState`, the pure reading of the DDL ledger. The SQL half (`readHistory`,
 * `ensureHistory`, `insertHistory`) is exercised against a real server by the DDL flow harness.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveState, type HistoryRow } from "./ddlHistory.js";

let nextId = 1;
function row(partial: Partial<HistoryRow> & Pick<HistoryRow, "version" | "kind" | "direction">): HistoryRow {
  return {
    id: nextId++,
    name: partial.version ?? "inline",
    checksum: `c-${partial.version ?? "inline"}`,
    upChecksum: null,
    status: "applied",
    appliedAt: "2026-10-01T00:00:00.000Z",
    ...partial
  };
}

test("the latest applied row decides: up is applied, down is reverted", () => {
  const state = deriveState([
    row({ version: "20261001000001", kind: "file", direction: "up" }),
    row({ version: "20261001000002", kind: "file", direction: "up" }),
    row({ version: "20261001000002", kind: "file", direction: "down" })
  ]);
  assert.deepEqual(state.applied.map((a) => a.version), ["20261001000001"]);
});

test("failed rows are kept in the ledger but never change state", () => {
  const state = deriveState([
    row({ version: "20261001000001", kind: "file", direction: "up" }),
    row({ version: "20261001000001", kind: "file", direction: "down", status: "failed" }),
    row({ version: "20261001000002", kind: "file", direction: "up", status: "failed" })
  ]);
  assert.deepEqual(state.applied.map((a) => a.version), ["20261001000001"]);
});

test("an adoption consumes one inline row with its checksum, oldest first", () => {
  const state = deriveState([
    row({ version: null, kind: "inline", direction: "up", checksum: "same", name: "first" }),
    row({ version: null, kind: "inline", direction: "up", checksum: "same", name: "second" }),
    row({ version: "20261001000001", kind: "adopted", direction: "up", checksum: "same" })
  ]);
  assert.deepEqual(state.unadoptedInline.map((i) => i.name), ["second"]);
  assert.equal(state.applied[0]?.kind, "adopted");
});

test("stateId changes with any new row, and is stable for the same rows", () => {
  const rows = [row({ version: "20261001000001", kind: "file", direction: "up" })];
  const a = deriveState(rows);
  assert.equal(deriveState(rows).stateId, a.stateId);
  const withFailure = deriveState([...rows, row({ version: "20261001000002", kind: "file", direction: "up", status: "failed" })]);
  assert.notEqual(withFailure.stateId, a.stateId, "even a failed attempt in between invalidates a preview");
  assert.equal(deriveState([]).maxId, 0);
});
