## MCP-ISSUE-133 — interface dispatch bound a call to the first same-named method in the implementer's FILE, not the implementer type's own method

- **Status:** FIXED 2026-11-16 (row #2, branch `wt/cs-dispatch`). Found 13 Nov (not filed); number reserved by the leader.
- **Scenario:** a C# call through an interface (`_store.Save(...)` with `_store: IStore`) resolves to the interface method;
  `rebuildInterfaceDispatchEdges` then fans it out to each implementation with `interface-dispatch` CALLS edges (0.7).
- **Tool/query attempted:** `find_impact_files` / `get_call_chain` / `trace_execution_flow` on an implementation reached only
  through an interface; the edges were read from a scratch index of wec.communication-hub.
- **Expected vs actual:**
  - **Expected:** one edge per implementer TYPE, to the method that type declares, and among its overloads the one with the
    interface method's arity.
  - **Actual, cause 1 (`edgeResolverCalls.ts` `rebuildInterfaceDispatchEdges`):** the implementer list was a list of
    FILES, deduplicated, and each file took `candidateMap.get(name).find(c => c.filePath === file && kind === "method")`:
    the first same-named method in the file by symbol id. In a file holding a helper type, a nested type, or a second
    implementer, that is another type's method. In a file with two implementers, only one was ever reached. Overloads
    were picked by id.
  - **Cause 2 (`resolveCallEdgesBatch`, C#/TS only):** the interface method behind a qualified `callee:IFoo.M` token was
    the first `M` in the interface's FILE. Python already used the owner link. When the interface and its implementation
    share a file, the call bound to the CLASS's method, labelled `resolved interface method` (0.8), and no fan-out followed.
  - **Cause 3 (`interfaceSiblings.ts` `findMemberMethod`, the query-layer safety net):** owner link first, but then any
    same-named method in the file, owned by another type or not.
- **Measured** on wec.communication-hub @a14089b (clean), full index into scratch DBs, base build (44e1e9a) vs fix:
  - CALLS 22 475 → 22 981; `interface-dispatch` 1 407 → 1 911 (+504, none removed).
  - 2 qualified calls whose interface and class share a file now bind the interface method and fan out:
    `ProjectionReconciliationJob.ReconcileTenantAsync` → `IProjectionReconciliationCursorService.GetOrCreateAsync`,
    `DispatchDomainEventsInterceptor.WriteOutboxEntries` → `IOutboxProjectionRebuildService.WriteOutboxEntriesAsync`.
  - Sample of added targets judged correct against the source: every one is the own method of a second or later
    implementer in a test file holding several test doubles. Examples: `NotificationPublisherSpy.PublishConversationNotificationAsync`
    beside `ThrowingNotificationPublisher` (OutboundDeliveryFailedNotifierTests.cs), `ProjectionSpy.RebuildCardAsync`
    beside `NoOpProjectionService` (ConversationTransitionEventHandlerTests.cs), `CampaignSentHandlerSender.Send`,
    `RaisingMediator.Publish`.
  - mcp-local @44e1e9a (TS/JS/Python), same comparison: the CALLS edge sets are identical (13 757 each).
- **Impact:** callers of an implementation reached only through an interface were missing, or were attributed to an
  unrelated type's method. `dead_code_scan` and the impact tools read those edges.
- **Fix:**
  - `interfaceSiblings.ts`: `pickOwnedMethod` (the owner link decides; the owner's file only for rows with NO owner link,
    an index written before `parent_symbol_id`; among overloads the first whose `parameterCount` equals the source
    method's) and `parameterCount` (top-level commas of the declaration's parameter list; generics, tuples, literals and
    strings do not count).
  - `rebuildInterfaceDispatchEdges` keeps implementer TYPES per interface and binds each through `pickOwnedMethod`. The
    fan-out cap `MAX_INTERFACE_DISPATCH_FANOUT` still counts FILES. Counting types changed which implementers survived
    the cap: `ISender` has 11 implementers in 6 files, and `CapturingSender.Send` lost 51 edges in a first measurement.
    Every type in a capped file is reached.
  - `resolveCallEdgesBatch`: the interface method is found by owner link first for every language, then by file as
    before. The Python result is unchanged; Python already did this.
  - `findMemberMethod` uses `pickOwnedMethod`.
- **TS / Java:** TS uses the same path (its implementers come from IMPLEMENTS too); mcp-local shows no change because no
  file of it holds two implementers of one interface. There is no Java lane.
- **Not covered by row #2 (fixed in row #10, below):** an implementer that INHERITS the method from a base class got no
  dispatch edge. Still not covered: the call-site overload is not known; the arity comes from the interface method the
  call resolved to.
- **Tests:** `dispatchRebuild.test.ts` (3 cases), `interfaceSiblings.test.ts`, and `test:interface-dispatch` section 5
  (real C# extraction: helper type, nested type, wrong-arity overload declared first, two interfaces with a same-named
  member in one file). They fail on 44e1e9a and pass with the fix.

### Row #10 — the method an implementer inherits from a base class (FIXED 2026-11-16, branch `wt/cs-inherit`)

- **Scenario:** `class Impl : Base, IFoo` where only `Base` declares `Do()`. A call through `IFoo.Do` got no
  `interface-dispatch` edge, because `pickOwnedMethod` looked only at `Impl`'s own members, so `Base.Do` showed no
  caller from the interface side.
- **Fix:** `pickInheritedMethod` (`interfaceSiblings.ts`). It takes the implementer's own method first, then walks the
  RESOLVED `EXTENDS` chain (in-repo class bases; for several resolved rows the first in extraction order), binding by owner
  at each step. The most-derived declaration wins, so a `Mid` override beats an abstract `Root`. A cycle, or a chain past
  16 steps, stops with no pick. `rebuildInterfaceDispatchEdges` builds the base map once (`buildClassBases`, non-Python
  classes; Python keeps its C3 MRO walk). The query-layer `expandInterfaceSiblings` uses the same walk when an implementer
  has no own member. A framework base (`base:DbContext`, external boundary) ends the chain. Cross-repo bases are out of
  scope.
- **INDEX_VERSION** `v17-owner-dispatch-py-protocols` → `v18-inherited-dispatch`: dispatch targets change for unchanged
  files, so an index built at v17 escalates its next scoped run to FULL. Measured on a scratch copy of a v17
  wec.communication-hub index: an `incremental` request ran `mode: full`.
- **Measured** (scratch DBs, base build ad5ddd0 vs fix, full runs): wec.communication-hub @93488c1, mcp-local @ad5ddd0
  (TS/JS/Py) and translate @98b1bd3 (Py) have CALLS sets identical at sha256 level. CommHub has one implementer
  without its own member (`ApplicationDbContext`), and its base is the framework `DbContext`. ssnet @597b162 and wec.document-management @27bf9b8 are also identical.
  wec.social-ads @3dbf741 (4 uncommitted files in that repo, the same tree for both runs): CALLS 21 144 → 21 207,
  **+63, 0 removed**:
  - **23 `interface-dispatch` → `PureRepository.Update@26`: correct.** Typed `ICampaignRepository` fields call `Update`
    (e.g. `ApproveCampaignCommandHandler.Handle` line 117, `CancelCampaignCommandHandler.Handle` 95,
    `LaunchingToLaunchedJob.ExecuteAsync` 78, `PlatformCampaignService.UpdateCampaignWithPlatformInfoAsync` 118,
    `ApprovalAutoCancelJob.ExecuteAsync` 138). `CampaignRepository : PureRepository<Campaign>, ICampaignRepository` has
    no `Update` of its own, so the inherited `PureRepository.Update` is what runs.
  - **9 `interface-dispatch` → `PureRepository.AddAsync@17`: right base, wrong route.** Each sits on an existing
    `resolved interface method (unproven receiver)` bind to `ICampaignYoutubeRepository.AddAsync`
    (`CampaignYoutubeRepository : PureRepository<CampaignYoutube>, ICampaignYoutubeRepository`). The callers really call
    `ITenantRepository` / `IMediaRepository` / `ISocialPlatformAccountRepository` / `ITargeting*RefRepository` /
    `IMetaAudienceRepository.AddAsync`, which those interfaces inherit from `IPureRepository<T>` and do not declare. The
    `PureRepository.AddAsync` target is what runs for an implementer that does not override it. For
    `CreateMetaAudienceCommandHandler.Handle` it is wrong: `MetaAudienceRepository` overrides `AddAsync`.
  - **31 `base-class-dispatch` → `MetaAudienceRepository.Update@64` / `.AddAsync@59`: wrong (over-approximation).**
    `resolveBaseClassDispatch` fans every CALLS edge into a virtual method out to every subclass override, including the
    new `interface-dispatch` edges into `PureRepository.Update`. The receiver behind `ICampaignRepository` is a
    `CampaignRepository`, never a `MetaAudienceRepository`. This chaining is how base-class dispatch already behaves for
    any caller of a virtual method. Row #10 gives it new inputs and does not change it (`edgeResolverContracts.ts` is out
    of this row's scope). Proposed follow-up: when the CALLS edge into the virtual method is itself `interface-dispatch`
    from implementer `K`, fan out only to overrides in subclasses of `K`.
- **Tests:** `dispatchRebuild.test.ts` (inherited, abstract root + middle override, an other-owner method in the base's
  file, an own `new` method, a cycle, a framework base token), `interfaceSiblings.test.ts` (`pickInheritedMethod`),
  `test:interface-dispatch` section 6 (real C# extraction: plain base, generic `RepoBase<T>`, abstract root overridden in
  the middle; dispatch and siblings). They fail at ad5ddd0 and pass with the fix. `runPolicy.test.ts` covers the v18
  generation and the escalation from v17.
