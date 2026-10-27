## MCP-ISSUE-091 — `query_docs stale` was flooded by one ambiguous same-named pair

- **Status:** ✅ FIXED 2026-10-22 (release L2, 15ae216).
- **Scenario:** on wec.aria b4ec95bc, 21 of 67 stale rows were `requested_action`, from two same-named parser functions in `wire/commhub.ts` and `wire/console.ts`.
  - In file order they interleaved with the rows that name a changed symbol for certain.
  - Under a `limit` they crowded those rows out.
- **Fix:** option (a) plus the read-time registry label, as the reviewer chose.
  - `results` pages the resolved rows only, and lists them first.
  - `ambiguousGroups` has one entry per mention text:
    - fields: `rows`, `sections`, `docs`, `candidateCount`, `listsSymbolIds` and 3 samples;
    - ordered by sections, then text;
    - at most 100 groups; `ambiguousGroupsDropped` and `ambiguousRowsInDroppedGroups` count the rest.
  - `count` = `resolvedCount` + `ambiguousCount`, the same number as before.
  - A group whose text the registry doc defines carries `registryTerm {doc, line, section, definedBy}`. It is a label only.
  - `expandAmbiguous: true` returns every row flat, resolved first.
  - No storage change and no index bump.
- **Not chosen:**
  - (b) a per-name cap: c64ed243 would still show about 70 ambiguous rows, and the overflow has no list.
  - (c) dropping registry-defined names from candidacy: it would hide real docs and needs a storage change. 3 of the 4 measured floods were generic words (`check`, `failed`, `text`).
- **Measured** on the K-state central DB. The changed symbols are all non-module symbols in the commit's changed code files.

  | commit | rows | resolved | groups | largest groups |
  |---|---|---|---|---|
  | b4ec95bc | 67 | 32 | 6 | `requested_action` 21, `ThreadMessage` 5, `Citation` 3, `narrow` 3, `WriteProposal` 2, `VerifierClaim` 1 |
  | c64ed243 | 642 | 354 | 29 | |
  | 1bf4b7df | 47 | 7 | 6 | `check` 27 |

  For each commit:
  - the rows per group equal the old rows per mention text;
  - 0 groups are dropped;
  - `expandAmbiguous` returns exactly the old row set, resolved first.
- **Guarded:**
  - `mentionAmbiguity.test.ts` "release L2": order, groups, counts add up, and `limit` pages only resolved rows.
  - `test:issue-049-shapes`.

