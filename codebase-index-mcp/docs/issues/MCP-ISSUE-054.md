## MCP-ISSUE-054 — `detect_changes` applies the default `impactLimit: 20` before breadth normalization, so the risk model is a constant; and a policy preset can filter every row without saying so

- **Status:** ✅ **FIXED 2026-08-10, second attempt** (filed 2026-08-05, was **P1**; marked FIXED,
  then re-opened the same day by consumer re-verification from `wec.communication-hub`). The first
  attempt moved the cap out of the scoring *denominator* and left it in the *numerator*; the second
  removed it from the pipeline entirely. See **Re-open** for the diagnosis and **Second fix** for
  what shipped.
- **Scenario:** `detect_changes(repoId, baseRef:"HEAD~4")` — a 61-file diff — run twice, changing only
  `impactLimit`:

  | `impactLimit` | `impactedFilesCount` | `impactBreadth` |
  |---|---|---|
  | default (20) | pinned at **20** for most files | **1.0** on most files |
  | `400` | 7 / 24 / 2 / 1 / 2 / 0 | 0.005 – 0.06 |

  The cap is applied *before* breadth normalization, so at the default the breadth signal saturates
  and every file scores alike. `riskScore` then clusters (31/30/29/27/25/25) regardless of real
  blast radius.
- **This is the true root cause of a symptom previously mis-filed as a tool defect.** The consumer's
  2026-08-04 note recorded *"`impactedFilesCount` caps at exactly 20 ⇒ `impactBreadth 1.0` on most
  files"* as a scoring bug. It is the documented default interacting with the normalizer — but a
  default that silently flattens the primary output is worth changing rather than documenting.
- **Second, independent problem in the same tool:** `policy:"strict-review"` sets
  `minRiskScore: 40`, while the observed real maximum on this 61-file diff was **31**. Result:
  ```json
  {"impacts": [], "riskSummary": {"highRiskCount":0,"mediumRiskCount":0,"lowRiskCount":0,"maxRiskScore":0,"avgRiskScore":0},
   "impactedFileCount": 0, "filter": {"policyUsed":"strict-review","minRiskScore":40,"matchedCount":0}}
  ```
  A caller reading `riskSummary` concludes "no risk in 61 changed files". The `filter` block does
  carry `matchedCount: 0`, but nothing states that the preset, not the diff, produced the emptiness.
- **Worse than filed, measured 2026-08-10.** This does not merely flatten the signal, it **inverts the
  verdict**. Same diff (`baseRef:"HEAD~4"`, 83 files), same file: `GetCustomerConversationTimeline.cs`
  scores **78 / high** at the default `impactLimit: 20` and **30 / low** at `impactLimit: 400`. And the
  trap closes: `policy:"strict-review"` + `impactLimit: 400` returns `matchedCount: 0`,
  `maxRiskScore: 0` on those 83 changed files — so the usage this registry filed under *consumer
  misuse* ("`impactLimit` left at its default") is the one that empties the preset.
- **Fix (2026-08-10).** `impactBreadth` is normalized against a fixed
  `BREADTH_REFERENCE_DEPENDENTS = 50` (`services/analysis/policyResolver.ts`), never against
  `impactLimit` — which stays a pagination parameter and is now used only to report `capHit`. The
  score is therefore invariant under `impactLimit`, which is what `policyResolver.test.ts` pins. Each
  impact row carries `truncated` + `truncationReason: "impact_limit_reached"`, reusing `search_regex`'s
  existing vocabulary rather than inventing a word. When a preset filters everything, `filter` gains
  `emptyReason` and `maxRiskScoreBeforeFilter`, so "no risk in 83 changed files" is no longer a
  reading a caller can arrive at honestly.
  **Not done:** re-calibrating `strict-review`'s `minRiskScore: 40` against the new scale. The
  threshold is unchanged and should be re-measured on a few real diffs before being moved.
