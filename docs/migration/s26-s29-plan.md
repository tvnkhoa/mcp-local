# S-26…S-29 — `codebase-index-mcp` onto `@mcp/sdk`

**Step** — the last server. Refines what the migration plan carried as a single step,
because a survey of the entry point showed it is two unrelated problems plus three
capabilities the SDK does not yet have.

> **Numbering caveat.** The S-numbers in this file are the ones used in commit messages,
> not `migration-plan.md`'s. What this file calls S-26 is the plan's **S-28**; S-27…S-29
> here correspond to the plan's **S-31…S-33** plus the SDK work. See the reconciliation
> table in [`status.md`](./status.md), which is authoritative.

---

## Why this is four steps and not one

`src/index.ts` was **2,154 lines**. The survey broke it down:

| Lines | Block | Share |
|---|---|---:|
| 168 | Header + 41 import statements | 7,8% |
| 37 | 35 env constants + `AsyncLocalStorage` | 1,7% |
| 43 | Instantiating 43 zod schemas from `schemas/toolSchemas.ts` | 2,0% |
| 63 | `server`, `store`, `watchManager`, `buildHandlerContext` | 2,9% |
| **802** | **`ListTools` — 43 tool descriptors, inline** | **37,2%** |
| 7 | `ListResources` / `ReadResource` | 0,3% |
| **226** | **`CallTool` — ALS + progress + 43-case switch + catch** | **10,5%** |
| 27 | "moved to X" breadcrumb comments | 1,3% |
| 81 | `formatChangeContextPayloadLocal` — **never referenced** | 3,8% |
| **539** | **Index run orchestration** | **25,0%** |
| 138 | Watch lifecycle, `main`, `shutdown` | 6,4% |

Two findings drive the split.

**The switch is already in `defineTool` shape.** All 43 cases are literally
`parse` → `handle(args, ctx)`; handlers live in `src/handlers/` and schemas in
`src/schemas/`. The hard part of the three previous migrations was already done here.

**A quarter of the file was never entry-point work.** `runIndexAndResolve` and its four
helpers sat in `index.ts` only because both `WatchManager` and `HandlerContext` need
them, and the entry point was the one place that already had `store` in scope.

## The three SDK gaps

These are the reason the migration itself (S-29) cannot be attempted yet.

| Gap | Where it lives today | Why the pipeline breaks it |
|---|---|---|
| **Telemetry emitted at serialize time** | `asText` → `asTextCore(payload, profile, ALS.getStore(), …)` in `src/response/responseFormatter.ts` | Shared dispatch serializes on its own. `SerializeOptions` is data (`pathKeys`, `stableKeys`), not a function — there is no seam. A naive migration silently stops all success-path telemetry, and neither the contract snapshot nor a call replay would show it. |
| **Progress notifications** | `request.params._meta.progressToken` + `extra.sendNotification` | `defineTool`'s handler has no access to `extra`. First server to need it. |
| **Server-wide pre-dispatch hook** | `maybeAutoActivateWatchFromArgs(toolName, args)`, before every call | SDK guards are per-tool. |

Also pending for S-29: the error path pretty-prints unconditionally *and* emits telemetry
with `profile: "none"`; and all 43 tools currently advertise no `annotations`, so the
snapshot diff will be the largest of the four migrations.

---

## S-26 — extract the index run orchestrator ✅

Pure movement, no SDK involved.

**Moved** to `src/indexing/`:

- `indexRunner.ts` (397) — `createIndexRunner()` returning the `runIndexAndResolve` closure
- `runPolicy.ts` (249) — `buildSkippedRunSummary`, `evaluateIncrementalSkip`,
  `resolvePerformanceProfileDecision`, `safeCrossRepoResolve`

The seam between them is write vs. no-write: `runPolicy` reads the store and queries git
and returns decisions; `indexRunner` owns every side effect. Splitting there also keeps
both files under the 400-line soft cap, which one 640-line module would not have.

