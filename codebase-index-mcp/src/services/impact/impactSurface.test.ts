import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { initGraphSchema } from "../../repositories/schema.js";
import { buildImpactSeed } from "./impactShared.js";
import { getImpactFilesImpl, getImpactSurfaceImpl } from "./impactSurface.js";

/**
 * MCP-ISSUE-060 — `find_impact_files` reported an empty blast radius for a class whose callers
 * all reach it through its interface.
 *
 * The defect was not a missing feature. `expandInterfaceSiblingsImpl` was imported by four modules
 * in this folder and called by none of them, so both views matched only symbols declared IN the
 * queried file. `get_symbol_context_pack`, which does call it, reported 14 callers for the same
 * class in the same session while this reported 0 — and a zero is the answer an agent stops on.
 *
 * The second assertion here is the one that is easy to ship wrong. Both queries used to self-exclude
 * with `sf.file_path != s.file_path`. Once the seed can hold siblings living in other files, `s` may
 * be the INTERFACE, so that predicate stopped meaning "not the file I asked about": it admitted the
 * interface's own file as impacted and dropped genuine callers that happen to live there.
 */

const REPO = "r";

function fixture(): Database.Database {
  const db = new Database(":memory:");
  initGraphSchema(db);
  db.prepare("insert into repositories (repo_id, repo_path, updated_at) values (?, ?, ?)")
    .run(REPO, "/tmp/r", new Date().toISOString());

  const sym = db.prepare(
    `insert into symbols (repo_id, symbol_id, file_path, name, kind, line, parent_symbol_id)
     values (?, ?, ?, ?, ?, ?, ?)`
  );
  // The implementation under test.
  sym.run(REPO, "impl", "svc/SmsService.cs", "SmsService", "class", 1, null);
  sym.run(REPO, "impl.send", "svc/SmsService.cs", "SendAsync", "method", 5, "impl");
  // Its interface, in a DIFFERENT file.
  sym.run(REPO, "iface", "svc/ISmsService.cs", "ISmsService", "interface", 1, null);
  sym.run(REPO, "iface.send", "svc/ISmsService.cs", "SendAsync", "method", 3, "iface");
  // A caller that only ever names the interface.
  sym.run(REPO, "ctrl", "api/SmsController.cs", "SmsController", "class", 1, null);
  sym.run(REPO, "ctrl.post", "api/SmsController.cs", "Post", "method", 9, "ctrl");
  // A symbol living in the interface's own file, calling the interface method. It is a real caller
  // and must not be dropped just because it shares a file with the matched sibling.
  sym.run(REPO, "iface.helper", "svc/ISmsService.cs", "SmsHelper", "class", 20, null);

  const edge = db.prepare(
    `insert into edges (repo_id, from_id, to_id, type, confidence, reason) values (?, ?, ?, ?, ?, ?)`
  );
  edge.run(REPO, "impl", "iface", "IMPLEMENTS", 1, "test");
  edge.run(REPO, "ctrl.post", "iface.send", "CALLS", 0.8, "resolved interface method");
  edge.run(REPO, "iface.helper", "iface.send", "CALLS", 0.8, "resolved interface method");
  return db;
}

test("the filed case: a class reached only through its interface is no longer reported as impacting nothing", () => {
  const db = fixture();

  const files = getImpactFilesImpl(db, REPO, "svc/SmsService.cs", 50, false);
  const callerFiles = files.impactedFiles.map((f) => f.filePath);

  assert.ok(
    callerFiles.includes("api/SmsController.cs"),
    `interface-mediated caller missing; got ${JSON.stringify(callerFiles)}`
  );
  assert.equal(files.totalImpactedCount > 0, true);

  // view:"surface" reads the same CTE and was equally affected — the audit only named view:"files".
  const surface = getImpactSurfaceImpl(db, REPO, "svc/SmsService.cs", 50, false);
  assert.ok(
    surface.callers.some((c) => c.callerFile === "api/SmsController.cs"),
    "surface view must see the interface-mediated caller too"
  );

  db.close();
});

test("self-exclusion is against the QUERIED file, not the matched symbol's file", () => {
  const db = fixture();
  const files = getImpactFilesImpl(db, REPO, "svc/SmsService.cs", 50, false);
  const callerFiles = files.impactedFiles.map((f) => f.filePath);

  // A caller living in the interface's file is still a caller of the implementation.
  // Under the old `sf.file_path != s.file_path` it was silently dropped.
  assert.ok(
    callerFiles.includes("svc/ISmsService.cs"),
    `caller sharing the interface's file was dropped; got ${JSON.stringify(callerFiles)}`
  );
  // And the queried file never lists itself.
  assert.ok(!callerFiles.includes("svc/SmsService.cs"), "queried file must not impact itself");

  db.close();
});

test("a file with no interface siblings behaves exactly as before — the seed is the old filter", () => {
  const db = fixture();
  const seed = buildImpactSeed(db, REPO, "api/SmsController.cs");

  assert.equal(seed.siblingCount, 0, "a plain class with no IMPLEMENTS edge expands to nothing");
  assert.equal(seed.ownCount, 2, "both symbols declared in the file seed the match");
  assert.equal(seed.expansionCapped, false);

  db.close();
});

test("the seed carries the module pseudo-symbol, because IMPORTS edges target it", () => {
  const db = fixture();
  db.prepare(
    `insert into symbols (repo_id, symbol_id, file_path, name, kind, line, parent_symbol_id)
     values (?, ?, ?, ?, ?, ?, ?)`
  ).run(REPO, "mod", "svc/SmsService.cs", "SmsService.cs", "module", 0, null);
  db.prepare(
    `insert into edges (repo_id, from_id, to_id, type, confidence, reason) values (?, ?, ?, ?, ?, ?)`
  ).run(REPO, "ctrl", "mod", "IMPORTS", 1, "test");

  const files = getImpactFilesImpl(db, REPO, "svc/SmsService.cs", 50, false);
  assert.ok(
    files.impactedFiles.some((f) => f.filePath === "api/SmsController.cs"),
    "import-based impact must survive the seed rewrite"
  );

  db.close();
});
