## MCP-ISSUE-036 — a qualified static call resolved to the WRONG same-named method

- **Status:** **FIXED** 2026-07-30 (`src/graph/edgeResolverCalls.ts`). Found by checking `dead_code_scan`
  on the live index after MCP-ISSUE-034 closed — the tool still reported methods with nine call sites dead,
  and the reason turned out to be resolution, not extraction.
- **Scenario:** two classes each declare a static method with the same name — extremely ordinary in C#.
  `ActivityCursor.EncodeCursor(DateTimeOffset, Guid)` and a private `EncodeCursor(int, DateTimeOffset, int)`
  in `GetInboxConversations`; `CrossChannelReplyHelpers.ResolveSubject` and
  `OutboundMetadataResolver.ResolveSubject`.
- **Root cause:** extraction emits BOTH `callee:Method` and `callee:Type.Method` for a qualified call, so
  the receiver type is known. The resolver then threw it away: the dotted branch consulted only
  `interfaceByName`, which misses a static class, and fell through to a name-only
  `pickBestNamedCandidate`. That picks ONE winner per name, so every call to either method landed on the
  same symbol.
- **Why it was invisible in the counts:** the qualified and bare tokens resolved to the same symbolId and
  collapsed under the unique index on `edges(repo_id, from_id, to_id, type)`. Nothing in the totals hinted
  that half the information had been discarded — the graph looked smaller, not wrong.
- **Impact:** not imprecision, misattribution. The loser showed **zero** incoming calls, so `dead_code_scan`
  reported it dead while `search_regex` found nine call sites. It also means "who calls this method" was
  answerable and wrong for any duplicated static helper name.
- **Fix:** before the name-only fallback, resolve the receiver as a `class` candidate and take the member
  method whose `parentSymbolId` is that class — with file identity as a second try, since symbols indexed
  before `parent_symbol_id` existed carry no parent and would otherwise silently miss.

| | before | after |
|---|---|---|
| `ActivityCursor.EncodeCursor` incoming calls | **0** | **2** |
| `CrossChannelReplyHelpers.ResolveSubject` | **0** | **2** |
| the same-named methods in the other class | 6 / 6 | 6 / 6 (unchanged) |
| total CALLS | 14621 | 16131 |

Both sides now hold their own calls — the fix attributes correctly rather than moving the attribution from
one symbol to another. Determinism re-verified: two full runs, all nine edge types identical.

---

