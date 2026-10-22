import assert from "node:assert/strict";
import test from "node:test";

import type { SymbolRecord } from "../../types/index.js";
import { extractSql } from "./sqlExtractor.js";
import { extractGraphData } from "./treeSitterExtractor.js";

/**
 * Release M2: `migrationBuilder.Sql` strings through the `.sql` lane's reader, at the migration file's own lines;
 * release M1: `DropTable` / `DropColumn` / `DropIndex` in Up() as drop sites. The fixture follows CommHub's shapes.
 */

const FILE = "src/Infrastructure/Migrations/20261021084540_ScopeManualOpenThreadIndexToSms.cs";
const MIGRATION = `using Microsoft.EntityFrameworkCore.Migrations;

namespace App.Infrastructure.Migrations
{
    public partial class ScopeManualOpenThreadIndexToSms : Migration
    {
        private const string OpenThreadUniqueIndex = "ux_conversations_manual_open_thread";
        private const string Prefix = "ix_";
        private const string Combined = Prefix + "conversations_combined";

        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql($"DROP INDEX IF EXISTS {OpenThreadUniqueIndex};");
            migrationBuilder.Sql($@"
                CREATE UNIQUE INDEX IF NOT EXISTS {OpenThreadUniqueIndex}
                ON conversations (tenant_id, crm_customer_id, channel, conversation_reason_id)
                WHERE source_type = 'agent_manual' AND status = 'open' AND channel = 'sms'
                    AND crm_customer_id IS NOT NULL AND conversation_reason_id IS NOT NULL;");
            migrationBuilder.Sql("ALTER TABLE conversations ADD CONSTRAINT ck_conv_status CHECK (status IN ('open', 'closed'));");
            migrationBuilder.Sql($"CREATE INDEX {Combined} ON conversations (tenant_id);");
            var dynamicName = GetName();
            migrationBuilder.Sql($"CREATE INDEX {dynamicName} ON conversations (channel);");
            migrationBuilder.Sql(BuildSql());
            migrationBuilder.DropIndex(
                name: "ix_conversations_read_state",
                table: "conversations");
            migrationBuilder.DropColumn(
                name: "is_temp_profile",
                table: "conversations");
            migrationBuilder.DropTable(
                name: "legacy_notes");
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql($"DROP INDEX IF EXISTS {OpenThreadUniqueIndex};");
            migrationBuilder.Sql($@"
                CREATE UNIQUE INDEX IF NOT EXISTS {OpenThreadUniqueIndex}
                ON conversations (tenant_id, crm_customer_id, channel, conversation_reason_id)
                WHERE source_type = 'agent_manual' AND status = 'open';");
            migrationBuilder.DropTable(name: "never_read_in_down");
        }
    }
}
`;

function extract(source: string, filePath = FILE): SymbolRecord[] {
  return extractGraphData({ repoId: "r", filePath, language: "csharp", source }).symbols;
}

const lineOf = (source: string, needle: string): number => source.split("\n").findIndex((l) => l.includes(needle)) + 1;

test("EF migration: Sql() interpolated with const fields gives the .sql lane's index, at the .cs line, tier-3 shaped", () => {
  const symbols = extract(MIGRATION);
  const ups = symbols.filter((s) => s.kind === "sql_index" && s.name === "ux_conversations_manual_open_thread");
  assert.equal(ups.length, 2, "Up() and Down() each create it");
  const up = ups.find((s) => !s.signature!.includes("[EF down]"))!;
  assert.equal(up.filePath, FILE);
  assert.equal(up.line, lineOf(MIGRATION, "CREATE UNIQUE INDEX IF NOT EXISTS {OpenThreadUniqueIndex}"), "the statement's own line in the .cs file");
  assert.match(up.signature!, /^ux_conversations_manual_open_thread — unique index on conversations \(tenant_id, crm_customer_id, channel, conversation_reason_id\) where source_type = 'agent_manual' AND status = 'open' AND channel = 'sms' AND crm_customer_id IS NOT NULL AND conversation_reason_id IS NOT NULL \[EF migration ScopeManualOpenThreadIndexToSms\]$/);
  const down = ups.find((s) => s.signature!.includes("[EF down]"))!;
  assert.match(down.signature!, /^ux_conversations_manual_open_thread — \[EF down\] unique index on conversations/);
  // A const built from consts.
  assert.ok(symbols.some((s) => s.kind === "sql_index" && s.name === "ix_conversations_combined"));
});

