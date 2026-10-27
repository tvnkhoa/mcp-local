## MCP-ISSUE-038 — the `very-large` profile silently discarded every unresolved TYPE_REF, so MCP-ISSUE-034's fix was inert on the biggest repo

- **Status:** **FIXED** 2026-07-30. Filed as open because every remedy considered at the time raised edge
  volume on the largest repo. What shipped avoids that trade entirely — see the update at the end: the
  expensive part was never the storage, it was the LINKING, and `dead_code_scan` does not need it.
- **Scenario:** `wec.be` — 7528 files, so `performanceProfile` auto-selects `very-large`.
- **Evidence:** TYPE_REF on `wec.be` is **1112 edges over 67980 symbols, with ZERO unresolved tokens**.
  Compare `wec.communication-hub` (`standard`): 14377 edges, of which 6652 are unresolved tokens. Two
  repos of the same language and shape, differing by two orders of magnitude in the relation that
  `dead_code_scan` depends on.
- **Root cause — a threshold collision, not a decision anyone made:**
  - `getEffectiveEdgeConfidence` gives a `type:` token no explicit confidence, so it defaults to **0.45**.
  - `defaultEdgePolicy("very-large")` sets `minEdgeConfidence: **0.5**`.
  - `applyEdgeConfidenceFilter` therefore drops **all** of them at extraction, before they reach the DB.
    The 1112 survivors are intra-file resolutions, which carry 0.9.
- **Why it went unnoticed:** before MCP-ISSUE-034 the extractor emitted ~148 TYPE_REF edges in total, so
  losing the unresolved ones cost nothing observable. Now TYPE_REF is the primary evidence for "is this
  type referenced anywhere", and on the largest repo all of it is thrown away.
- **Confirming detail that rules out a different explanation:** bare `callee:` tokens default to 0.4 and are
  dropped for the same reason, while *qualified* `callee:Type.Method` carries an explicit 0.75 and survives
  — `wec.be` holds 11086 unresolved CALLS tokens. So the filter is working as written; it is the
  unannotated defaults that fall on the wrong side of the line.
- **Impact:** `dead_code_scan` on `wec.be` still reports type declarations as its top candidates
  (`ConversationReplyPublishRequest`, `ManualCallLogRequest`, `OsbBookingPublishRequest`), the exact class of
  false positive MCP-ISSUE-034 fixed elsewhere. The 48% reduction measured on `wec.communication-hub` does
  not transfer to any repo large enough to trip the profile.
- **Three remedies, each with its real cost:**
  1. Give `type:` tokens an explicit confidence ≥ 0.5. Smallest change, but it makes the profile's own
     threshold meaningless for TYPE_REF rather than stating an intent.
  2. Exempt TYPE_REF from the confidence filter and bound it separately (a per-file cap, as CALLS already
     has via `maxCallEdgesPerFile`). Most honest, most work.
  3. Lower `very-large`'s `minEdgeConfidence`. Cheapest to write, widest blast radius — it would also
     re-admit bare `callee:` tokens, roughly doubling CALLS on a 67k-symbol repo.
- **Estimated cost of admitting them:** `wec.communication-hub` carries 6652 unresolved TYPE_REF tokens for
  4457 symbols (~1.5 per symbol). At that ratio `wec.be` would gain on the order of 100k edges against its
  current 117893 — a near-doubling of the table, plus the resolve-phase work those rows attract. Not a
  detail to decide in passing, which is why this is filed rather than fixed.

### Update 2026-07-30 — FIXED, and none of the three remedies above is what shipped

All three framed this as "how much extra cost do we accept". That framing was wrong. The expensive part is
not storing the edges, it is LINKING them — and `dead_code_scan`, the tool this whole issue is about, does
not need them linked. Its predicate is `to_id = s.symbol_id OR to_id = 'type:' || s.name`, which matches
**unresolved tokens by name**.

So the two halves were separated:

1. **Keep the edges.** TYPE_REF is exempt from the confidence filter and bounded by its own per-file cap
   (`applyTypeRefEdgeCap`, env `CODEBASE_INDEX_MAX_TYPE_REF_EDGES_PER_FILE`). A cap degrades locally — the
   worst file contributes less — where a confidence floor degraded categorically, deleting the relation
   repo-wide. The 0.45 default is now stated at the point of emission rather than inherited from a prefix
   table in another module, which was the real fragility: nobody reading either file could see that one
   number sat 0.05 below the other.
2. **Skip the linking on `very-large`.** The cross-repo provider search and the vector search are gated off
   there. `findProviderSymbolByName` runs three queries per distinct type name, and on `wec.be` 40k tokens
   are framework names with no in-repo target — 105 seconds spent proving nothing.

**Measured on `wec.be` (7528 files, 67980 symbols, `very-large`):**

| | before | keep-edges only | + skip linking |
|---|---|---|---|
| TYPE_REF edges | 1112 | 80931 | **80931** |
| unresolved tokens | 0 | 39937 | 40246 |
| `typeResolveMs` | 1 | 105743 | **1719** |
| run `elapsedMs` | 98801 | 117577 | **100542** |
| falsely-dead class/record/struct | 6251 | — | **2626 (−58%)** |

**72.8x more TYPE_REF and 58% fewer falsely-dead types, for 1.7 seconds.** Skipping the linking costs 309
tokens that would have resolved via fallback, and `dead_code_scan` matches those by name regardless.

Every bound now reports itself, which was the other half of the lesson: the run summary carries
`edgesDroppedByConfidence` / `byCallCap` / `byTypeRefCap`, present only when non-zero. On `wec.be` that
immediately surfaced **37824 edges still dropped by the confidence floor** — bare `callee:` tokens at 0.4, a
separate lane that was equally invisible before. Not addressed here, but now countable rather than merely
absent.

---

