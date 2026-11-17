## MCP-ISSUE-137 — base-class fan-out finds an override by the subclass's FILE, so it can reach another class's same-named method

- **Status:** OPEN 2026-11-17. Found by MCP-ISSUE-133 row 5 (session adc4dd60) while writing `test:interface-dispatch`
  section 8; not fixed there (`edgeResolverContracts.ts` is outside that row's scope).
- **Scenario:** a call reaches a virtual base method (`PureRepository<T>.AddAsync`) and `resolveBaseClassDispatch`
  fans it out to the overrides in the base's subclasses. It walks subclass FILES (`subclassFilesByBaseId`) and, per
  file, takes `overrideByFileAndName.get(file + member)` — the first same-named method in that file.
- **Tool/query attempted (MCP):** none; found by a failing harness assertion (real C# extraction, scratch DB).
- **Expected vs actual:**
  - **Expected:** the override that each SUBCLASS TYPE declares (owner link), as `pickOwnedMethod` binds interface
    dispatch since MCP-ISSUE-133.
  - **Actual:** fixture with `TenantRepository : PureRepository<Tenant>`, `ScopedTenantRepository<T> : TenantRepository`
    and, in the same file, `AudienceRepository : PureRepository<Audience>` overriding `AddAsync`. A call dispatched to
    `PureRepository.AddAsync` through a `TenantRepository` fans out to `TenantRepository`'s subclass files, and the
    file of `ScopedTenantRepository` hands back `AudienceRepository.AddAsync`: a `base-class-dispatch` edge to an
    override the call never runs.
- **Impact:** wrong `base-class-dispatch` CALLS edges whenever a subclass shares a file with another class's override
  of the same member (test doubles, small hierarchies kept in one file). Callers of that unrelated override are
  over-reported; `dead_code_scan` and the impact tools read these edges. Not measured on a real repo yet.
- **Workaround used:** the row 5 fixture keeps `AudienceRepository` in its own file, so section 8 tests the receiver
  scoping it was written for.
- **Enhancement proposal:** key the override map by owner type (`parent_symbol_id`) and walk subclass TYPES
  (resolved `EXTENDS` from-ids), not files — the MCP-ISSUE-133 fix applied to the class lane. The file key stays only
  for rows with no owner link. Then add `AudienceRepository` back into the shared file in section 8 as the red case.
