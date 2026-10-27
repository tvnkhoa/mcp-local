## MCP-ISSUE-043 — the guarded-refactor tools refuse work `refactor_replace_preview` does

> **Title corrected 2026-08-04.** It read "the owner-type prover cannot prove any site". That is true
> of Scenario B and **false of Scenario A**, whose sites never reach the prover at all. Both of the
> entry's own candidate root causes were wrong for A; see *Measured cause* below.

- **Status:** **FIXED** — 2026-08-04 for the lane being unusable and the refusal being illegible;
  **2026-08-05 for prover correctness** (B-13, see *Deferred* below, which now records the closure).
  First observed 2026-08-03; every half re-verified.
- **Scenario A — `refactor_symbol_migration` finds nothing where the plain preview finds three:**
  - `refactor_symbol_migration{ migrations:[{ fromSymbol:"NormalizeToConversationCode", toSymbol:"NormalizeToConversationCodeX", requiredOwnerType:"ConversationLoopCorrelationCodec" }], scopePaths:["backend/CommunicationHub/src"], dryRun:true }` → `totalMatches: 0`, `unresolvedOccurrences: 0`, empty `previewSummary`.
  - Same repo, same scope, same identifier via `refactor_replace_preview` → **3 matches**, each with a correctly resolved `ownerType` (`ConversationLoopCorrelationCodec`, `OutboundDeliveryFailedNotifier`, `ProcessOutboundSentConfirmCommandHandler`) and `confidence 0.95`. The declaring site's own owner type *is* the one that was required, so at least one match cannot legitimately be filtered out.
- **Scenario B — `change_value_representation` flags every site ambiguous under either owner type:**
  - `change_value_representation{ property:"HandledBy", requiredOwnerType:"ConversationAssignmentState", valueMap:{ai:"ConversationHandledBy.Ai", human:"ConversationHandledBy.Human"}, dryRun:true }` → `totalMatches 3`, `ambiguousOccurrences 3`, all three hunks `riskFlags:["ambiguous_target"]`.
  - Repeating with `requiredOwnerType:"Conversation"` gives the same 3/3 (recorded 2026-08-03). `ConversationAssignmentState` is the *declaring* type — `find_field_accesses("HandledBy")` reports exactly that in its `declaringType` field — so this is not a caller passing the wrong type.
- **Impact:** the entire guarded-refactor lane is unusable. Apply is blocked by default on `ambiguous_target`, so the safe, AST-based path for string→enum promotion degrades to `refactor_replace_preview` + a hand-written regex — the thing these tools exist to replace (see MCP-ISSUE-029 for what that costs).
- **Workaround:** `refactor_replace_preview` with a zero-width lookahead to constrain context, accepting that it has no owner-type guarantee.
- **Enhancement proposal:** make the prover's failure legible before making it stricter — return, per unmatched/ambiguous site, *which* owner type was inferred and which rule rejected it (`no_enclosing_type`, `inferred:X ≠ required:Y`, `initializer_target_unknown`). Two candidate causes worth checking first: (a) an object-initializer/`with`-expression site has no enclosing type to attribute, and (b) an owned-entity property is attributed to the owning entity in one code path and to the owned type in another — which is the same owner-semantics split filed as MCP-ISSUE-047.

### Measured cause 2026-08-04 — Scenario A never reached the prover

`refactorSymbolMigration.ts` hardcoded `symbolKinds: ["property", "field"]`, and in
`refactorPreviewBuild.ts` the **kind guard runs before the owner guard**. `inferSymbolKind` classifies
any `Name(` as `"method"`, so all three sites of a *method* migration were dropped before the owner
type was ever consulted — producing `totalMatches: 0, unresolvedOccurrences: 0`, indistinguishable
from "the identifier does not appear in scope". The tool was property/field-only by construction and
its description never said so. Neither candidate cause above was involved.

Scenario B *is* the prover, and the entry's proposal was right about what to do first.

### What shipped 2026-08-04

- **`symbolKinds` is now a caller parameter** defaulting to `[]` (any kind). The old behaviour is
  reachable by passing it explicitly. Tool description updated to say so.
- **Every guard rejection is reported.** `buildRefactorPreview` returns `rejectedSites`, each naming
  the rule that fired — `kind_not_allowed`, `no_enclosing_type`, `owner_not_allowed` — with the
  inferred owner and the required one. A silent `continue` is what made a 0-match result undiagnosable.
- **`verifyOwner` returns its rule**, not just a verdict: `receiver_not_identifier` (any nested path
  such as `conversation.Assignment.HandledBy`, which is permanently unprovable),
  `receiver_type_not_in_scope`, `no_enclosing_object_creation` (a bare assignment inside the declaring
  type, and `with` expressions). Surfaced as `ambiguousReasons` on `change_value_representation`.
- **`includeLowConfidence` is exposed** on both guarded handlers, which hardcoded it to `false`.
- **The response now states why apply is still blocked** (`applyBlockedNote`): `ambiguous_target` is a
  *risk flag*, and `isApplyRunnableHunk` rejects any hunk carrying one **regardless of
  `includeLowConfidence`** — which is why the workaround documented in five places (`CLAUDE.md`,
  `.claude/rules/mcp-hard-mode.md`, `orient.ts`, `docs/decision-tree.md`, the skill) works for
  `rename_assist` (mode `"text"`, no flag, merely low confidence) and cannot reach this lane.

### ~~Deferred~~ — `findOwnerType` was a category error → **FIXED 2026-08-05 (B-13, fifth wave)**

