/**
 * Tests for `diffSnapshots` — the pure half of the snapshot. What `captureSchema` reads from the
 * catalog needs a real server and is covered by `R/snapshot-v2-objects` in
 * `scripts/write-flow-test.mjs`.
 *
 * The drift guard and `compare_environments` both trust `identical`. A change that
 * `diffSnapshots` does not report is a migration applied over schema it never saw.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { diffSnapshots, OBJECT_KINDS, SNAPSHOT_VERSION, type SchemaObjects, type SchemaSnapshot } from "./schemaSnapshot.js";

function emptyObjects(): SchemaObjects {
  return Object.fromEntries(OBJECT_KINDS.map((kind) => [kind, []])) as unknown as SchemaObjects;
}

function snapshot(objects: Partial<SchemaObjects> = {}): SchemaSnapshot {
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    schemas: ["public"],
    tables: [
      {
        schema: "public",
        table: "t",
        columns: [{ name: "id", dataType: "integer", isNullable: false, default: null }],
        indexes: ["CREATE UNIQUE INDEX t_pkey ON public.t USING btree (id)"],
        constraints: [{ name: "t_pkey", type: "PRIMARY KEY", definition: "PRIMARY KEY (id)" }]
      }
    ],
    objects: { ...emptyObjects(), ...objects },
    snapshotId: "unused-by-diff"
  };
}

test("equal snapshots are identical and report no object changes", () => {
  const view = { views: [{ name: "public.v", definition: "abc" }] };
  const diff = diffSnapshots(snapshot(view), snapshot(view));
  assert.equal(diff.identical, true);
  assert.deepEqual(diff.objectChanges, {});
});

test("a changed view definition alone makes the snapshots differ", () => {
  // Before v2 this was invisible: the view's columns were unchanged, and nothing else was read.
  const diff = diffSnapshots(
    snapshot({ views: [{ name: "public.v", definition: "abc" }] }),
    snapshot({ views: [{ name: "public.v", definition: "xyz" }] })
  );
  assert.equal(diff.identical, false);
  assert.deepEqual(diff.objectChanges, { views: { added: [], removed: [], changed: ["public.v"] } });
  assert.deepEqual(diff.changedTables, []);
});

test("added and removed objects are reported per kind, and only changed kinds appear", () => {
  const diff = diffSnapshots(
    snapshot({
      routines: [{ name: "public.f(integer)", definition: "1" }],
      enums: [{ name: "public.mood", definition: '["sad","ok"]' }]
    }),
    snapshot({
      routines: [{ name: "public.f(integer, text)", definition: "1" }],
      enums: [{ name: "public.mood", definition: '["sad","ok"]' }],
      extensions: [{ name: "pgcrypto", definition: "1.3" }]
    })
  );
  assert.equal(diff.identical, false);
  assert.deepEqual(diff.objectChanges, {
    routines: { added: ["public.f(integer, text)"], removed: ["public.f(integer)"], changed: [] },
    extensions: { added: ["pgcrypto"], removed: [], changed: [] }
  });
});

test("enum label order is a change", () => {
  const diff = diffSnapshots(
    snapshot({ enums: [{ name: "public.mood", definition: '["sad","ok"]' }] }),
    snapshot({ enums: [{ name: "public.mood", definition: '["ok","sad"]' }] })
  );
  assert.deepEqual(diff.objectChanges.enums, { added: [], removed: [], changed: ["public.mood"] });
});
