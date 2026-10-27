## MCP-ISSUE-092 — an EF Core repo had no tables in the graph

- **Status:** ✅ FIXED 2026-10-22 (release L3, 32643d7).
- **Scenario:** wec.communication-hub keeps its relational model only in EF Core: 62 migration `.cs` files, 61 `.Designer.cs` files, one `ApplicationDbContextModelSnapshot.cs` and no `.sql`. `search_symbols conversations`, a doc mention of a table and `get_call_chain` on a table all returned nothing.
- **Fix:**
  - **Extractor, `services/extractors/csharpEfSnapshot.ts`.** It runs on a class that derives `ModelSnapshot` and has `[DbContext(typeof(X))]`, decided from the AST, not the file name. It yields:
    - a `sql_table` per mapped table;
    - a `sql_column` per column. Owned types split into the owner's table join it, and the repeated owned key is one column;
    - a `sql_index` with uniqueness, filter and Npgsql method;
    - a `sql_sequence`;
    - a `sql_statement` per check constraint;
    - `SQL_REFERENCES` / `SQL_USES` tokens that the SQL resolver binds;
    - `EF_MAPS` tokens.
  - Signatures end `[EF <Context>: <CLR type>]`.
  - Migrations and Designer.cs define nothing.
  - A construct CommHub does not use becomes a `sql_gap`: `OwnsMany`, TPH, `ToView`, `SplitToTable`, `HasData`, alternate or principal keys, comments, a default schema, and any unknown builder call.
  - **Resolver, `services/graph/edgeResolverEf.ts`.**
    - `EF_MAPS` binds a table to its CLR class by namespace-qualified name. The namespace is read from the class's file, because file-scoped namespaces are not symbols.
    - It binds a column to its property on the class, or on a base class reached through resolved `EXTENDS` edges.
    - A bound edge has confidence 0.95. Otherwise it stays a token labelled as a shadow property, ambiguous, or unresolved.
    - Every run re-decides each edge from its token, after inheritance resolution.
  - **Rank:** a snapshot site is tier 4 in the current-definition order. It is decisive within EF. It is not decisive against a `.sql` site, or when a second DbContext maps the same table.
  - **`get_persistence_mapping`** gains:
    - `snapshot`: the column as the snapshot states it;
    - `snapshotDisagrees`: where a configuration file and the snapshot differ. Neither overrides the other.
  - **New edge type `EF_MAPS`.** It is not a flow edge.
  - **`INDEX_VERSION`:** shared with L1 (v13).
- **Measured on CommHub (86288a2):**
  - 22 tables, 291 columns, 46 indexes, 24 checks, 5 FKs, 1 sequence, 0 gaps.
  - +384 symbols (5 381 → 5 765) and +484 edges (58 805 → 59 289).
  - `EF_MAPS` is bound for 312 of 313. The one remaining token is `ConversationNote#ConversationId`, a shadow FK property.
  - Full run on the scratch clone at 86288a2, two runs each on the same machine: K 13.6 s and 13.2 s; final L 12.6 s and 15.0 s. The difference is within noise.
  - Warm 1-file refresh bar (search_symbols after a 1-file add / delete / edit / revert, 6 rounds, 5 warm):
    - final L: median 1 290 ms, min 1 210, max 1 442, n = 20;
    - K: median 1 300 ms, min 1 105, max 1 675;
    - both builds: every call answered refreshed with the right result, and 0 server-thread samples exceeded 100 ms.
- **Ground truth.** Env `dev` (CommunicationHubDb), read-only. `__EFMigrationsHistory` is at `20261021084540_ScopeManualOpenThreadIndexToSms`, which is the repo's newest migration.
  - **(1) Extractor vs an independent line-based reading of the snapshot text:** 0 differences across 22 tables, 291 columns (type and nullability), 46 indexes (uniqueness, method, filter), 24 checks and 5 FKs.
  - **(3) DB vs snapshot:** columns, types, nullability, checks and FKs are identical. This holds after the owner removed the shared-DB drift on `conversations`.
    - 7 DB indexes are outside the EF model. Each was created by raw SQL in a migration:

      | migration | indexes |
      |---|---|
      | 20260805042256 | `ux_conversation_reasons_name_lower` |
      | 20260805110155_ReconcileInvariantIndexes | `ix_conversations_manual_thread_lookup`, `ix_conversations_osb_thread_lookup`, `ix_conversations_tenant_crm_customer_id`, `ux_conversations_calllog_open_thread`, `ux_conversations_osb_open_thread` |
      | 20261021084540 | `ux_conversations_manual_open_thread` |

    - 31 DB tables are outside the EF model, because the DB is shared.
  - **(2) Snapshot vs migrations:** no column differs, so no column needed checking against its migration. The 7 raw-SQL indexes are explained by their migrations.
- **Guarded:**
  - `csharpEfSnapshot.test.ts`: every construct CommHub uses, two gaps, and Designer / migration / no-[DbContext] files define nothing.
  - `edgeResolverEf.test.ts`: namespace, base walk, shadow, ambiguous, idempotent, and unbinding after a rename.
  - Conformance: `ef-shift`, `ef-rename-property`, `ef-add-column`. All are EQUAL in both modes once MCP-ISSUE-093 and MCP-ISSUE-094 are fixed. The first run was DIFFERENT only in C# rows that predate L.
- **Not done:** `migrationBuilder.Sql("…")` strings are not read, so raw-SQL indexes and functions in EF migrations stay outside the graph.