- **Original proposal (kept for the record):** normalize `impactBreadth` against the effective limit rather than a fixed
  denominator, and set an explicit `capHit`/`truncated` flag when the cap bound the result (the tool
  already has this vocabulary — `search_regex` uses `truncated` + `truncationReason`). Separately,
  emit a note when `matchedCount === 0 && changedFileCount > 0`, and consider whether
  `strict-review`'s threshold is calibrated against scores this scorer actually produces.

### Re-open 2026-08-10 — the denominator was fixed, the numerator was not

Re-verified from the consumer repo (`wec.communication-hub`, full re-index at commit `7104253`,
544 files / 4691 symbols). **The claim "the score is therefore invariant under `impactLimit`" is false
in the pipeline.** One diff (`baseRef: "HEAD~6"`, 37 changed files), one file
(`Application/Conversations/Queries/GetInboxConversations/GetInboxConversations.cs`), three values of
`impactLimit`:

| `impactLimit` | `impactedFilesCount` | `impactBreadth` | `lowConfidencePenalty` | `capHit` | **verdict** |
|---|---|---|---|---|---|
| 20 (default) | 20 | **0.4** | 1.0 | `true` | **49 / medium** |
| 50 | 50 | **1.0** | 0.96 | `true` | **75 / high** |
| 400 | 97 | **1.0** | 0.938 | `false` | **74 / high** |

Same diff, same file, same commit — `medium` at the default and `high` at any wider page. This is the
original defect with a new shape: it no longer saturates *upward* at the default, it now saturates
*downward*.

**Mechanism.** `policyResolver.ts` was fixed correctly — `impactBreadth = impactedFilesCount /
BREADTH_REFERENCE_DEPENDENTS` with the fixed reference of 50. But `impactedFilesCount` is still
truncated by `impactLimit` **before** it reaches the scorer, one layer up:

```ts
// services/impact/changeAnalysis.ts:88-89
const impact = store.getImpactFiles(args.repoId, filePath, args.impactLimit);
const risk = scoreChangeRisk(impact.impactedFiles.length, impact.reliabilitySummary, args.impactLimit);
```

`impact.impactedFiles.length` is `min(trueDependents, impactLimit)`. So for every file whose real
blast radius exceeds the page size — precisely the files that matter — breadth is
`impactLimit / 50` rather than `trueDependents / 50`. The fix moved the cap from the denominator to
the numerator instead of removing it.

**Second-order:** `impact.reliabilitySummary` is computed over the same truncated edge set, so the
confidence-derived signals move too. That is why 50 and 400 differ at all (75 vs 74) even though both
reach breadth 1.0 — `lowConfidencePenalty` 0.96 vs 0.938 over 50 vs 97 edges. Fixing breadth alone
will not make the score fully invariant; the reliability summary needs the untruncated set as well.

**Why `policyResolver.test.ts` passes anyway.** The regression test pins the scorer in isolation and
holds the count constant across the two limits:

```ts
const atDefault = scoreChangeRisk(24, CLEAN_RELIABILITY, 20);
const atWide    = scoreChangeRisk(24, CLEAN_RELIABILITY, 400);
assert.equal(atDefault.riskScore, atWide.riskScore);
```

In the real call path those two invocations receive `20` and `97`, never `24` and `24`. The test can
only fail if the scorer itself reintroduces `impactLimit` into the formula — it cannot observe the
truncation, because the truncation happens in the caller. **The unit test is a correct test of the
wrong seam.**

**What did ship and does hold** — please don't regress these while fixing the above:
`truncated` + `truncationReason: "impact_limit_reached"` per impact row; `riskSignals.capHit`;
`filter.emptyReason` + `filter.maxRiskScoreBeforeFilter`. On this diff `policy: "strict-review"` now
returns 4 matched rows rather than a silent empty set. `capHit: true` is a reliable signal that the
row's score is understated — it is currently the only way a caller can detect the defect.

