## MCP-ISSUE-052 — a qualified static call now produces the CORRECT edge **and** a wrong same-named one, and every traversal built on it reports `confidence:"high"`

- **Status:** ✅ FIXED 2026-08-10 (filed 2026-08-05, was **P0**). Follow-up to `MCP-ISSUE-036` (FIXED 2026-07-30,
  `src/graph/edgeResolverCalls.ts`) — same root area, inverted symptom.
- **Scenario:** `ConversationReplyTargetResolver.Resolve`
  (`src/Application/Common/Messaging/ConversationReplyTargetResolver.cs:18-42`) contains exactly one
  qualified static call, verified with `get_symbol_source`:
  ```csharp
  var parsed = ConversationLoopCorrelationCodec.Parse(bodyTokenOrCorrelationId);
  ```
- **Expected:** one `CALLS` edge, to `ConversationLoopCorrelationCodec.Parse`.
- **Actual:** two, both confidence 0.75:

  ```
  query_graph: SELECT s.name, s.file_path, e.reason FROM edges e JOIN symbols s
    ON s.symbol_id = e.to_id AND s.repo_id = e.repo_id
    WHERE e.repo_id = :repoId AND e.from_id = '48209250031266423408eb5d' AND s.name = 'Parse'

  Parse  src/Application/Common/Messaging/ConversationLoopCorrelationCodec.cs   resolved callee by name
  Parse  src/Infrastructure/BackgroundJobs/OutboundMetadataResolver.cs          resolved callee by name
  ```

- **The diagnostic detail:** `reason` is **`"resolved callee by name"` on BOTH**. The receiver-as-class
  path that 036 added never fired — neither edge came from it. And it should have: all the data that
  path needs is present and correct, checked directly —

  | method | `parent_symbol_id` | joins to | kind |
  |---|---|---|---|
  | `…/ConversationLoopCorrelationCodec.cs:30` `Parse` | `d6d177d288dc9bb59007ee8d` | `ConversationLoopCorrelationCodec` | `class` |
  | `…/OutboundMetadataResolver.cs:26` `Parse` | `bd94610190d8cb1f78b8693a` | `OutboundMetadataResolver` | `class` |

  So `parent_symbol_id` is populated and resolvable for both, and the receiver class exists as a
  `class` symbol. 036's root-cause note says the dotted branch *"consulted only `interfaceByName`,
  which misses a static class"* — and `ConversationLoopCorrelationCodec` is a **static class**. Worth
  checking whether the static-class case is genuinely covered, or whether the bare `callee:Parse`
  token is separately resolving by name and no longer collapsing: 036 explicitly noted that the
  qualified and bare tokens used to *"resolve to the same symbolId and collapse under the unique index
  on `edges(repo_id, from_id, to_id, type)`"*. If the qualified token now resolves correctly but the
  bare token still goes through `pickBestNamedCandidate`, they land on **different** symbolIds and the
  dedup that used to hide this no longer applies — which would make this the visible tail of 036
  rather than a new regression.
- **Impact — this is the P0 part.** The false edge is not one bad row; it seeds whole traversals:
  ```
  trace_execution_flow(repoId, entrySymbolId:"48209250031266423408eb5d", maxDepth:3)
  → nodeCount 9, depthReached 3, truncated false
  → coverage: { confidence: "high", knownGaps: [] }
  ```
  **7 of those 9 nodes are the false subtree** — the wrong `Parse` plus `ReadEmailAttachments`,
  `ReadStringArray`, `ReadString`, `ReadInt`, `ReadBool`, `ReadLong`, all from
  `OutboundMetadataResolver`. The one true callee contributes 0 further nodes. So 78% of the payload
  is wrong while the tool self-reports high confidence and no known gaps. That combination is the
  failure mode a consuming agent cannot detect — it is strictly worse than an error.
  `get_call_chain`, `get_change_context`, `get_symbol_detail` and `find_impact_files` inherit the same
  edge. The false edge also crosses Application → Infrastructure, a boundary this repo forbids, so it
  is additionally detectable as a smell without type inference.
- **Same root cause, property variant (please fix together):** `Resolve` reads `parsed.ConversationCode`
  and `parsed.CorrelationId`, where `parsed` is `ConversationLoopCorrelationCodec.ParseResult` — a
  `record struct` in the **same file** at line 96, confirmed present in the graph via
  `get_file_context`. The emitted `PROPERTY_REF` edges:

  | property | resolved to | correct? |
  |---|---|---|
  | `ConversationCode` | `tests/Application.UnitTests/Common/Behaviours/ConversationVisibilityBehaviourTests.cs` | no |
  | `CorrelationId` | `src/Application/Conversations/Commands/ReplyConversation/ReplyConversation.cs` | no |

  The local's type is available from its initializer, so the owner is derivable without full semantic
  analysis. This is the concrete mechanism behind the "PROPERTY_REF resolving into test files"
  sub-item of `MCP-ISSUE-049`.