> This section described the state between 2026-08-04 and 2026-08-05. It is kept for the diagnosis;
> the closure is immediately below it. Do not read a current limitation out of the paragraph.

`refactorUtils.ts:findOwnerType` fell back to `findEnclosingClassName`, which returns *the class the
code sits in*, not *the type that owns the referenced member*. At a declaration site those coincide; at
a usage site they do not — which is why the three observed `ownerType` values were three different
enclosing classes, and why an `allowOwnerTypes` guard could match at most one of them. It also returned
null for any file with no `class` keyword, i.e. every top-level function.

**Closed by an AST prover, not a patch.** `src/services/refactor/ownerResolver.ts` is now the single
answer to "which type owns this site", and both lanes route through it — `refactorPreviewBuild`
(`refactor_replace_preview`, `refactor_symbol_migration`) and `analysis/valueRepresentation`
(`change_value_representation`), whose three private scope helpers moved into it rather than being
duplicated. `findOwnerType` is renamed `findEnclosingTypeNameByScan` and demoted to what it always
was: the non-C# fallback, labelled `enclosing_type_fallback` in the response so a scan is never
mistaken for a proof.

Rules, all C#: `declaration_site` · `initializer_type_match` · `receiver_type_match` (instance) ·
`implicit_this` (`this.M`, bare `M(...)`) · `base_type_receiver` · `static_type_receiver` (`Codec.M`
— the rule this entry needed) · `qualified_type_receiver` (`A.B.Codec.M`) · `receiver_member_type`
(one nested hop — Scenario B). Two repo-scoped lookups feed the last three
(`listCSharpTypeNames`, `listMemberDeclarations`), both lazy.

**Scenario A — measured live on `wec.communication-hub` @ `8fe717b`**, the repo and commit this entry
was filed from (full re-index, run `48413133`, 475 files / 4413 symbols / 48009 edges / 0 parse
failures, isolated DB). Same call as the repro:

| | as filed | now |
|---|---|---|
| `refactor_symbol_migration{requiredOwnerType:"ConversationLoopCorrelationCodec"}` | `totalMatches:1`, `rejectedSiteCount:2` | **`totalMatches:3`**, `rejectedSiteCount:0`, `unresolvedOccurrences:0` — all three at confidence `0.95` with **no risk flags**, i.e. appliable rather than merely visible |
| the two rejections | `inferred owner 'OutboundDeliveryFailedNotifier' != required` and the equivalent for `ProcessOutboundSentConfirm` — each caller's own class | gone; both sites now resolve to `ConversationLoopCorrelationCodec` via `static_type_receiver` |
| `refactor_replace_preview`'s `ownerType` at the same 3 sites | `ConversationLoopCorrelationCodec`, `OutboundDeliveryFailedNotifier`, `ProcessOutboundSentConfirmCommandHandler` | `ConversationLoopCorrelationCodec` ×3 |

The guarded tool and the unguarded one now agree at 3, which is what "the guard is usable" means.

**Scenario B — the *shape* is fixed; this repo's three sites are a different shape and are not.** Be
precise about this, because the fixture and the live repo disagree for a real reason:

- The two-hop receiver `conversation.Assignment.HandledBy` — the shape this entry named — resolves,
  proven in `scripts/test/test-owner-prover.mjs`: owner `ConversationAssignmentState` via
  `receiver_member_type`, and `requiredOwnerType:"Conversation"` **rejects** it rather than flagging
  it ambiguous.
- The three live sites are **not** that shape. All three are in
  `tests/Application.UnitTests/…/GetCustomerConversationDetailQueryHandlerTests.cs` — two are
  `var smsMap = Assert.Single(…); … smsMap.HandledBy` (a `var` local initialised from a **method
  call**, so no declared type to read) and one is `detail.ChannelConversations[0].HandledBy` (an
  **element access** receiver). Both need return-type / generic-element inference, neither of which
  this prover does. They remain `totalMatches:3, ambiguousOccurrences:3` — unchanged — but now each
  names its rule (`receiver_type_not_in_scope`, `receiver_not_identifier`) instead of being an
  unexplained ambiguity. Worth noting the original repro also asked for the wrong owner: these are
  DTO assertions, so neither `ConversationAssignmentState` nor `Conversation` owns them.

Reverting the static-receiver rule to the enclosing type reproduces `totalMatches:1` and the
`'Notifier'`/`'Handler'` rejections exactly, and fails 4 harness assertions — so the harness is
evidence, not decoration.

**Known gaps, named rather than left to be rediscovered.** A receiver typed only by a method's return
value (`var x = Factory.Make(); x.M`) is `receiver_type_not_in_scope`; an element-access receiver
(`list[0].M`) is `receiver_not_identifier`. Both need inference this prover does not do, both are
reported with their rule, and neither is ever attributed to a wrong type — which is the property that
matters, since a wrong `verified` is what B-13 existed to remove.

**One contract change, deliberate.** An owner that cannot be *proven* is no longer a silent drop. It
is kept, flagged `ambiguous_target` (so `isApplyRunnableHunk` still blocks apply) and explained in a
new `ambiguousReasons` array — the shape `change_value_representation` already used, now shared by the
whole lane. Only a **proven different** owner lands in `rejectedSites`. So `totalMatches` can rise for
a C# caller using an owner guard, with `unresolvedOccurrences` accounting for the delta, and
`refactor_replace_preview` surfaces both arrays where it previously surfaced neither.

---