**Enhancement proposal.** Separate the pagination cap from the scoring input: have
`getImpactFiles` return the true dependent count (and the untruncated reliability summary) alongside
the truncated page — e.g. `{ impactedFiles, totalImpactedCount, reliabilitySummary }` — and score from
`totalImpactedCount`. Then extend the regression test **through `analyzeChanges`**, not just
`scoreChangeRisk`, asserting that one file's `riskScore` is identical at `impactLimit` 20 / 50 / 400
on a fixture whose true dependent count exceeds 50. Until that end-to-end assertion exists, this entry
should not be closed again.

### Second fix 2026-08-10 — the cap is out of the pipeline, and the gate can now fire

The enhancement proposal above, implemented as written, plus one thing it did not ask for.

1. **`getImpactFilesImpl` answers two questions instead of one** (`services/impact/impactSurface.ts`).
   An unbounded aggregate pass yields `totalImpactedCount` and a `reliabilitySummary` over the FULL
   dependent set; `limit` then selects the page of detail rows. `truncated` says the page is a window.
   It costs a full walk of the caller set where the old form could stop early — that is the price of
   the count being a measurement.
2. **`changeAnalysis.ts` scores from `totalImpactedCount`**, via a new exported `scoreFileImpact` —
   the seam the end-to-end test needed. `impactedFilesCount` in the response is now the true count,
   not the page size, so `sortBy:"impact"` also sorts by something real. `resources/resourceHandler.ts`
   carried the identical defect and was fixed with it, or `repo://…/risk` and `detect_changes` would
   report different verdicts for one commit.
3. **The weights were recalibrated**, which the re-open did not catch and a code review did. Fixing
   the numerator alone was not enough: breadth carried 0.5 and the other 0.5 was three penalties that
   measure *how much the index trusts its own edges*. That is uncertainty about the GRAPH, not risk in
   the CHANGE — so the widest possible blast radius on a well-indexed repo scored 50, `medium`, and
   `policy:"release-gate"` (minRiskScore 67, `riskLevels:["high"]`) returned empty on any healthy
   diff. A gate that never fires reads exactly like a gate that passed. Breadth now carries 0.7
   (`RISK_WEIGHTS` in `policyResolver.ts`): a file at the reference blast radius clears `high` on its
   own. The 67/34 boundaries and the 20/40/67 policy floors are unchanged — the reachable range under
   them was the broken part.
4. **`capHit` changed meaning** — `totalImpactedCount > impactLimit`, i.e. "the returned rows are a
   window", and no longer "the score is a floor". It is `>` rather than `>=` because a count equal to
   the page size is now a full page, not a truncated one.
5. **The end-to-end assertion exists**: `services/impact/changeAnalysis.test.ts` builds a 60-dependent
   fixture on the real schema in `:memory:` and asserts one file's `riskScore`, `riskLevel`,
   `impactBreadth`, `confidencePenalty` and `lowConfidencePenalty` are identical at `impactLimit`
   20 / 50 / 400 — going through the store call, which is where the truncation was. The
   scorer-in-isolation tests in `policyResolver.test.ts` stay, with a note saying why they were never
   sufficient.

**What did NOT change:** `truncated` + `truncationReason:"impact_limit_reached"` per row,
`filter.emptyReason`, `filter.maxRiskScoreBeforeFilter` — the disclosure half that already held.
`maxRiskScoreBeforeFilter` was, however, reading `sortedImpacts[0]`, which is the maximum only under
`sortBy:"risk"`; `strict-review` defaults to `sortBy:"impact"`, so the diagnostic added to prevent a
false conclusion was quoting a false number. It is a `Math.max` now.

**Consumer note:** the workaround is retired. `impactLimit` is a page size and nothing else — leave it
at the default unless you want more rows listed. Expect scores to RISE for shared-infrastructure files
relative to the pre-fix numbers; that is the correction, not a regression.

**Superseded consumer workaround (kept for the record):** always pass `impactLimit: 300–500`, and
treat `capHit: true` as "this score is a floor, not a verdict."

---

