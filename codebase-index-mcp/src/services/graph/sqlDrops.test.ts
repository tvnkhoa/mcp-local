import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { resolveSqlEdges } from "./edgeResolverSql.js";
import { getSqlDefinitionInfo, isDecisiveCurrent, pickCurrentSqlDefinition, sqlDefinitionRank, sqlDropState, sqlNameStates } from "./sqlDefinitions.js";

/**
 * Release M1: a drop is a site ordered with the definitions of its name; the latest event decides. Release M2: an
 * EF migration's Up() is tier 3 by its timestamp, its Down() tier 0, the ModelSnapshot tier 4.
 */

function db(): Database.Database {
  const d = new Database(":memory:");
  d.exec(`
    create table files (repo_id text, path text, language text);
    create table symbols (repo_id text, symbol_id text, file_path text, name text, kind text, line integer, signature text);
    create table edges (repo_id text, from_id text, to_id text, type text, confidence real, reason text, assigned_expression text);
  `);
  return d;
}

function sym(d: Database.Database, id: string, kind: string, name: string, file: string, line: number, signature: string): void {
  d.prepare("insert into symbols values ('r', ?, ?, ?, ?, ?, ?)").run(id, file, name, kind, line, signature);
}

function token(d: Database.Database, from: string, toId: string, type: string, clause: string): void {
  d.prepare("insert into edges values ('r', ?, ?, ?, 0.5, ?, null)").run(from, toId, type, `unresolved sql token: ${clause}`);
}

const site = (symbolId: string, filePath: string, line: number, signature: string | null = null) => ({ symbolId, filePath, line, signature });

test("sqlDropState: drop → re-create → drop again ends dropped; drop → re-create is alive; a definition wins a tie", () => {
  const create1 = site("C1", "db/m/0001-baseline.sql", 10);
  const drop1 = site("D1", "db/m/0018-loc.sql", 102);
  const create2 = site("C2", "db/m/0020-back.sql", 5);
  const drop2 = site("D2", "db/m/0030-gone.sql", 7);
  assert.deepEqual(sqlDropState([create1, create2], [drop1, drop2]), { at: "db/m/0030-gone.sql:7", symbolId: "D2" }, "the second drop is the latest event");
  assert.equal(sqlDropState([create1, create2], [drop1]), null, "re-created after the drop: alive");
  assert.deepEqual(sqlDropState([create1], [drop1]), { at: "db/m/0018-loc.sql:102", symbolId: "D1" });
  assert.equal(sqlDropState([site("C", "db/m/0005-a.sql", 9)], [site("D", "db/m/0005-a.sql", 9)]), null, "same file and line: the definition wins");
  assert.equal(sqlDropState([create1], [site("DD", "db/m/0018-loc.down.sql", 3)]), null, "a drop in a .down.sql is a rollback, never after an up-file definition");
  assert.deepEqual(sqlDropState([create1], [], [{ site: drop1, via: "table tenant_profile" }]), { at: "db/m/0018-loc.sql:102", symbolId: "D1", via: "table tenant_profile" }, "a table drop cascades");
  assert.equal(sqlDropState([create2], [], [{ site: drop1, via: "table t" }]), null, "a column defined after its table was dropped belongs to the re-created table");
});

test("sqlDefinitionRank (M2): an EF migration's Up() is tier 3 by timestamp, its Down() tier 0, the snapshot tier 4", () => {
  const mig = "src/Migrations/20260805110155_ReconcileInvariantIndexes.cs";
  assert.deepEqual(sqlDefinitionRank(mig, 12, "ux_a — unique index on conversations (a)").slice(0, 2), [3, 20260805110155]);
  assert.deepEqual(sqlDefinitionRank(mig, 40, "ux_a — [EF down] unique index on conversations (a)").slice(0, 2), [0, 20260805110155]);
  assert.deepEqual(sqlDefinitionRank("src/Migrations/AppDbContextModelSnapshot.cs", 900, "conversations — table (9 columns)").slice(0, 1), [4]);
  const later = site("L", "src/Migrations/20261021084540_Scope.cs", 20, "ux_a — unique index on conversations (a) where channel = 'sms'");
  const earlier = site("E", mig, 30, "ux_a — unique index on conversations (a)");
  const rollback = site("R", "src/Migrations/20261021084540_Scope.cs", 33, "ux_a — [EF down] unique index on conversations (a)");
  assert.equal(pickCurrentSqlDefinition([earlier, rollback, later])!.symbolId, "L");
  assert.equal(isDecisiveCurrent(later, [earlier, rollback, later]), true, "a later migration timestamp is decisive");
  const snapshot = site("S", "src/Migrations/AppDbContextModelSnapshot.cs", 400, "conversations — table (9 columns) [EF AppDbContext: App.Conversation]");
  assert.equal(pickCurrentSqlDefinition([snapshot, site("M", mig, 9, "conversations — table (2 columns)")])!.symbolId, "S", "the snapshot stays current for a name it maps");
});

