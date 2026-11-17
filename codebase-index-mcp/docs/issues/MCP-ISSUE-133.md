## MCP-ISSUE-133 — interface dispatch bound a call to the first same-named method in the implementer's FILE, not the implementer type's own method

- **Status:** FIXED 2026-11-16 (row #2, branch `wt/cs-dispatch`); row #10 2026-11-16; row 5 2026-11-17 (branch
  `wt/inherit-dispatch`, below). Found 13 Nov (not filed); number reserved by the leader.
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

### Row 5 — a call on a method the receiver's interface only INHERITS (FIXED 2026-11-17, branch `wt/inherit-dispatch`)

- **Scenario:** `interface ITenantRepository : IPureRepository<Tenant>`, where only `IPureRepository<T>` declares
  `AddAsync`. `tenants.AddAsync(t)` with `tenants: ITenantRepository` reached `resolveCallEdgesBatch` as
  `callee:ITenantRepository.AddAsync`. Found by row #10 (wec.social-ads, `ITenantRepository.AddAsync`).
- **Actual, cause 1:** the interface's own member was looked up by owner, then by the interface's FILE with any owner.
  `ITenantRepository` declares no `AddAsync`, so the file match bound a same-named member of ANOTHER interface in that
  file (`IAuditLog.AddAsync` in the harness), labelled proven (0.8). With no match in the file, nothing walked the base
  interfaces: the qualified token fell through to the name-only lane.
