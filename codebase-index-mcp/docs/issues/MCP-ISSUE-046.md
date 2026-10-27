## MCP-ISSUE-046 — `find_package_consumers` returns the files that DEFINE the package, and a wrong name returns 0 silently

- **Status:** **FIXED** 2026-08-04 — both halves; see below. First observed 2026-08-03. Sharpens ISSUE-CR-001, which reported the
  `resolved:false` bridge gap but treated the 8 returned rows as consumers.
- **Scenario:** `find_package_consumers{ packageName:"SSNet.CommunicationHub.Messaging" }` → `consumerCount: 8`, and all 8 are in the **provider** repo: `ssnet` `src\SSNet.CommunicationHub.Messaging\Contracts\{Automation,Campaign,ConversationReply,EmailSent,EmailDeliveryFailed,EscalationRequired}*Contract.cs`, `consumerKind:"module"`, `dependencyReason:"namespace package contract bridge"`, `resolved:false`, backslash paths.
- **Expected vs actual:** the actual consumer is `wec.communication-hub`, which holds **34** `DEPENDS_ON` edges to `nuget:ssnet.communicationhub.messaging` (`query_graph`: `SELECT to_id, COUNT(*) FROM edges WHERE type='DEPENDS_ON' AND to_id LIKE 'nuget:%' GROUP BY to_id`). It appears nowhere in the result. The rows returned are the files that declare the contracts.
- **Second defect in the same call path:** a package name that does not exist returns `{"consumerCount":0,"consumers":[]}` with no diagnostic — `find_package_consumers{ packageName:"SSNet.Messaging.Contracts" }` (a plausible-looking wrong name) is indistinguishable from a real zero. The correct id was only findable via the `edges` query above.
- **Impact:** the tool answers the inverse of the question asked. "Who consumes this contract" is the pre-change gate for a contract bump, and acting on this output would mean reviewing the publisher instead of the consumers.
- **Workaround (verified):** the `nuget:` `DEPENDS_ON` query in `query_graph` — it gives both the exact contract ids and the consuming repos, and is unaffected by the bridge state.
- **Enhancement proposal:** (1) return rows keyed by the repo holding the `DEPENDS_ON` edge (consumer side), and if provider definitions are useful keep them in a separate `providers[]` array rather than mixing them into `consumers[]`; (2) when the normalized `packageContractId` matches no `to_id` in any repo, say so (`unknownPackage: true` plus the nearest known ids) instead of returning an empty success.

### What shipped 2026-08-04 — both proposals, exactly as written

- **The publisher is excluded from `consumers[]`.** Two lanes write the `from_id` side of a
  `DEPENDS_ON` edge and one fires *inside* the publishing repo: `dotnetProjectParser` emits the `.csproj`
  that declares the `PackageReference`, and `csharpSymbols` emits a "namespace package contract bridge"
  edge for every file whose `using` maps to the contract — including the provider's own contract files,
  which `using` their siblings. The publisher is identifiable because `dotnetProjectParser` *also* emits
  a `module` symbol whose `signature` **is** the contract id, so a `not exists` on that (plus `distinct`)
  drops any repo that exports the contract it appears to consume. The fact was already in the DB and
  simply unused.
- **Providers are reported separately** (`providers[]`, `providerCount`), not mixed into `consumers[]`
  where they answer the opposite question.
- **The exclusion is never silent.** `excludedPublisherRows` reports how many rows it dropped.
- **An unknown package says so.** A `packageContractExists` probe drives `unknownPackage: true` with an
  unconditional hint. The old `didYouMean` suggester could not close this gap because it is
  prefix-anchored: a name wrong in its *first* segment yields no suggestions, and the hint was spread
  only when suggestions existed — so `{"consumerCount":0,"consumers":[]}` was byte-identical to a real
  zero. A third message distinguishes "indexed, but only the publisher references it".

**Measured against the live graph.** The entry's `consumerCount: 8` did not reproduce — the index had
moved on, and the contract had 110 `DEPENDS_ON` edges (ssnet 64, `wec.communication-hub` 34, `wec.be` 12)
with the tool returning 100 (limit-capped). With the fix: **46 consumers** — the hub's 34 and wec.be's 12,
i.e. exactly the 34 the entry said "appear nowhere in the result" — and ssnet's 64 excluded. Of those 64,
44 are in the publishing project and 20 in that package's own test project, so nothing legitimate was
dropped here; a monorepo where a *different* project consumes a sibling's package would show up in
`excludedPublisherRows`. Pinned in `src/repositories/crossRepoStore.test.ts`.

---