test("sqlNameStates + getSqlDefinitionInfo: a dropped table and its columns, a re-create, an index on a dropped table", () => {
  const d = db();
  // tenant_opening_hours: created in the baseline (and an archive file), dropped in 0018.
  sym(d, "T_BASE", "sql_table", "tenant_opening_hours", "db/migrations/0001-baseline.sql", 1027, "public.tenant_opening_hours — table (6 columns)");
  sym(d, "T_ARCH", "sql_table", "tenant_opening_hours", "db/migrations/archive/0012-tenant-profile.sql", 116, "tenant_opening_hours — table (6 columns)");
  sym(d, "T_DROP", "sql_drop", "tenant_opening_hours", "db/migrations/0018-tenant-location.sql", 102, "public.tenant_opening_hours — dropped table: drop table");
  // tenant_profile.city: dropped by ALTER TABLE … DROP COLUMN; tenant_profile.name stays.
  sym(d, "P", "sql_table", "tenant_profile", "db/migrations/0001-baseline.sql", 990, "public.tenant_profile — table (12 columns)");
  sym(d, "P_CITY", "sql_column", "city", "db/migrations/0001-baseline.sql", 995, "public.tenant_profile.city — column text");
  sym(d, "P_NAME", "sql_column", "name", "db/migrations/0001-baseline.sql", 992, "public.tenant_profile.name — column text");
  sym(d, "P_CITY_DROP", "sql_drop", "city", "db/migrations/0018-tenant-location.sql", 105, "public.tenant_profile.city — dropped column: alter table public.tenant_profile drop column");
  // A column of the dropped table, and an index on it.
  sym(d, "H_DAY", "sql_column", "day_of_week", "db/migrations/0001-baseline.sql", 1029, "public.tenant_opening_hours.day_of_week — column int");
  sym(d, "H_IX", "sql_index", "ix_hours_tenant", "db/migrations/0001-baseline.sql", 1040, "ix_hours_tenant — index on public.tenant_opening_hours (tenant_id)");
  // A policy dropped and re-created (the idempotent pattern): alive.
  sym(d, "POL_DROP", "sql_drop", "p_read", "db/migrations/0004-x.sql", 94, "public.turn_quality.p_read — dropped policy: drop policy");
  sym(d, "POL", "sql_policy", "p_read", "db/migrations/0004-x.sql", 95, "public.turn_quality.p_read — policy on turn_quality for select [token-read]");
  // A drop with no definition at all (an EF-created index a later migration dropped).
  sym(d, "IX_ONLY", "sql_drop", "ix_conversations_read_state", "src/Migrations/20260805112248_DropUnusedIndexes.cs", 54, "ix_conversations_read_state — dropped index: drop index [EF migration DropUnusedIndexes] (DropIndex)");

  const rows = d.prepare("select symbol_id as symbolId, kind, name, signature, file_path as filePath, line from symbols").all() as { symbolId: string; kind: string; name: string; signature: string | null; filePath: string; line: number }[];
  const states = sqlNameStates(rows);
  assert.equal(states.get("table||tenant_opening_hours")?.dropped?.symbolId, "T_DROP");
  assert.equal(states.get("column||tenant_profile.city")?.dropped?.symbolId, "P_CITY_DROP");
  assert.equal(states.has("column||tenant_profile.name"), false, "a column of a live table with no drop is not in the map");
  assert.deepEqual(states.get("column||tenant_opening_hours.day_of_week")?.dropped, { at: "db/migrations/0018-tenant-location.sql:102", symbolId: "T_DROP", via: "table tenant_opening_hours" });
  assert.equal(states.get("index||ix_hours_tenant")?.dropped?.via, "table tenant_opening_hours", "an index on a dropped table is dropped with it");
  assert.equal(states.get("policy||turn_quality.p_read")?.dropped, null, "drop policy then create policy: alive");
  assert.equal(states.get("index||ix_conversations_read_state")?.dropped?.symbolId, "IX_ONLY");

  const info = getSqlDefinitionInfo(d, "r", ["T_BASE", "T_ARCH", "P_CITY", "P_NAME", "H_DAY", "POL", "T_DROP", "IX_ONLY"]);
  assert.equal(info.get("T_BASE")?.current, true);
  assert.deepEqual(info.get("T_BASE")?.dropped, { at: "db/migrations/0018-tenant-location.sql:102", symbolId: "T_DROP" });
  assert.deepEqual(info.get("T_ARCH")?.dropped, info.get("T_BASE")?.dropped, "every definition site of a dropped name says so");
  assert.equal(info.get("P_CITY")?.definitions, 1, "a single-site name is reported when it is dropped");
  assert.match(info.get("P_CITY")!.note, /DROPPED at db\/migrations\/0018-tenant-location\.sql:105/);
  assert.equal(info.has("P_NAME"), false, "single site, alive: nothing to report (unchanged from I3)");
  assert.equal(info.get("H_DAY")?.dropped?.via, "table tenant_opening_hours");
  assert.equal(info.has("POL"), false, "a re-created policy is alive and single-site");
  assert.deepEqual(info.get("T_DROP")?.dropSite, { drops: "db/migrations/0001-baseline.sql:1027", recreatedAt: null });
  assert.equal(info.get("IX_ONLY")?.dropSite?.drops, null, "no definition in the index");
});

