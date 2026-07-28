# S-24 — `postgres-mcp` onto `@mcp/sdk`

**Date** — 2026-07-28
**Step** — S-24 (second server onto the SDK; follows the S-23 pilot)

---

## Result

`src/index.ts` went from **883 lines to 132**: a `ListTools` array of 17 hand-written
JSON Schemas, a 78-line `switch`, per-case zod parsing, two resource handlers and the error
mapper, all replaced by configuration plus a call to `createMcpServer`. The tool table now lives
in `src/tools/`, split along the boundary the handler modules already use.

| File | Lines | What it holds |
|---|---|---|
| `src/tools/common.ts` | 111 | deps bundle, annotation presets, shared zod + JSON Schema fragments |
| `src/tools/readTools.ts` | 394 | the 8 read tools, incl. the guarded read-query path |
| `src/tools/writeTools.ts` | 106 | preview → apply → rollback |
| `src/tools/migrationTools.ts` | 156 | 5 EF Core tools + `compare_environments` |
| `src/tools/index.ts` | 76 | assembles the 17 in registration order; the schema resource provider |
| `src/index.ts` | 132 | entry point only |

`write/writeHandlers.ts`, `migration/migrationHandlers.ts` and `db/introspection.ts` — about
1,300 lines of behaviour — were **not touched**. That was the point.

## What the migration was not allowed to change

| Net | Covers | Result |
|---|---|---|
| `contracts/postgres-mcp.json` | what `tools/list` advertises | names, descriptions, input schemas **byte-identical**; `annotations` added (+102 lines, 0 deletions) |
| 60-case stdio call replay | what `tools/call` returns, incl. error envelopes, plus `resources/*` and tool order | **59 of 60 byte-identical** |

The replay covered validation (17 cases), SQL guardrails (10), the write gate on and off (8),
the migration gate on and off (7), environment resolution (7), connection failure (7), the three
resource behaviours, and `tools/list` ordering. It ran against a DSN pointing at a closed port so
every database-dependent failure is deterministic.

### The one intentional change

```
before  { "code": "mcp_error",  "message": "MCP error -32601: Unknown tool: x" }
after   { "code": "not_found",  "message": "Unknown tool: x." }
```

Identical to S-23, and for the same reason: the old message leaked a JSON-RPC error number into a
tool payload. Only affects calling a tool that does not exist.

`tools/list` also gained `annotations`, additively — reviewed as a snapshot diff, which is the
workflow S-06 exists to enable. `write_apply`, `write_rollback` and `migration_apply` are the
destructive three; `migration_add` is not read-only but touches no database.

---

## The two design changes this forced in `@mcp/sdk`

S-23 needed one addition (`formatError`). S-24 needed two more, both for the same underlying
reason: the pilot was the *smallest* server, so it exercised the smallest part of the surface.

### 1. `resources`

postgres-mcp serves each environment's schema at `schema://<env>`. `createMcpServer` declared only
the `tools` capability, and the protocol SDK refuses `setRequestHandler` for an undeclared
capability — so this could not be bolted on after `createMcpServer` returned. It had to become a
first-class option, and supplying a provider is what declares the capability.

The provider interface is protocol-free, like tools. The one subtlety is how "I don't serve that
URI" is expressed: `read()` returns `undefined`, and the SDK converts that to `InvalidParams`.
Anything the provider *throws* propagates untouched. That keeps the two cases distinguishable —
an unroutable URI is a caller error (`-32602`), an unknown environment is a genuine failure
(`-32603`) — which is exactly the split the hand-written handlers had, and the replay confirms
both codes are unchanged.

### 2. `rawResult`

Dispatch's last step assumes the handler returns a *payload* to serialize. Twelve of postgres-mcp's
handlers already return a finished `CallToolResult`, and several carry envelopes a `PlatformError`
cannot express — `run_read_query`'s guardrail rejection is
`{ requestId, environment, code, message }`, and dropping `requestId` and `environment` would be a
silent contract break.

So a tool may declare `rawResult: true`, meaning "the handler owns its serialization". It is
explicit rather than inferred from the return shape: a payload that happens to have a `content`
array must not be silently treated as a wire result.

Everything before the last step still applies — validation, guards, and the whole error path are
unchanged, and there is a test for each. What `rawResult` skips is one function call.

**It is also a debt marker.** Each `true` names a handler that still owns its serialization and can
be converted later, one at a time, without touching the tool table. Four tools
(`health_check`, `list_environments`, `list_tables`, `describe_table`) already return payloads and
use the normal path, which is how we know both paths work in the same server.

This is the same mechanism-vs-policy split as `formatError` and the SQL token lists: **the pipeline
is shared, the payload contract is not.**

### Two smaller additions

- `schema.anyOf()` / `schema.null()` — `run_read_query` advertises its `params` items as a union of
  string/number/boolean/null. `JsonSchemaNode` had no `anyOf`, so the committed contract was
  literally not expressible through the builder.
- `defineTool` is now overloaded so `rawResult: true` requires a handler returning
  `ToolCallResult`.

---

## Verification

| Check | Result |
|---|---|
| 4 servers typecheck + build | **4/4 PASS** |
| 4 servers smoke test (real stdio) | **4/4 PASS** |
| `contracts:check` | **4/4 verified**, 76 tools |
| postgres call replay vs pre-migration | **59/60 identical** |
| Package tests | core 28, shared 50, sdk **50**, testing 16, cli 13 = **157** |
| Server tests | postgres **53**, observe 41, bitbucket 25 = **119** |
| `typecheck:tests` | clean |
| `verify:all` | **exit 0** |
| Platform guards | **0 errors**, 35 warnings, 312 files |

sdk +11 tests (`serverExtras.test.ts`), postgres +20.

No postgres-mcp file exceeds the 400-line soft cap any more. `src/tools/` was split at 743 lines
rather than let a file I had just written breach the 600 hard cap — the same call made for
`shared.test.ts` during the extraction work.

## Notes for S-25…S-33

1. The replay harness is per-server throwaway, but the **method** is the deliverable: group cases
   by env variant, drive one server process per group over real stdio, normalize UUIDs, diff.
   `contracts/` alone is not enough — it cannot see error envelopes, resources, or tool order.
2. Reach for `rawResult` when a handler already builds its envelope. Converting handlers to return
   payloads is a separate, later, per-handler change with its own risk.
3. Expect the `annotations` addition in the snapshot diff, and review it.
4. Two servers remain. `observe-mcp` (8 tools, read-only, 520-line entry point) is the natural
   next one. `codebase-index-mcp` (43 tools, a 2,155-line entry point) should come last and needs
   its entry point decomposed first.
