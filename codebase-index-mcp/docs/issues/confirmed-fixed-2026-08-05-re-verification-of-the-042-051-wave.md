## Confirmed fixed — 2026-08-05 re-verification of the 042–051 wave

Re-run independently from the consumer repo. **Every entry held.** Recorded so a future regression has
a baseline:

| entry | verified this sweep |
|---|---|
| **042** rollback desync | **Closed, and better than filed.** The `refactor_replace_rollback` response now carries `actionHints:[{action:"index_repository", arguments:{mode:"dirty"}, reason:"the graph still holds the reverted names until these files are re-indexed"}]` — it warns at the moment it matters. Also established: if you do **not** re-index between apply and rollback there is no desync at all (`search_symbols` for the applied name → `count:0`, tree clean). The original report's polluting step was an intermediate `mode:"dirty"` index. |
| **043 / B-13** owner prover | Holds, and is now the best self-documentation in the server. `refactor_symbol_migration` and `change_value_representation` name the rule for every site across `rejectedSites` / `ambiguousReasons` — `implicit_this_mismatch`, `static_type_receiver_mismatch`, `kind_not_allowed`, `site_not_an_identifier`, `receiver_not_identifier`, `receiver_type_not_in_scope` — and `applyBlockedNote` states the workaround. This is the machinery `MCP-ISSUE-052` asks to reuse. |
| **044** route handlers | `find_entry_points(kind:"route_handler")` → 10 `routeEntryPoints`, each a real handler with its own symbolId and an absolute template. Partially incomplete for one `.WithName()` style → `MCP-ISSUE-055`. |
| **045** cross-repo `Task` | Clean. See `MCP-ISSUE-058(f)` for the 4-edge residue. |
| **046** `find_package_consumers` | Correct: 15 consumers across `wec.be` + hub, `providerCount: 1` (ssnet), `excludedPublisherRows: 64`. Works with and without the `nuget:` prefix. |
| **047** `get_persistence_mapping` | Property-scoped: `HandledBy`/`Conversation` → exactly `ck_conversations_handled_by`, not the old 24-constraint dump. `DB_TRANSLATED_PROJECTION` still detected at `GetCustomerConversationDetail.cs:89`. |
| **048** run counters | `elapsedMs` no longer inverted against phase timings on the runs observed; `resolveCallsCoverage: 1` exactly. |
| **049** papercuts | `excludeTests` shipped (7 tools verified); `query_docs` envelope uniform; `rename_assist` advisory now includes the declaring file (`affectedFiles[0]` + `hints[0]`); `get_dependency_graph` ships `collapsed`; `get_call_chain` at `profile:"standard"` returns full names. Two sub-items still reproduce → `MCP-ISSUE-056` (test filter on 7 more tools) and `MCP-ISSUE-052` (PROPERTY_REF into test files). |
| **050 / 051** | `mode:"incremental"` fast-skips (1419 of 1422 files skipped on a no-op run); `profile` accepted and advertised on the tools checked. |

**Also worth recording: the destructive lane is exact.** `refactor_replace_preview` →
`PREVIEW_READY`, `ambiguity.ratioPercent 0`, `riskFlags: []`, mode auto-selected `symbol-aware` →
`refactor_replace_apply` → `APPLY_OK`, `driftPercent 0`, `unexpectedFiles: []`, `git diff` showed
exactly one line → `refactor_replace_rollback` → `ROLLBACK_OK`, `restoredFilesCount 1`,
`conflicts 0`, `git status` clean. A hand-mangled approval token was correctly rejected with
`INVALID_APPROVAL_TOKEN`. `findMode:"regex"` with `$1` backreferences works, and
`PREVIEW_BLOCKED_BY_AMBIGUITY` correctly refused an unguarded static-member rewrite at
`ratioPercent 100` vs `thresholdPercent 1`.

**Not filed, because they were consumer misuse** (listed so the team is not asked to "fix" them).
**One entry was struck on 2026-08-10:** "`impactLimit` left at its default" was not misuse — raising
`impactLimit` is what silently empties `strict-review`, so both settings were wrong and the tool was at
fault either way. See `MCP-ISSUE-054`. The rest stand: reading only
`runtimeEntryPoints`/`graphEntryPoints` and missing `routeEntryPoints`; expecting names from
`get_call_chain` at `compact`/`nano` when it is a path tool and `standard` carries names; passing a
substring (`"Ai"`) as `refactor_symbol_migration.fromSymbol` and reading the resulting
`site_not_an_identifier` flags as a prover failure; passing the declaring type instead of the
EF-configured owner to `get_persistence_mapping`; passing `name` instead of `symbolId` to
`get_cross_repo_impact` and getting the constructor overload; misreading `find_impact_files`
`view:"surface"` (whose payload key is `callers` by design) as the tool ignoring the parameter.

---

