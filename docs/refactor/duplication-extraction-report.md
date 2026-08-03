# Duplicated Logic — Analysis and Extraction

**Date** — 2026-07-27
**Baseline commit** — `3f5b702` (folder normalization), on top of `e82bcc7` (platform foundation)
**Fidelity rule** — adopt the hardened shared implementation; document and test every delta

---

## 1. Method

Symbol-level duplication came from the code graph (`query_graph` over a freshly re-indexed
`mcp-local`: 223 files, 1,671 symbols, 0 parse failures) — **37 symbol names present in two or
more servers**. Clone detection is not something the index does, so textual divergence was
measured by normalized-line overlap and behavioural equivalence by direct A/B execution.

Every cluster went through the same four steps:

1. **Characterize first.** Run a corpus through the servers' *current* code and record every
   result — verdicts, exact messages, token strings, and crashes — as a golden snapshot.
2. **Probe the shared candidate** against that snapshot *before* touching any server.
3. **Fix the shared package** wherever it disagrees for the wrong reason.
4. **Migrate**, replay the snapshot, and account for every single delta.

Step 2 earned its place: it caught **five defects in the shared packages** before any server
depended on them, and it is what proved one extraction unsafe. A migrate-first approach would
have shipped all five as silent regressions.

**Goldens replayed at the end of the work:**

| Corpus | Observations | Unchanged | Changed |
|---|---|---|---|
| responseFormatter (3 servers × 240) | 720 | 660 | 60 — all crash → value |
| SQL guardrails (3 servers × ~50) | 151 | 148 | 3 — all the postgres bypass fix |
| Approval token (2 servers × 19) | 38 | 38 | **0** |
| mapError (2 servers × 16) | 32 | 32 | **0** |

---

## 2. What was found and what happened to it

| # | Cluster | Servers | Duplication evidence | Outcome |
|---|---|---|---|---|
| **A** | Response formatting | 4 | `normalizePayload`, `isPlainObject`, `asText`, `asError`, `ResponseProfile`. observe/postgres/bitbucket **95–97% identical** | **Extracted** → `@mcp/core` + `@mcp/sdk` |
| **B** | SQL guardrails | 3 | `stripStringsAndComments`, `hasMultipleStatements`, `findForbiddenToken`, SELECT predicate | **Extracted** → `@mcp/shared/sql`, policy injected |
| **C** | HTTP client helpers | 2 | `sleep`, `enc`, `truncate`, backoff schedule — byte-identical | **Extracted** → `@mcp/shared/http` |
| **D** | Approval HMAC | 2 | `issueApprovalToken` **byte-identical**; `verifyApprovalToken` identical but for the comparison | **Extracted** → `@mcp/shared/approval/previewToken` |
| **E** | Env parsing | 2–3 | `numberFromEnv`, `stringFromEnv`, `nonNegFromEnv` byte-identical; `parseBoolEnv` byte-identical ×2 | **Extracted** → `@mcp/core/env` |
| **F** | Error mapping | 3 / 2 | `PolicyViolationError` identical ×3; `mapError` near-identical ×2 | **Split**: class extracted; `mapError` deliberately not, *at the time* — §5, and the amendment that reversed it |
| **G** | Logging | 3 | `logInfo` / `logError` byte-identical ×3 | **Extracted** → `@mcp/core/logging` |

### Excluded as false positives

Same name, different logic. Unifying any of these would be a behaviour change disguised as
de-duplication:

- **`resolveApprovalSecret`** — three implementations, three policies. postgres-mcp generates a
  random 32-byte per-process secret when unset; codebase-index-mcp throws in strict mode and
  otherwise returns the literal `"dev-insecure-secret"`; `@mcp/shared` returns a described result.
  All three kept, and each server's test pins its own policy.
- **`mapError`** in postgres-mcp — shares a skeleton with the other two but has a different Zod
  message (`"Invalid tool input."` vs `"Invalid arguments."`), a different path fallback
  (`"root"` vs `"(root)"`), a Postgres `57014` timeout branch, and no HTTP branch. Duplicated
  **2×**, not 4×.
