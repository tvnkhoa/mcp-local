## MCP-ISSUE-094 — C# dispatch fan-out differed between a scoped run and a full run

- **Status:** ✅ FIXED 2026-10-22 (release L).
- **Scenario:** CommHub conformance on both the K and the L build.
  - `ef-add-column`: a scoped run lost 407 `interface-dispatch` CALLS edges.
  - `ef-shift` on K: a scoped run gained 15 `base-class-dispatch` rows.
  - K's conformance covered wec.aria (TS) only, so C# scoped runs had never been compared with full runs.
- **Causes:**
  1. **`interface-dispatch` used whatever IMPLEMENTS edges were resolved at the time.** It was written inline while a call row resolved, from the IMPLEMENTS edges resolved at that moment.
     - A full run resolves IMPLEMENTS first (`runFinalize`, full mode only).
     - A scoped run resolves them only in the post-phase, after calls. So an implementor in a re-extracted file was still an `iface:` token and missing from the fan-out.
     - A caller outside the run's scope never re-fanned, so an implementor added later was never reached.
  2. **`base-class-dispatch` only ever inserted.** It used `insert or ignore` on a table with no unique key, so it ignored nothing.
     - A full run's repo-wide dedup removed the duplicates.
     - A scoped run dedups only re-extracted files, so callers outside that set accumulated a duplicate per run.
- **Fix: both fan-outs are rebuilt whole every run**, each as a pure function of the resolved edges.
  - `rebuildInterfaceDispatchEdges` runs after IMPLEMENTS / EXTENDS resolution. Its input is the CALLS edges resolved to an interface method, plus resolved IMPLEMENTS and method symbols.
  - `resolveBaseClassDispatch` first deletes its own edges, then rebuilds.
  - Both skip a pair the caller already has a CALLS edge for, so a direct resolution wins. The result therefore does not depend on which rows a dedup pass looks at.
  - The inline fan-out and its context fields are removed from the call resolver.
- **Measured:** CommHub conformance, 6 scenarios, all EQUAL in dirty and incremental mode on L. All three dispatch scenarios are DIFFERENT on the K build, which has neither fix:

  | scenario | what it does | L | K |
  |---|---|---|---|
  | `dispatch-implementor-shift` | 3 lines on an `IInboxCardProjectionService` implementor | EQUAL | DIFF: 24 / 23 rows, `interface-dispatch` and `base-class-dispatch` |
  | `dispatch-new-implementor` | a new implementor in a new file | EQUAL; 13 dispatch edges reach it | DIFF; 0 dispatch edges reach it |
  | `dispatch-base-shift` | 3 lines on `ValueObject.cs`, an abstract base | EQUAL | DIFF: 13 / 25 rows |

  `ef-shift`, `ef-rename-property` and `ef-add-column` are EQUAL on L.
- **Guarded:**
  - `dispatchRebuild.test.ts`: idempotent; a direct edge wins; a new implementor is reached without re-resolving the caller; a token IMPLEMENTS is not an implementor; base-class dispatch never duplicates.
  - `test:interface-dispatch`, which now calls the rebuild after draining.
  - `test:base-class-dispatch`, `test:call-chain-interface`, `test:issue-052-qualified-call`.
  - Conformance scenarios `dispatch-implementor-shift`, `dispatch-new-implementor`, `dispatch-base-shift`.