test("resolveSqlEdges (M1): references to a dropped name bind and say 'dropped at'; a drop-only name stays a labelled token", () => {
  const d = db();
  sym(d, "T", "sql_table", "tenant_opening_hours", "db/migrations/0001-baseline.sql", 1027, "public.tenant_opening_hours — table (6 columns)");
  sym(d, "T_DROP", "sql_drop", "tenant_opening_hours", "db/migrations/0018-tenant-location.sql", 102, "public.tenant_opening_hours — dropped table: drop table");
  sym(d, "LIVE", "sql_table", "tenant_location", "db/migrations/0018-tenant-location.sql", 40, "public.tenant_location — table (5 columns)");
  sym(d, "IX_DROP", "sql_drop", "ix_old", "src/Migrations/20260805112248_DropUnusedIndexes.cs", 54, "ix_old — dropped index: drop index [EF migration DropUnusedIndexes] (DropIndex)");
  token(d, "GRANT", "sqltable:public.tenant_opening_hours", "SQL_GRANT", "grant select to aria_turn");
  token(d, "TS", "sqltable:tenant_opening_hours", "SQL_QUERY", "ts query literal from");
  token(d, "TS_LIVE", "sqltable:tenant_location", "SQL_QUERY", "ts query literal from");
  token(d, "ALTER_IX", "sqlindex:ix_old", "SQL_USES", "alter (rename)");
  resolveSqlEdges(d, "r");
  const out = d.prepare("select from_id as f, to_id as t, reason from edges where type != 'SQL_MIGRATION_ORDER' order by f").all() as { f: string; t: string; reason: string }[];
  const by = (f: string) => out.find((r) => r.f === f)!;
  assert.equal(by("GRANT").t, "T", "still binds to the (last) definition");
  assert.match(by("GRANT").reason, /^name_resolved \(dropped at db\/migrations\/0018-tenant-location\.sql:102\): grant select to aria_turn \| sqltable:public\.tenant_opening_hours$/);
  assert.match(by("TS").reason, /^name_resolved \(dropped at /);
  assert.match(by("TS_LIVE").reason, /^name_resolved: /, "a live table is not labelled");
  assert.equal(by("ALTER_IX").t, "sqlindex:ix_old");
  assert.match(by("ALTER_IX").reason, /^unresolved sql token \(dropped at src\/Migrations\/20260805112248_DropUnusedIndexes\.cs:54\): alter \(rename\)$/);
  // Idempotent: the reasons carry the token back, so a second run lands on the same rows.
  resolveSqlEdges(d, "r");
  assert.deepEqual(d.prepare("select from_id as f, to_id as t, reason from edges where type != 'SQL_MIGRATION_ORDER' order by f").all(), out);
});