test("EF migration: drops — Sql() DROP and DropIndex/DropColumn/DropTable in Up() are sql_drop sites; Down() drop operations are not read", () => {
  const symbols = extract(MIGRATION);
  const drops = symbols.filter((s) => s.kind === "sql_drop");
  const label = (s: SymbolRecord) => `${s.name}@${String(s.line)}`;
  assert.deepEqual(drops.filter((s) => !s.signature!.includes("[EF down]")).map(label).sort(), [
    `conversations_read_state@${String(lineOf(MIGRATION, "migrationBuilder.DropIndex("))}`.replace("conversations_read_state", "ix_conversations_read_state"),
    `is_temp_profile@${String(lineOf(MIGRATION, "migrationBuilder.DropColumn("))}`,
    `legacy_notes@${String(lineOf(MIGRATION, "migrationBuilder.DropTable("))}`,
    `ux_conversations_manual_open_thread@${String(lineOf(MIGRATION, "migrationBuilder.Sql($\"DROP INDEX IF EXISTS"))}`
  ].sort());
  const col = drops.find((s) => s.name === "is_temp_profile")!;
  assert.match(col.signature!, /^conversations\.is_temp_profile — dropped column: /);
  assert.ok(!drops.some((s) => s.name === "never_read_in_down"), "a Down() DropTable is rollback, not read");
  assert.ok(drops.some((s) => s.signature!.startsWith("ux_conversations_manual_open_thread — [EF down] dropped index")), "a Down() Sql DROP is a tier-0 drop site");
});

test("EF migration: an ALTER TABLE … ADD CONSTRAINT in Sql() touches the table without defining it", () => {
  const symbols = extract(MIGRATION);
  assert.ok(symbols.some((s) => s.kind === "sql_statement" && s.name === "alter table conversations"));
  assert.ok(!symbols.some((s) => s.kind === "sql_table"), "a migration never defines a table — the snapshot does");
});

test("EF migration: an argument that is not statically a string is a sql_gap at its line, never a silent skip", () => {
  const symbols = extract(MIGRATION);
  const gaps = symbols.filter((s) => s.kind === "sql_gap").map((s) => ({ line: s.line, name: s.name }));
  assert.deepEqual(gaps, [
    { line: lineOf(MIGRATION, "{dynamicName}"), name: "gap: migrationBuilder.Sql (interpolation {dynamicName} is not a const string of this class)" },
    { line: lineOf(MIGRATION, "BuildSql()"), name: "gap: migrationBuilder.Sql (invocation expression in the argument)" }
  ]);
});

test("EF migration: a Designer file, a snapshot or a plain class yields nothing from this lane", () => {
  const designer = `namespace A { [DbContext(typeof(X))] [Migration("20260101000000_A")] partial class A { protected override void BuildTargetModel(ModelBuilder modelBuilder) { } } }`;
  assert.ok(!extract(designer, "src/Migrations/20260101000000_A.Designer.cs").some((s) => s.kind.startsWith("sql_")));
  const plain = `class Repo { void Up(MigrationBuilder migrationBuilder) { migrationBuilder.Sql("DROP TABLE x;"); } }`;
  assert.ok(!extract(plain, "src/Repo.cs").some((s) => s.kind.startsWith("sql_")), "only a class deriving from Migration");
});

test("extractSql (M1): ALTER TABLE … DROP COLUMN gives one sql_drop per column at its own line; drop policy / trigger / table", () => {
  const source = [
    "drop table if exists public.tenant_opening_hours;", // 1
    "", // 2
    "alter table public.tenant_profile", // 3
    "  drop column if exists street,", // 4
    "  drop column if exists city;", // 5
    "drop policy if exists p_read on public.turn_quality;", // 6
    "drop trigger if exists trg_x on public.turn_quality;", // 7
    "alter table public.t drop constraint if exists ck_x;" // 8
  ].join("\n");
  const out = extractSql({ repoId: "r", filePath: "db/0018-x.sql", language: "sql", source }, "M");
  const drops = out.symbols.filter((s) => s.kind === "sql_drop").map((s) => `${s.signature!.split(" — ")[0]!}@${String(s.line)}`);
  assert.deepEqual(drops, [
    "public.tenant_opening_hours@1",
    "public.tenant_profile.street@4",
    "public.tenant_profile.city@5",
    "public.turn_quality.p_read@6",
    "public.turn_quality.trg_x@7"
  ]);
  assert.equal(out.symbols.find((s) => s.kind === "sql_drop" && s.name === "street")?.parentSymbolId, out.symbols.find((s) => s.kind === "sql_statement" && s.line === 3)?.symbolId, "child of its ALTER statement");
});

test("extractSql (M2): an index signature carries columns, method and filter as written", () => {
  const source = "CREATE UNIQUE INDEX ux_reasons ON conversation_reasons USING btree (lower((name)::text)) WHERE deleted_at IS NULL;\nCREATE INDEX ix_gin ON inbox USING gin (search_text gin_trgm_ops);";
  const out = extractSql({ repoId: "r", filePath: "db/0001-x.sql", language: "sql", source }, "M");
  const sig = (n: string) => out.symbols.find((s) => s.kind === "sql_index" && s.name === n)!.signature!;
  assert.match(sig("ux_reasons"), /^ux_reasons — unique index on conversation_reasons \(lower\(\(name\)::text\)\) where deleted_at IS NULL/);
  assert.match(sig("ix_gin"), /^ix_gin — index on inbox \(search_text gin_trgm_ops\) using gin/);
});
