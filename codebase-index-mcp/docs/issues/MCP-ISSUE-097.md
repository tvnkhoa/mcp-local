## MCP-ISSUE-097 — a dropped SQL object read as a live definition

- **Status:** ✅ FIXED 2026-10-22 (release M1, e3214f5).
- **Scenario:** wec.aria `0018-tenant-location.sql:102` runs `drop table if exists public.tenant_opening_hours`,
  and `:104-111` drops 7 `tenant_profile` columns. The index still answered with the baseline's
  `create table` as the current definition. Every grant, `insert into` and TS query naming the table bound to it
  as if it existed. CommHub's EF migrations drop 26 indexes and 14 columns in `Up()`, and nothing in the graph
  said so.
- **Expected vs actual:** a name whose latest migration event is a drop is reported as dropped. Before the fix it
  was indistinguishable from a live one.
- **Fix:**
  - **Drop sites.** A new symbol kind, `sql_drop`, records one dropped object per drop site. The sites come from:
    - `.sql` DROP TABLE / VIEW / INDEX / FUNCTION / TYPE / SEQUENCE / TRIGGER / POLICY;
    - `ALTER TABLE … DROP COLUMN`, one site per column at its own line;
    - EF `Up()` `DropTable` / `DropColumn` / `DropIndex`;
    - DROPs inside `migrationBuilder.Sql`.
  - **Order.** Drop sites are ordered with the definitions of their name by the I3 rank (`sqlDefinitions.ts`).
    - The latest event decides. A re-create after a drop makes the name live again; drop → re-create → drop
      leaves it dropped.
    - A table drop cascades to the table's columns, policies, triggers and indexes.
    - The state is derived, not stored. It shows as `sqlDefinition.dropped = { at, symbolId, via? }` in
      `search_symbols` / `get_symbol_detail`; a `sql_drop` itself gets `dropSite { drops, recreatedAt }`.
  - **References keep binding, labelled `name_resolved (dropped at file:line): …`.** A name with drops and no
    definition stays a token labelled `unresolved sql token (dropped at file:line): …`.
  - **Doc mentions bind as before.** A drop candidate yields to a definition of its name, and of several drop
    sites the latest one stands. `query_docs stale` adds `dropped` for dropped targets.
- **Evidence:**
  - Ground truth, all ABSENT in the database:
    - wec.aria: 25 dropped objects in aria_dev — the table, its 5 columns and its index via the cascade, the 7
      `tenant_profile` columns, 4 `market_id` columns, `usage_events.provider_request_id`, 2 policies and 4 types;
    - CommHub: 40 dropped objects in env dev.
  - Delta from v13 to v14:
    - wec.aria: +137 `sql_drop`; the edges are unchanged in number and the dropped targets are relabelled;
      bound mentions stay at 12 762.
    - Other repos only gain drop sites.
- **Limits (labelled, not fixed):**
  - `CREATE … IF NOT EXISTS` over a live object counts as a re-definition.
  - `RenameColumn` / `RenameTable` are not modelled as drop + create.
- **Guarded:**
  - `sqlDrops.test.ts`: the state machine, the cascade, the EF tiers and the resolver labels;
  - `csharpEfMigration.test.ts`: one drop site per column at its line;
  - wec.aria conformance `drop-recreate`, steps 1 and 2 EQUAL in both modes.

