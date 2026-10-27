## MCP-ISSUE-098 — raw SQL in EF migrations was invisible (`migrationBuilder.Sql`)

- **Status:** ✅ FIXED 2026-10-22 (release M2, e3214f5 + 0847136).
- **Scenario:** CommHub creates 7 indexes outside the EF model through `migrationBuilder.Sql`. Examples are
  partial unique indexes such as `ux_conversations_manual_open_thread … WHERE … channel = 'sms'` and the
  expression index `lower(name)`. The L3 ground truth listed all 7 as "in the DB, not in the graph".
- **Fix:** `csharpEfMigration.ts` reads the `Up()` and `Down()` of a class deriving from `Migration`.
  - **Static string arguments.** The lane reads a string argument when it is a literal (regular, verbatim or
    raw), an interpolated string whose holes are `const string` fields of the class, or a `+` of those.
  - **One reader.** The text goes through the `.sql` lane's own `extractSql`, laid out on the `.cs` file's
    lines.
  - **Rank.** `Up()` is tier 3, sequenced by the migration timestamp. `Down()` is tier 0, marked `[EF down]`.
    The ModelSnapshot stays tier 4. Against a migration site it now wins *decisively*, because they are one
    lane. Without that, a migration `ADD COLUMN` made `bridge_message_id` mentions ambiguous.
  - **Gaps.** Anything not static is a `sql_gap` at its line. CommHub has 1:
    `{AgentManualSourceType}` is `static readonly`.
  - **Index signatures.** The `.sql` lane's index signature now carries the columns, a non-btree method and the
    filter.
- **Evidence:**
  - All 7 indexes match `pg_indexes` on env dev in name, uniqueness, columns and filter.
    `ux_conversations_manual_open_thread` resolves to `20261021084540_ScopeManualOpenThreadIndexToSms.cs:29`.
  - Indexes and ALTERs on `conversations` bind to the snapshot table.
  - CommHub conformance is 7/7 EQUAL, including `ef-sql-index`.
  - CommHub delta: +23 `sql_index`, +90 `sql_statement`, +58 `sql_drop`, +1 gap; bound mentions go from 752 to 763.
- **Limit:** EF `CreateTable` / `CreateIndex` in migrations stay unmodelled; the snapshot is the model.