- **`getRepository` / `listRepositories`** — `graphStore` (SQLite rows) vs `bitbucketClient`
  (REST). Coincidental naming.
- **`constructor`, `main`** — structural noise.

---

## 3. Policy divergences preserved, not unified

The whole point of "mechanism shared, policy local". Each of these was verified to still differ
after extraction:

| Divergence | Detail |
|---|---|
| **SQL forbidden tokens** | postgres **18**, observe **13**, codebase-index **16**. codebase-index needs SQLite's `attach`/`detach`/`pragma`; postgres forbids five (`comment`, `do`, `analyze`, `reindex`, `refresh`) that observe allows. Reconciling them is a **policy decision**, not a refactor — each list is now pinned by a test that names the divergence. |
| **SQL dialect scanning** | Dollar-quoted (`$$…$$`) and escape (`E'…'`) strings are Postgres-only. Enabled for postgres, **off** for SQLite and DataFusion. |
| **Retry policy** | bitbucket-mcp will not replay a non-GET on 5xx (a POST can create a pull request); observe-mcp replays any method (its POST is a search). Shared transience *predicate*, separate policies. |
| **Approval expiry** | postgres-mcp has `ignoreExpiry` for migrations, where a snapshot-drift guard replaces the time box. codebase-index-mcp has no such flag. |
| **Boolean env parsing** | `strictFlag` (exact `"true"`/`"1"`) for write gates vs lenient `boolean` (accepts `yes`, `on`, any casing). `BITBUCKET_WRITE_ENABLED=TRUE` must **not** enable writes — verified end to end. |

---

## 4. Five defects found in the shared packages — before any server depended on them

All five were in code written during the Phase 3 foundation. Every one was caught by step 2.

| Defect | Effect had it shipped |
|---|---|
| `shouldDropNullish` was `profile !== "verbose"` | Would have stripped nulls on the **`standard`** profile. All four servers use `compact \|\| nano`, so every standard-profile response from three servers would have silently changed shape. |
| `normalizePayload` default `maxDepth = 32` | Silently rewrote real data as `"[depth-limit]"`. codebase-index-mcp emits deep graph payloads; responses would have been truncated mid-structure. Default is now unbounded — the cycle check is what prevents runaway recursion — with `maxDepth` still available opt-in. |
| No payload-shaped error wrapper | `@mcp/sdk`'s `asError` takes a `PlatformError`; the servers build their own envelope. Added `asErrorPayload`. |
| `scanSql` applied Postgres dollar-quoting unconditionally | Would have **weakened** the SQLite and DataFusion guards. Proven with a test: on a dialect without `$…$` syntax, scanning for it blanks the span between the markers and *hides* a forbidden token — `select 1 from t where a = $x$ drop $x$` goes from REJECTED to ALLOWED. "Scan more" is not automatically "safer". |
| `isRetryableStatus` is an explicit set `[408, 425, 429, 500, 502, 503, 504]` | The clients' rule is `0 \|\| 429 \|\| >= 500`. Reusing the existing predicate would have stopped retrying network failures (status `0`) and any uncommon 5xx. Added `isTransientUpstreamStatus` alongside it; both are kept because they encode different policies. |

### Plus one defect I introduced and the smoke test caught

Moving postgres-mcp's `parseBoolEnv` onto the shared reader put `envReader` in a **temporal dead
zone** — it was declared after the top-level `const WRITE_ENABLED = parseBoolEnv(...)` that uses
it, so the module threw `ReferenceError` on load. Typecheck passed. All 33 unit tests passed. Only
`scripts/smoke-test.mjs`, which actually boots the server over stdio, failed. Fixed by hoisting
the declaration above its first use.

That is the argument for keeping an end-to-end smoke test in the loop: unit tests exercise
functions, not module initialization order.

---

