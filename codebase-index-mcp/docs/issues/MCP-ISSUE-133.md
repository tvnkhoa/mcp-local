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
- **Only from a proven bind (row #10b).** The inherited walk runs only when the call reached the interface method through a
  proven receiver (`resolved interface method`). An `unproven receiver` bind guesses the interface by name. The inherited
  walk turned those guesses into edges: on wec.social-ads, 9 calls on seven other repositories became edges to
  `PureRepository.AddAsync` through a guessed `ICampaignYoutubeRepository.AddAsync`, and one of them,
  `CreateMetaAudienceCommandHandler.Handle`, went past `MetaAudienceRepository`'s override. Own-member dispatch from an
  unproven bind is unchanged. The query-layer sibling walk has no bind and keeps the inherited walk.
- **Base-class fan-out (row #10b, `edgeResolverContracts.ts` `resolveBaseClassDispatch`).** The base-class pass fanned every
  CALLS edge into a virtual method out to every subclass override, including the new `interface-dispatch` edges into
  `PureRepository.Update`. That sent every `ICampaignRepository.Update` caller to `MetaAudienceRepository.Update`
  (31 edges), though the receiver is a `CampaignRepository`. Now a caller that reaches the virtual method ONLY through
  interface dispatch fans out from the implementers that dispatched to it: the subclasses of `CampaignRepository`, not of
  `PureRepository`. Those implementers are read from `planTypedDispatch`, the C#/TS dispatch plan, which
  `rebuildInterfaceDispatchEdges` also writes from. When the implementer owns the method itself, the implementer IS the
  base, and the fan-out is unchanged. A direct caller of the base keeps the base's fan-out. A dispatch row the plan does
  not explain (Python's own lane) keeps the old fan-out.
- **INDEX_VERSION** `v17-owner-dispatch-py-protocols` → `v18-inherited-dispatch`: dispatch targets change for unchanged
  files, so an index built at v17 escalates its next scoped run to FULL. Measured on a scratch copy of a v17
  wec.communication-hub index: an `incremental` request ran `mode: full`.
- **Measured** (scratch DBs, full runs, base build ad5ddd0 vs the final fix):
  - wec.social-ads @3dbf741 (4 uncommitted files in that repo, the same tree for both runs): CALLS 21 144 → 21 167,
    **+23, 0 removed**, all `interface-dispatch` → `PureRepository.Update@26`. Correct: typed `ICampaignRepository`
    fields call `Update` (e.g. `ApproveCampaignCommandHandler.Handle` line 117, `CancelCampaignCommandHandler.Handle` 95,
    `LaunchingToLaunchedJob.ExecuteAsync` 78, `PlatformCampaignService.UpdateCampaignWithPlatformInfoAsync` 118,
    `ApprovalAutoCancelJob.ExecuteAsync` 138), and `CampaignRepository : PureRepository<Campaign>, ICampaignRepository`
    has no `Update` of its own. The first cut of row #10 added 63: these 23, plus the 9 unproven-bind edges and the 31
    fan-out edges above.
  - wec.communication-hub @82347cd, mcp-local @eb7e730 (TS/JS/Py), translate @98b1bd3 (Py), ssnet @597b162 and
    wec.document-management @27bf9b8: CALLS identical at sha256 level. CommHub's only implementer without its own member
    is `ApplicationDbContext`, whose base is the framework `DbContext`.
- **Tests:**
  - `dispatchRebuild.test.ts`: inherited method, abstract root + middle override, an other-owner method in the base's
    file, an own `new` method, a cycle, a framework base token. Also: base-class fan-out restricted to the dispatching
    implementer's subclasses, a direct caller keeping the base's fan-out, and an unproven bind that does not walk.
  - `interfaceSiblings.test.ts` covers `pickInheritedMethod`.
  - `test:interface-dispatch` uses real C# extraction. Section 6: plain base, generic `RepoBase<T>`, abstract root
    overridden in the middle. Section 7: the wec.social-ads shape (`PureRepository<T>`, an inheriting implementer, an
    overriding non-implementer, and an overriding subclass of the implementer).
  - Section 6 fails at ad5ddd0; section 7 and the fan-out unit case fail at 00eaf6f. All pass with the fix.
  - `runPolicy.test.ts` covers the v18 generation and the escalation from v17.
