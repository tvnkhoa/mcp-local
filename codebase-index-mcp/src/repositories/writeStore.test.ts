import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { beginIndexSession, endIndexSession } from "./writeStore.js";

/**
 * Release J: the server thread's connection runs with `wal_autocheckpoint = 0` so its small commits
 * never finish a checkpoint the refresh worker left behind (a measured 473 ms server-thread stall at
 * landing). An index run on that connection used to restore a hard-coded 8000 at session end, which
 * silently undid the setting after the first index_repository call.
 */
test("endIndexSession restores the connection's own wal_autocheckpoint, not a fixed 8000", () => {
  const db = new Database(":memory:");
  const pages = () => db.pragma("wal_autocheckpoint", { simple: true });

  beginIndexSession(db);
  assert.equal(pages(), 0, "an index session disables auto-checkpoint");
  endIndexSession(db, false, 0);
  assert.equal(pages(), 0, "the server thread's 0 survives an index run");

  beginIndexSession(db);
  endIndexSession(db, false);
  assert.equal(pages(), 8000, "the default stays 8000 for a connection that sets nothing");
  db.close();
});