- **Cause 2:** the bare `callee:AddAsync` half of the same call site (the C# extractor emits both) bound by name to
  whichever interface method sorted first (`ICampaignYoutubeRepository.AddAsync`) as `resolved interface method
  (unproven receiver)`. MCP-ISSUE-052's suppression did not overrule it: it only overruled the two `resolved callee by
  name` labels, so the guess and its `interface-dispatch` fan-out stayed even when the qualified half was proven.
- **Fix:**
  - `interfaceBaseNames` (`interfaceSiblings.ts`): an interface's base list read from its stored signature (C# `:`
    list up to a `where` clause, TS `extends` list up to `{`; generic arguments and namespace qualifiers dropped).
    The C# extractor emits no edge for an interface's base list, so the signature is the only record of it.
  - `buildInterfaceBases` (`edgeResolverCalls.ts`) binds each base name like any call-lane name (same file, imported
    file, tie-break) into `CallResolutionContext.interfaceBasesById`.
  - `pickInterfaceMethod`: the receiver's own member by owner, else breadth-first up its base interfaces (nearest
    declaration wins; base-list order between equals; 64-interface cap, cycles stop). Every step binds by owner as
    `pickOwnedMethod` does; the file match is only for rows with no owner link. C#/TS only; Python is unchanged.
  - `SUPPRESSIBLE_BARE_REASONS` adds `resolved interface method (unproven receiver)`: a bare guess that landed on an
    interface yields to its proven qualified sibling, as a bare name guess already did.
  - **Receiver-scoped fan-out.** The bound edge targets the BASE's method (`IPureRepository.AddAsync`), so the
    dispatch fan-out took every implementer of the base and, through row #10b, the base-class fan-out went into
    `MetaAudienceRepository`'s overrides for calls made on `ITenantRepository` (27 edges on wec.social-ads in a first
    cut). The resolved row now carries `assigned_expression = 'iface-via:<receiver interface id>'`
    (`IFACE_VIA_MARK`; `unifyInterfaceVia` gives every interface-bind row of one caller and target the same value, so
    `deduplicateResolvedEdges`, which groups by that column, still collapses them). `planTypedDispatch` fans out from
    the receiver's implementers and those of interfaces deriving from it. A proven call through the declaring
    interface itself clears the marker and keeps the whole set. The column's other readers do not see it:
    `getFieldAccesses` reads PROPERTY_* rows only and the Python lanes match `pyrecv:` / `pyargs:` / `pyset`.
- **Limitation:** a base list wrapped onto a later line, or an interface whose declaration starts with an attribute
  line (`[ServiceContract]`), has no base names in its signature, so the walk stops there (a missed bind, never a
  wrong one). Counted: wec.social-ads 0 and wec.communication-hub 0 of either shape; wec.be 3 attribute-prefixed
  interfaces, 0 wrapped.
- **INDEX_VERSION** `v18-inherited-dispatch` → `v19-inherited-iface-method`: CALLS change for unchanged files.
- **Measured** (scratch DBs, full runs; base = `dist/base-row5` built from 235e091 sources, fix = the row's build):
  - wec.social-ads @3dbf741 (4 uncommitted files there, the same tree for both runs): CALLS rows 21 167 → 21 065.
    Removed 168 `resolved interface method (unproven receiver)` + 162 `interface-dispatch` (the wrong guesses —
    `ICampaignApprovalRepository.Update/GetByIdAsync/Add` 92, `ICampaignYoutubeRepository.AddAsync` 9, … — and
    their fan-out). Added 32 `resolved interface method` (the inherited binds: `IPureRepository.AddAsync / Update /
    GetByIdAsync / ExistsAsync` through `ITenantRepository`, `IMediaRepository`, …; `IFileStorageService.UploadFileAsync`
    through `IPublicFileStorageService`) + 32 `interface-dispatch` (`PureRepository.*`, and
    `PublicS3FileStorageService.UploadFileAsync`, the only implementer of `IPublicFileStorageService`) + 164 bare rows
    demoted to `superseded by qualified call`. No `base-class-dispatch` edge was added.
  - wec.communication-hub @8d94c68 (clean): 23 950 → 23 905. Removed 20 unproven binds + 45 of their dispatch edges,
    each a bare guess its qualified sibling disproved (sampled against source: `_identityService` is
    `IIdentityService`, not `IIdentityAuthorizationClient`; `_customerSuggestCache` is `ICustomerSuggestCache`, not
    `IConversationSuggestCache`; `_labelResolver` is `INotificationLabelResolver`, not `ICustomerDisplayNameResolver`;
    `ConversationEmailSenderResolver.ResolveAsync` is a static class call). No inherited-interface call in that repo.
  - mcp-local @9b3867f (TS/JS/Py): CALLS identical at sha256 level (14 403 rows), base and fix run back to back.
- **Tests:** `test:interface-dispatch` section 8 (real C# extraction: the inherited `AddAsync` through `ITenantRepository`
  and a derived generic `IScopedTenantRepository<T>`, a same-file `IAuditLog.AddAsync`, a decoy
  `ICampaignRepository.AddAsync` sorting first, and an overriding non-implementer `AudienceRepository`) — red at 235e091
  (`IAuditLog.AddAsync` + `ICampaignRepository.AddAsync (unproven receiver)`), green with the fix.
  `interfaceSiblings.test.ts` covers `interfaceBaseNames` and `pickInterfaceMethod`; `dispatchRebuild.test.ts` covers
  `unifyInterfaceVia`; `runPolicy.test.ts` the v19 generation and the escalation from v18.
- **Found on the way:** MCP-ISSUE-137 (base-class fan-out finds an override by the subclass's FILE).
- **Review fixes (row 5 review, on top of the merge):**
  - When the bare half of a call site guessed the SAME method its qualified half proved, the bare row (unproven)
    carried the marker, but `interfaceCalls` read the marker only from proven rows and counted the bare row as plain.
    The dispatch rebuild runs before the dedup that collapses the two rows, so the call took every implementer of the
    base, and the base-class fan-out reached an override the receiver never runs. `via` and `plain` now read the marker
    from any interface-bind row. `test:interface-dispatch` section 9 covers it: no decoy, the bare token ties onto
    `IPureRepository.AddAsync`, the dedup runs. It is red at b50f5f2.
  - The resolve UPDATE wrote `assigned_expression` for every interface-bind row, so a Protocol-typed Python call lost
    its `pyargs:` / `pyrecv:` / `pyobj` hint. Now the column is written only to set a marker or to clear a stale one.
    `dispatchRebuild.test.ts` covers this (red at b50f5f2).
  - **TS / Java:** the walk runs for every non-Python file. The TS extractor emits no receiver-qualified token today
    (`s.read()` on `s: Store` gives a bare `callee:read`), so the walk does not fire from TS extraction yet. A
    resolver-level unit case drives it with a `.ts` qualified token: `Store extends Reader`, and the call binds
    `Reader.read`, never `Audit.read` from `Store`'s file. There is no Java lane.
- **Residual, not fixed:** base names are matched by simple name, generic arity and namespace dropped:
  - `IRepo<T>` and a non-generic `IRepo` are one name.
  - Two interfaces with one name in two namespaces are told apart only by the call lane's file tie-break (same file,
    imported file, then path order).
  - `interface IFoo : Other.Ns.IFoo` (a base with the interface's own simple name) is dropped as a self-reference.
