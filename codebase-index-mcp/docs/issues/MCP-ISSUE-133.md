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
- **Not covered:** an implementer that INHERITS the method from a base class gets no dispatch edge (before the fix it got
  whatever same-named method its file held, if any). The call-site overload is not known; the arity comes from the
  interface method the call resolved to.
- **Tests:** `dispatchRebuild.test.ts` (3 cases), `interfaceSiblings.test.ts`, and `test:interface-dispatch` section 5
  (real C# extraction: helper type, nested type, wrong-arity overload declared first, two interfaces with a same-named
  member in one file). They fail on 44e1e9a and pass with the fix.
