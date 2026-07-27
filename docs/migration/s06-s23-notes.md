# S-06 + S-23 — Contract Snapshots and the SDK Pilot

**Date** — 2026-07-27
**Steps** — S-06 (golden `tools/list` snapshots) and S-23 (pilot-migrate `bitbucket-mcp`)

---

## S-06 — golden tool-contract snapshots

`tools/list` is the public API of an MCP server: everything a client knows before calling
anything. Nothing in TypeScript catches a renamed tool, a dropped `required` entry, or a loosened
enum — the types stay valid while the contract shifts. S-06 makes that a diff.

**Delivered**

- `scripts/contract-snapshot.mjs` — starts each server over a real stdio handshake, captures
  `tools/list`, writes `contracts/<key>.json`. `--check` re-captures and exits non-zero on drift,
  naming the exact JSON path that changed.
- `contracts/` — four snapshots, **76 tools** (43 / 17 / 8 / 8), plus a README.
- `npm run contracts:check`, `npm run contracts:update`, and `npm run verify:all`
  (= `verify:packages` + `contracts:check`).

**Determinism**, without which a snapshot is just noise:

- The server list comes from `scripts/lib/manifest.mjs`, so a new server is picked up for free.
- Every env var the manifest declares is overridden: required vars and one representative per
  `group` get a fixed placeholder; **everything optional is unset** so the server uses its own
  defaults. A developer's real credentials can neither leak into a snapshot nor change it.
- Tools are sorted by name and all object keys sorted, so the diff shows meaning, not ordering.

Two things this got wrong on the first attempt, both worth recording:

- A generic placeholder for *optional* vars is not harmless. `PG_ALLOWED_ENVIRONMENTS=<junk>` is a
  filter that matches nothing, and postgres-mcp refuses to start. Optional vars must be unset.
- A connection string has to actually parse. `CH_DB_CONNECTION` needs a real `postgres://` URI
  shape even though nothing ever connects.

**Verified**: two consecutive `--check` runs agree; a deliberate one-word edit to a tool
description is caught and localised to `tools.0.description`; exit code is 1 on drift and 0 when
clean; no absolute path, machine name or credential appears in any snapshot.

**Finding:** tool advertisement is *not* env-dependent in any server. Write-gated tools
(`create_pull_request`, `write_preview`, `migration_apply`) are always listed and the gate is
enforced at call time. That is why one snapshot per server is sufficient — checked by listing
tools with the write flags both off and on.

---

## S-23 — `bitbucket-mcp` onto `@mcp/sdk`

The smallest server (8 tools, no native dependencies), chosen so the pattern is established
cheaply before the larger ones follow.

**Before** — a 505-line `index.ts`: a hand-written `ListTools` array, a `switch` dispatcher, and
per-case zod parsing.
**After** — `src/tools.ts` declares the tool table as data via `defineTool`; `src/index.ts` is a
60-line entry point that wires config, client and `createMcpServer`. Dispatch, validation, guards
and serialization come from the shared pipeline.

### What the migration was not allowed to change

Two safety nets, because they cover different halves of the contract:

| Net | Covers | Result |
|---|---|---|
| `contracts/bitbucket-mcp.json` | what `tools/list` advertises | names, descriptions, input schemas **byte-identical**; `annotations` added |
| `src/tools.test.ts` (from an 18-case pre-migration capture over real stdio) | what `tools/call` returns, including error envelopes | **17 of 18 byte-identical** |

### The two intentional changes

**1. `tools/list` now carries annotations.** Additive; no field was removed or altered. The SDK
derives `readOnlyHint` / `idempotentHint` / `destructiveHint` / `openWorldHint` from each tool's
declared annotations, and clients use them to decide what can be auto-approved.
`create_pull_request` is correctly the only non-read-only tool. Reviewed as a snapshot diff, which
is exactly the workflow S-06 exists to enable.

**2. An unknown tool reports `not_found` instead of `mcp_error`.**

```
before  { "code": "mcp_error",  "message": "MCP error -32601: Unknown tool: x" }
after   { "code": "not_found",  "message": "Unknown tool: x." }
```

The old message leaked a JSON-RPC error number into a tool payload. Only affects calling a tool
that does not exist.

### The design change this forced in `@mcp/sdk`

`dispatchToolCall` rendered every failure as a `PlatformError` payload. Adopting it as-is would
have rewritten **every error response** of every server — a change `tools/list` cannot reveal, and
one no client asked for.

So dispatch gained an optional `formatError(error, profile)` hook, surfaced through
`createMcpServer`. Dispatch decides *that* a call failed; the server decides how that failure
looks on the wire. It receives the most informative value available — the raw `ZodError` for a
validation failure, the original thrown value for a handler crash, a `PlatformError` for refusals
dispatch itself raises — and a `formatError` that throws degrades to the default rather than
becoming a protocol-level rejection.

`bitbucket-mcp` passes `asErrorPayload(toWireError(error), "verbose")`, which is precisely what
its hand-written `catch` did. This is the same mechanism-vs-policy split already applied to SQL
token lists and retry rules: **the pipeline is shared, the error vocabulary is not.**

### The write gate stayed inline, deliberately

`create_pull_request` checks `config.writeEnabled` inside the handler rather than as a
`featureFlagGuard`. A guard runs *before* the handler, so it would also block `dryRun:true` — and
a preview must work when writes are off. Pinned by a test.

### Two bugs the harness caught that types did not

Both are the same class — a `const` in its temporal dead zone — and both compiled cleanly:

- Splitting the tool table into a factory left `const UUID_RE` *after* the factory's `return`, so
  it was never initialised. Every reviewer-bearing `create_pull_request` failed with
  `Cannot access 'UUID_RE' before initialization`. Caught by the call-response replay, fixed by
  hoisting it to module scope, and now pinned by a test.
- (Earlier, in the same session) postgres-mcp's `envReader` had the identical problem and was
  caught only by the smoke test.

Typecheck and unit tests pass in both cases. Only executing the real module catches them — which
is the argument for keeping both the smoke test and the response replay in the loop.

---

## Verification

| Check | Result |
|---|---|
| 4 servers typecheck + build | **4/4 PASS** |
| 4 servers smoke test (real stdio) | **4/4 PASS** |
| `contracts:check` | **4/4 verified**, 76 tools |
| Package tests | core 28, shared 50, sdk 39, testing 16, cli 13 = **146** |
| Server tests | postgres 33, observe 41, bitbucket **25** = 99 |
| `typecheck:tests` | clean |
| `verify:all` | **exit 0** |
| Platform guards | **0 errors**, 34 warnings, 304 files |

---

## What this unblocks

`bitbucket-mcp` is now the reference for S-24…S-33. The pattern for each remaining server:

1. Capture its call responses the way `bb-calls` did — `contracts/` alone is not enough, because
   it cannot see error envelopes.
2. Declare tools with `defineTool`; keep descriptions and input schemas verbatim.
3. Pass the server's existing error mapper as `formatError`.
4. Keep the entry point free of anything that needs testing.
5. Expect the `annotations` addition in the snapshot diff and review it.

`postgres-mcp` (17 tools, write + migration gates) is the natural next one; `codebase-index-mcp`
(43 tools, a 2,154-line entry point) should come last and needs its entry point decomposed first.
