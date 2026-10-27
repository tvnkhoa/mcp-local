## MCP-ISSUE-051 — four tools accept `profile` in code but never advertise it

- **Status:** **FIXED** 2026-08-04 — the four `inputSchema` blocks, **and the parity check the entry
  named as the real deliverable**. See *What shipped* below.
- **Original status:** OPEN 2026-08-04. Found while adding `excludeTests` to six tools for
  MCP-ISSUE-049; filed separately rather than widening that change.
- **Scenario:** every tool here declares its input **twice** — a zod schema (`types/schemas/*.ts`,
  what the handler actually validates against) and a hand-written JSON Schema (`tools/*.ts`, what
  `tools/list` advertises). For four tools the two disagree: the zod schema has
  `profile: responseProfileSchema.default("compact")` and the advertised `inputSchema` has no
  `profile` property at all, while declaring `additionalProperties: false`.

  | tool | zod accepts `profile` | `tools/list` advertises it |
  |---|---|---|
  | `get_symbol_detail` | yes | **no** |
  | `find_symbol_at_line` | yes | **no** |
  | `get_folder_summary` | yes | **no** |
  | `find_entry_points` | yes | **no** |

- **Expected vs actual:** expected the advertised contract to describe what the tool accepts. Actual:
  a client that validates against `tools/list` must reject `profile` as an additional property, while
  a client that ignores `tools/list` finds it works — so the same call is valid or invalid depending
  on how strictly the caller reads the contract. Neither behaviour is wrong; the contract is.
- **Impact:** cost and confusion, not a wrong answer. These four always respond at their zod default
  (`compact`), so an agent that wants `nano` on `get_folder_summary` — a session-orientation tool,
  where payload size is the whole point — has no advertised way to ask, and `README.md` has to
  document the contradiction instead of a rule.
- **Not affected:** `index_repository`, `watch_repo`, `refactor_replace_rollback` and
  `refactor_symbol_migration` also omit `profile` from `inputSchema`, but their zod schemas have no
  `profile` either. Those five are consistent and correct. `find_implementations` and `query_docs`
  had this same gap and were fixed under MCP-ISSUE-049 because their `inputSchema` was already being
  edited there.
- **Fix:** add `profile: PROFILE_PROP` to the four `inputSchema` blocks, then
  `npm run contracts:update`. One line each; the handlers already resolve the profile.
- **Enhancement proposal:** the dual declaration is the root cause — nothing checks that the zod
  schema and the advertised JSON Schema describe the same parameter set, so a drift like this is
  invisible to `typecheck`, to `contracts:check` (which pins the advertised schema against itself,
  not against zod) and to `docs:check`. A test that compares each tool's zod key set against its
  advertised `properties` would have caught all six instances at once, and would prevent the next one.
  That check is the real deliverable here; the four one-line additions are the symptom.

**What shipped 2026-08-04:**

- `profile: PROFILE_PROP` on all four `inputSchema` blocks (`tools/search.ts`,
  `tools/readMetadata.ts`), plus `npm run contracts:update`. The snapshot diff is **purely additive**
  — four `profile` properties, nothing removed — so no client that worked before can break.
- **`src/tools/schemaParity.test.ts`** — the check the entry asked for. It builds all 43 tools and
  compares each one's zod key set against its advertised `properties`, **in both directions**,
  because the two failures mean different things: an advertised key with no zod key is a parameter
  the server will reject as unknown; a zod key with no advertised key is a parameter a conformant
  client cannot send. A third test asserts that a tool declaring `additionalProperties:false`
  advertises every key it marks `required` — that combination is unsatisfiable, and nothing else
  looks for it.
- The check is guarded against going vacuous (`compared >= 40`) and pinned by a named test for the
  four tools in this entry, so deleting the general check cannot quietly un-fix the filed issue.
- **Proven by mutation**, per B-06's standard: removing the `profile` line from
  `find_symbol_at_line` fails both the general check and the named one, and the failure message
  names the tool and the direction — `find_symbol_at_line: accepts "profile" but never advertises it`.

Why this was invisible: `typecheck` sees two unrelated object literals; `contracts:check` pins the
advertised schema against a snapshot of *itself*, so a parameter missing from both stays missing; and
`docs:check` reads only the advertised side. Six instances existed before anyone looked, and all six
were found by hand while editing something else.

---

# Sweep 2026-08-05 (entries 052–059)

Filed from `wec.communication-hub` @ `3f45bee` (521 files / 4459 symbols / 47995 edges, fresh
`mode:"incremental"` run `2712aff5`, docs lane **on**: 12 docs / 166 mentions / 30 resolved). All 43
tools invoked per their own advertised description, plus the destructive lane end-to-end
(preview → apply → rollback, git-verified both directions). Server v0.3.0, 7 repos registered.

**Context that matters for triage:** this sweep started as a re-verification of the 042–051 wave and
**confirmed those fixes hold** — see *Confirmed fixed* at the end. It also found that a large share of
what the consumer previously treated as defects was consumer misuse, now corrected on our side and
listed there too, so those are explicitly **not** filed as issues. What remains below is what
reproduced against correct usage.

Two of the eight are follow-ups on entries already closed (`052` → 036, `055` → 044, `058` partly →
045); each says so and explains why the original fix does not cover the new case.

---