**Deleted**: `formatChangeContextPayloadLocal` (81 lines, unreferenced) and ~35 lines of
breadcrumb comments left over from the earlier handler extraction.

**Also removed**: 17 import declarations and the `NODE_ENV` constant that `tsc
--noUnusedLocals` proved dead. Most predate this step — they are leftovers from when the
handlers were extracted — but they were only visible once the moved code stopped using
its own imports, so cleaning them here rather than leaving them is the honest call.

### Behaviour

Unchanged, with one thing deliberately preserved rather than simplified. Both dependencies
that used to be read from ambient state arrive as **callbacks**, not values:

```ts
resolveProgressNotifier: () => toolContextStorage.getStore()?.progressNotifier,
resolvePerformanceProfileOverride: () => parsePerformanceProfileEnv(process.env.CODEBASE_INDEX_LARGE_REPO_PROFILE)
```

The progress sink is per-request, so a value captured at start-up would always be
`undefined`. The profile override is subtler: it was read from `process.env` on *every
run*. Freezing it at start-up would be invisible in every test and almost always
equivalent — which is exactly why it is worth not doing.

That second callback exists because extracting the function surfaced a guard warning
(`env/direct-access`) that the entry point is exempt from. Moving the read to `index.ts`
returns the workspace to its previous warning count rather than adding one.

### A side effect worth naming

Declaration order is now strictly top-down: `toolContextStorage` → `store` →
`runIndexAndResolve` → `watchManager`. Previously `watchManager` was constructed at line
271 referencing a `runIndexAndResolve` declared at line 1529, working only through
function hoisting. Two temporal-dead-zone bugs have already cost this migration time; the
extraction removes the last place in this file where the ordering was load-bearing.

### Verification

| Check | Result |
|---|---|
| `typecheck` | clean |
| `tsc --noUnusedLocals` on touched files | clean |
| `build` | clean |
| `smoke-test.mjs` | pass — the graph indexes `createIndexRunner` at its new path |
| Import-cycle scan over `src/` | 1 cycle (`graphStore ↔ regexSearch`), pre-existing, none involve `src/indexing/` |
| Workspace guards | 0 errors, **34 warnings** — same as before the change |
| `npm run test` (codebase-index) | see commit |

`src/index.ts`: **2,154 → 1,447**. Still far over the 600-line hard cap; S-27 is what
addresses that.

### What this step deliberately did not do

`IndexRunResult` was added to `types.ts` and now replaces four copies of the same inline
`IndexRunSummary & { … }` intersection. That is the only type change. No handler, no
schema, and no tool descriptor was touched, which is why the contract snapshot is
untouched too.

---

## S-27 — extract the tool descriptor table

Move the 802-line `ListTools` array into `src/tools/*.ts` as plain data, grouped by the
handler module each descriptor dispatches to:

| Module | Tools |
|---|---:|
| `indexTools` | 4 |
| `searchTools` | 10 |
| `impactTools` | 10 |
| `analysisTools` | 7 |
| `refactorTools` | 6 |
| `crossRepoTools` | 2 |
| `contextTools` | 4 |

Still no `defineTool`, and the existing switch still dispatches. `contracts:check` proves
byte-identity, so the risk is close to zero. Expected: `index.ts` ≈ 700.

## S-28 — close the three SDK gaps

With tests in `packages/sdk`. Unlike S-23/S-24/S-25, where each capability was discovered
mid-migration, here the requirement is known up front — so build it first.

## S-29 — the migration

`defineTool` + `createMcpServer`. Expected: `index.ts` ≈ 120, in line with postgres (132)
and observe (63).

Verification must extend what the previous three used. Capture call responses **at all
four profiles** — both non-trivial findings so far were profile-dependent serialization
invisible to `tools/list` — and additionally **assert that telemetry is still emitted**,
which neither the snapshot nor a response replay can see.