## 5. `mapError` — not extracted here, extracted later by injection

The one cluster where the evidence said *don't* — correctly about the approach on the table, and
wrongly about the conclusion drawn from it. The original section is kept in full below because the
measurement is still the reason a shared mapper may not import `zod`; the amendment at the end
records what the measurement did **not** prove.

`mapError` is near-identical in observe-mcp and bitbucket-mcp, and the natural home would be
`@mcp/sdk` (it needs `zod` and `McpError`, both of which `@mcp/shared` forbids by tier rule).
It cannot go there, because its two most important branches are `instanceof` checks:

```
ZodError thrown by a server's own zod:
  instanceof serverZod.ZodError  -> true
  instanceof hoistedZod.ZodError -> false      <-- measured

McpError from a server's own protocol sdk:
  instanceof serverSdk.McpError  -> true
  instanceof hoistedSdk.McpError -> false      <-- measured
```

Servers are intentionally **not** npm workspace members — that is what keeps `better-sqlite3` and
`tree-sitter` from being hoisted — so each carries its own `zod` and `@modelcontextprotocol/sdk`.
A shared `mapError` would compare against a different class object, both branches would fall
through, and **every validation error would silently degrade** from
`{code:"validation_error", message:"Invalid arguments.", detail:"name: Required"}` to
`{code:"internal_error", message:"<raw Zod JSON dump>"}`.

This was not hypothetical: an early version of the characterization harness imported `zod` from
the wrong server's `node_modules` and reproduced exactly that degradation before the real cause
was identified.

Safe to revisit once those two dependencies are deduplicated (migration-plan **S-09**), and not
before. The reasoning is recorded in a comment above each `mapError` so the next person does not
have to rediscover it.

`PolicyViolationError` **was** extracted: it is a plain `Error` subclass with no external
dependency, and `@mcp/core` resolves through a single symlink, so every importer sees the same
class object.

### Amendment — extracted 2026-08-03, and S-09 was never the blocker

*Everything above stands as a measurement. The sentence that did not stand is "safe to revisit
once those two dependencies are deduplicated, and not before."*

The constraint the measurement establishes is precise: **a shared module must not `instanceof`
against a class it imported itself.** That is a statement about who holds the import, not about
where the algorithm lives. There was a third option neither this section nor ADR 0001 considered —
pass the classes **in**:

```ts
createErrorMapper({
  validation: { type: z.ZodError, message: "Invalid arguments.", rootLabel: "(root)" },
  coded: [PolicyViolationError, BitbucketHttpError],
  mcpError: McpError,
  rules: [abortRule("Request to Bitbucket timed out.")]
})
```

`packages/sdk/src/errorMapper.ts` (`4390fa1`) imports neither `zod` nor
`@modelcontextprotocol/sdk`. Every `instanceof` runs against exactly the classes the calling server
throws, so the degradation described above cannot occur — the constraint is satisfied, not
circumvented. `bitbucket-mcp`, `observe-mcp` and `postgres-mcp` share it; `codebase-index-mcp`
deliberately does not, for an unrelated reason (a different envelope — UPPER_SNAKE codes, a
`requestId`, tool-name-prefixed messages — and only one copy of it, so there is no duplication to
remove).

**Shared: the branch order and the envelope shape. Local: every string a client can see** — which
is exactly the split §2 used to classify postgres-mcp's variant as a false positive
(`"Invalid tool input."` / `rootLabel: "root"` versus `"Invalid arguments."` / `"(root)"`). Those
differences survive as arguments.

Two corrections worth carrying forward:

- **S-09 was recorded as the prerequisite and was not one.** The cost of that inference was three
  near-identical copies kept for a week, waiting on a step that is still not done and no longer
  needs to be.
- **ADR 0001 originally proposed duck-typing (`.name` / `.code`) as the way out. Injection is
  strictly safer.** `.name` matching classifies any object that happens to be called `ZodError`;
  `errorMapper.test.ts` pins that difference with two same-named, same-shaped, unrelated classes —
  the injected one is classified, the rival one reaches `internal_error`.