- **Correction — the filed diagnosis was wrong about the mechanism (2026-08-10).** The report concluded
  that "the receiver-as-class path that 036 added never fired". It fired. Read from source, the real
  chain is:
  1. `csharpSymbols.ts:285` **always** emits the bare `callee:Parse`; `:299` emits the qualified
     `callee:ConversationLoopCorrelationCodec.Parse` as well. The comment at `:295` says both are stored
     deliberately because the unique index on `edges(repo_id, from_id, to_id, type)` collapses them.
  2. That collapse only holds while both halves resolve to the **same** symbol.
  3. `edgeResolverCalls.ts:261-274` — 036's receiver-as-class branch — resolves the qualified token
     **correctly**, while the bare token still goes through `pickBestNamedCandidate` at `:225` and picks
     `OutboundMetadataResolver.Parse`. Two different `to_id` values, nothing collapses, both survive.

  So this was exactly the "visible tail of 036" the entry hypothesised in its last paragraph, and not a
  failure of the 036 branch. The reason the two edges were indistinguishable in `reason` is separate and
  now fixed: the receiver-typed branch had **no label of its own** and fell through to the shared
  `"resolved callee by name"` string, which is what made a proven resolution look like a name guess.
- **Fix.** `suppressBareCallsShadowedByQualified` (`edgeResolverCalls.ts`) demotes the bare edge when
  all three hold: a qualified sibling from the same caller resolved to a real symbol, the bare edge
  resolved **by name across files** (a same-file or receiver-typed match is evidence and is left alone),
  and the two disagree. Demoted, not deleted — `to_id` returns to its placeholder at `confidence: 0.1`,
  so the decision stays auditable and MCP-ISSUE-053's filter hides it from `edgesOut`/`topCallees`.
  Batch boundaries were widened so one caller's rows are never split across two passes. The
  receiver-typed branch now reports `reason: "resolved callee by receiver type"` at confidence 0.85, and
  a multi-candidate name guess reports `"resolved callee by name (ambiguous)"`.
  On `wec.communication-hub`: **227 bare edges demoted**, and `Resolve` now has exactly one `Parse` edge.
- **Follow-up 2026-08-10 (code review): the suppression did not survive the next index run.** Demoting
  rather than deleting means the row keeps its `callee:` token — so `buildCallResolutionContext`, whose
  pre-fetch is `where … and e.to_id like 'callee:%'`, re-selected it on every subsequent run. Call
  resolution runs repo-wide even on **incremental** runs (`indexRunner.ts`), and by then the qualified
  sibling is already resolved and therefore absent from `unresolvedRows` — so `provenByCaller` holds no
  proof, the three-part guard cannot fire, and the bare edge is re-resolved to the wrong same-named
  method at confidence 0.75. Reproduction: full index (suppressed) → touch any unrelated file →
  incremental index → the wrong high-confidence CALLS edge is back. The
  `reason = "superseded by qualified call"` marker was written and never read; the pre-fetch now
  excludes rows carrying it. Re-indexing the caller's own file still clears the suppression the right
  way, because `deleteEdgesForFile` drops the row and extraction re-emits it unmarked.
- **Fix, coverage half.** `trace_execution_flow` and `get_call_chain` feed edge provenance into
  `buildCoverageBlock`, which can no longer report `confidence: "high"` for a traversal standing on a
  name-only edge, and names the count in `knownGaps`. The shared label set is
  `NAME_ONLY_EDGE_REASONS` in `types/index.ts` — resolver and read side must agree on the strings.
- **Fix, property half — partial, and deliberately so.** `record` / `record struct` / `enum` were missing
  from the type-constraint query, so a property owned by a CQRS record could never constrain a candidate
  set. Added. Beyond that, a **bare** property token that matches >1 candidate and none in the caller's
  own file is now **refused** rather than resolved (`unresolved property (ambiguous owner)`): picking one
  of 25 same-named `ConversationCode` properties is noise, not a guess, and that is what produced the
  edge into `ConversationVisibilityBehaviourTests.cs`. **2630 tokens refused** on the reference repo, and
  the test-file edge is gone.
  The `CorrelationId` case is **knowingly left as a labelled guess.** Its true owner —
  `ConversationLoopCorrelationCodec.ParseResult` — is a positional record parameter and so is not in the
  graph at all, while exactly one `CorrelationId` property exists repo-wide. Refusing every unique-name
  cross-file bare token would delete **2791 of 8578** resolved property edges, most of which are correct;
  that trades a wrong answer for a missing one. Those edges are now demoted to confidence **0.4** with
  `reason: "resolved property by name (unproven owner)"` and counted as name-only in coverage. Resolving
  them properly needs the local's initializer type, i.e. return-type inference across files — not done.
- **Workaround (consumer side):** never trust a single-name call/property edge, or any traversal built
  on one, without confirming against `get_symbol_source`.
- **Enhancement proposal:** the owner prover shipped for `MCP-ISSUE-043` / **B-13**
  (`src/services/refactor/ownerResolver.ts`) already types exactly this receiver shape correctly — it
  emits `static_type_receiver_mismatch` for a qualified static receiver, and handles instance, `this`,
  `base`, namespace-qualified and one-hop-nested receivers. **Reuse it in the call/property
  resolvers**, and once a receiver type is proven, drop competing same-name candidates instead of
  emitting both. Secondary ask: when a resolution came from the name-only fallback, that must not
  surface as `confidence: "high"` / `knownGaps: []` at the traversal level — propagate the weakest
  edge's provenance into `coverage`.

---

