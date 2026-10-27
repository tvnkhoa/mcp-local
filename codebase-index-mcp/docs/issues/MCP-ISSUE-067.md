## MCP-ISSUE-067 — `find_field_accesses` answered a Zod field with an unrelated function and `coverage: "high"`

- **Status:** ✅ FIXED 2026-10-20 (P1; reported by the wec.aria session, release A item 1 of the wec.aria adoption plan).
- **Scenario:** `find_field_accesses(repoId: "wec.aria", name: "kb_version_ids")`. The field is a key in a Zod `z.object(...)`; `packages/core/turn` writes it and `packages/api` reads it.
- **Expected vs actual:** expected reads and writes, or an honest "cannot count". Got 0 reads, 0 writes, `coverage: "high"`, from an index 463 commits behind HEAD.
- **Causes (three):**
  - No `property` symbol carries the name, so the lookup fell back to `candidates[0]`: a *function* `kb_version_ids` in `packages/api/src/wire/envelope.ts`. The substitution was silent.
  - The TS/JS lane emits property edges only for `this.<member>` (`jsTypeRefs.ts`), so `obj.field`, destructuring and `z.infer` types are invisible. `buildCoverageBlock` still said `high`, because the handler never passed `expectedNonZero`.
  - Staleness lived only in the `staleWarning` side field and never lowered `coverage`.
- **Impact:** a confident zero. One such answer and an agent goes back to grep for good.
- **Fix:**
  - Name lookup accepts only `property` symbols, preferring an exact name. With none, the tool returns `property: null`, `coverage: low`, a named gap, and the same-named symbols as `otherMatches`. It does not pick one.
  - `CoverageInput` gains `languageGaps` (caps at `medium`, and `low` when empty) and `staleness` (caps at `medium`, says how far behind).
  - `find_field_accesses` passes `expectedNonZero`, the TS/JS gap and the staleness.
- **Live after the fix:** `confidence: "low"` with three gaps: no property symbol, TS/JS object-literal keys not indexed, and "470 commit(s) behind HEAD with 52 dirty file(s)". `otherMatches` lists the envelope.ts function instead of using it.
- **Guarded:**
  - `src/middleware/coverage.test.ts` (5 tests).
  - `src/tools/handlers/fieldAccessCoverage.test.ts`: indexes a Zod key next to a same-named function and a `this.count` class; asserts no substitution and no `high`.
- **Not fixed here:** exact typed resolution of TS/Zod fields. That is release D (TS LanguageService), gated by the R3 spike.

