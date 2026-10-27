## MCP-ISSUE-096 — the EF lane turned bound doc mentions ambiguous in other C# repos, and over-reported gaps

- **Status:** ✅ FIXED 2026-10-22 (release L3, 4ce86e8).
- **Scenario:** the per-repo K-vs-L delta of release L. Every repo was full-indexed by both builds into scratch DBs, with the live checkouts read-only.
  - **(a) Bound doc mentions dropped** in C# repos with an EF snapshot:

    | repo | bound before | bound after |
    |---|---|---|
    | api-testing-studio | 1 497 | 1 392 |
    | wec.document-management | | −19 |
    | wec.notification | | −15 |
    | wec.be | | −10 |

    Every lost mention was a tie between a property and a new snapshot symbol of the same name:
    - `property + sql_column` (63), e.g. `TotalMs`, `ConditionGroupId`;
    - `property + sql_table` (52), e.g. `Packages`, `Settings`.

    Both sides have kind rank "other", so the K4 rule left the mention ambiguous.
  - **(b) wec.be gained 523 `sql_gap` symbols.**
    - 322 were `SqlServerPropertyBuilderExtensions.UseIdentityColumn(b.Property<int>("Id"))` over a property the block had already declared.
    - A few were SQL Server index extensions (`IsClustered`, `IncludeProperties`).
- **Fix:**
  - **(a) An EF symbol yields to its code twin.** The twins are:
    - for a column: the property its `EF_MAPS` edge binds to;
    - for a table: its entity class, and every `DbSet<Entity>` property.

    When a twin is also a candidate, the EF symbol is dropped. The twin stays, so the pool never empties. An EF table with no code twin of that name, such as CommHub's `conversations`, still binds itself.
  - **(b) A provider extension over a column or index the block declared annotates it and is not a gap.** `HasMethod` is still kept as the index method. A provider call over something undeclared, or any other static call on the builder, stays a gap. The real unsupported constructs on wec.be stay gaps: `ToView`, `HasBaseType`, TPT (`UseTptMappingStrategy`), entities without `ToTable`, and `HasDefaultSchema`.
- **Guarded:**
  - `mentionAmbiguity.test.ts` "an EF snapshot symbol yields to its code twin";
  - `csharpEfSnapshot.test.ts`: identity over a declared property is not a gap, identity over an undeclared one is;
  - CommHub conformance, 6 scenarios EQUAL on the build with this fix.

