import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { initGraphSchema, runGraphMigrations } from "../../repositories/schema.js";
import { resolveEfMapEdges } from "./edgeResolverEf.js";

/**
 * Release L3 (MCP-ISSUE-092): EF_MAPS binds a table to its CLR class by NAMESPACE-qualified name (read from the
 * class's file — file-scoped namespaces are not symbols), a column to its property on the class or a base, and
 * leaves a shadow property or an ambiguous class as a labelled token. Re-running re-decides from the token.
 */

function setup(): { db: Database.Database; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ef-maps-"));
  const write = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write("Domain/Conversation.cs", "namespace App.Domain;\n\npublic class Conversation : BaseEntity\n{\n    public string Channel { get; set; }\n}\n");
  write("Domain/BaseEntity.cs", "namespace App.Domain;\npublic abstract class BaseEntity\n{\n    public Guid Id { get; set; }\n}\n");
  write("Other/Conversation.cs", "namespace App.Other\n{\n    public class Conversation { }\n}\n");
  write("Dup1/Note.cs", "namespace App.Domain;\npublic class Note { }\n");
  write("Dup2/Note.cs", "namespace App.Domain;\npublic class Note { }\n");
  const db = new Database(":memory:");
  initGraphSchema(db);
  runGraphMigrations(db, false);
  const sym = (id: string, filePath: string, name: string, kind: string, line: number, parent?: string): void => {
    db.prepare(`insert into symbols (repo_id, symbol_id, file_path, name, kind, line, parent_symbol_id) values ('r', ?, ?, ?, ?, ?, ?)`).run(id, filePath, name, kind, line, parent ?? null);
  };
  sym("conv", "Domain/Conversation.cs", "Conversation", "class", 3);
  sym("conv-channel", "Domain/Conversation.cs", "Channel", "property", 5, "conv");
  sym("base", "Domain/BaseEntity.cs", "BaseEntity", "class", 2);
  sym("base-id", "Domain/BaseEntity.cs", "Id", "property", 4, "base");
  sym("other-conv", "Other/Conversation.cs", "Conversation", "class", 3);
  sym("note1", "Dup1/Note.cs", "Note", "class", 2);
  sym("note2", "Dup2/Note.cs", "Note", "class", 2);
  const edge = (from: string, to: string, type: string, reason: string, confidence = 0.5): void => {
    db.prepare(`insert into edges (repo_id, from_id, to_id, type, confidence, reason) values ('r', ?, ?, ?, ?, ?)`).run(from, to, type, confidence, reason);
  };
  edge("conv", "base", "EXTENDS", "base_list class", 0.9);
  for (const [from, token] of [
    ["t-conv", "efentity:App.Domain.Conversation"],
    ["c-channel", "efprop:App.Domain.Conversation#Channel"],
    ["c-id", "efprop:App.Domain.Conversation#Id"],
    ["c-shadow", "efprop:App.Domain.Conversation#TenantFk"],
    ["t-note", "efentity:App.Domain.Note"]
  ] as const) edge(from, token, "EF_MAPS", `unresolved ef token: ${token}`);
  return { db, root };
}

const maps = (db: Database.Database) =>
  Object.fromEntries((db.prepare(`select from_id as f, to_id as t, confidence as c, reason as r from edges where type = 'EF_MAPS'`).all() as { f: string; t: string; c: number; r: string }[]).map((x) => [x.f, x]));

test("release L3: EF_MAPS binds by namespace, walks bases, labels shadow and ambiguous tokens; re-runs are stable", () => {
  const { db, root } = setup();
  const stats = resolveEfMapEdges(db, "r", root);
  const m = maps(db);
  assert.equal(m["t-conv"]!.t, "conv", "App.Domain.Conversation, not App.Other.Conversation (block namespace)");
  assert.equal(m["t-conv"]!.c, 0.95);
  assert.equal(m["c-channel"]!.t, "conv-channel");
  assert.equal(m["c-id"]!.t, "base-id", "declared on the base class, through EXTENDS");
  assert.equal(m["c-shadow"]!.t, "efprop:App.Domain.Conversation#TenantFk");
  assert.match(m["c-shadow"]!.r, /shadow property/);
  assert.equal(m["t-note"]!.t, "efentity:App.Domain.Note");
  assert.match(m["t-note"]!.r, /^ambiguous ef token: .*2 classes in that namespace/);
  assert.deepEqual(stats, { resolved: 3, unresolved: 2, ambiguous: 1 });

  const first = maps(db);
  resolveEfMapEdges(db, "r", root);
  assert.deepEqual(maps(db), first, "idempotent: a bound edge is re-decided from the token in its reason");

  // The property moves away: the next run unbinds it rather than keeping a stale id.
  db.prepare(`delete from symbols where symbol_id = 'conv-channel'`).run();
  resolveEfMapEdges(db, "r", root);
  assert.equal(maps(db)["c-channel"]!.t, "efprop:App.Domain.Conversation#Channel");
  fs.rmSync(root, { recursive: true, force: true });
});