The comment above each server's `mapError` now describes injection rather than the old prohibition.

---

## 6. Wiring

Shared code reaches the servers through `file:` dependencies — npm satisfies these with a
symlink, with no tree restructuring:

```json
"@mcp/core":   "file:../packages/core",
"@mcp/shared": "file:../packages/shared",
"@mcp/sdk":    "file:../packages/sdk"
```

Verified on codebase-index-mcp, the risky one: the compiled `better_sqlite3.node` binding is
**byte-identical** (md5 compared before and after), and both `better-sqlite3` and `tree-sitter`
still load.

**Ordering constraint:** `npm run build:packages` must precede any server build on a fresh clone,
because servers consume `packages/*/dist`.

---

## 7. Verification

| Check | Result |
|---|---|
| 4 servers typecheck + build | **4/4 PASS** |
| 4 servers smoke test (real stdio MCP handshake) | **4/4 PASS** |
| Package tests | core 28, shared 50, sdk 34, testing 16, cli 13 = **141** (was 112) |
| Server tests | postgres 33, observe 41, bitbucket 11, codebase-index +60 in 2 new harnesses = **145** |
| codebase-index wired harnesses | **25/25 PASS** |
| `guard:no-llm-runtime` | PASS |
| `benchmark:plan:check` | `"passed": true` |
| `typecheck:tests` | clean |
| `verify:packages` | **exit 0** |
| Platform guards | **0 errors**, 34 warnings, 300 files |
| Native bindings | byte-identical |
| External state (`~/.claude.json`) | unmodified |

The 34 guard warnings are the unchanged pre-migration server debt baseline — the same 34 as
before this work started.

### Behaviour deltas — 63 in total, every one accounted for

| Delta | Count | Direction |
|---|---|---|
| Cyclic payload no longer crashes the serializer | 30 | `RangeError` → `{"self":"[circular]"}` |
| BigInt no longer crashes the serializer | 30 | `TypeError` → `{"n":"10"}` |
| Postgres dollar-quote / escape-string bypass now rejects | 3 | `ALLOWED` → `"Only one SQL statement is allowed."` |
| Everything else | **0** | — |

No input that previously produced a value produces a *different* value. The 60 serializer deltas
all had a crash as their prior result, verified mechanically rather than by inspection. The 3 SQL
deltas are the intended security fix, on postgres only — observe-mcp and codebase-index-mcp are
byte-identical.

One more non-output change: `verifyApprovalToken` in codebase-index-mcp used
`expected !== signature`, which short-circuits on the first differing byte. It now uses
`timingSafeEqual`. All 19 characterized cases return the same verdict — the timing channel closes
with no behavioural change.

---

## 8. Net change

```
7 clusters analysed        6 extracted, 1 deliberately not (with measured proof)
4 false positives excluded (same name, different policy)

Shared-package defects found before any server depended on them   5
Defects found by the smoke test that typecheck and unit tests missed   1
Regression tests added                                          +174
Behaviour deltas                                                  63  (60 crash->value, 3 security fix)
Value-to-different-value changes                                   0
Policy divergences deliberately preserved                          5
```

**Follow-ups, unchanged by this work**

- **S-18** — reconcile the SQL token lists (18 / 13 / 16). A policy decision with security
  consequences; now trivial to compare, since all three lists sit in `guardrails/` behind one
  shared mechanism.
- **S-09** — deduplicate `zod` and `@modelcontextprotocol/sdk` across the servers. Written here as
  the thing that "unblocks the `mapError` extraction". **It was not**: that extraction shipped on
  2026-08-03 by injecting the classes instead (§5 amendment), and S-09 remains undone. Nothing else
  here depends on it.
- The 34 guard warnings (oversized entry points, scattered `process.env` in postgres-mcp's
  `migration/efRunner.ts`) remain the tracked pre-migration baseline.
