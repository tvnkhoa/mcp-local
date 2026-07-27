# @mcp/testing

**Tier 3 · Stability: evolving · Depends on: `@mcp/core`, `@mcp/sdk`**

Test harness for platform tools. Nothing in the platform may depend on this
package outside of its own tests.

## Invoke a tool without a server

The harness routes through the **real** `dispatchToolCall`, so validation, guard
evaluation, error mapping, and profile serialization are production code paths.
A test that passes here cannot pass for a reason the server would not reproduce.

```ts
import { assertToolOk, invokeTool } from "@mcp/testing";

const invocation = await invokeTool<{ things: string[] }>(listThings, { limit: 10 });
const payload = assertToolOk(invocation);
```

## Assertions

| Assertion | Checks |
|---|---|
| `assertToolOk(invocation)` | Succeeded; returns the payload typed |
| `assertToolError(invocation, code?)` | Failed, optionally with a specific error code |
| `assertNoLeak(invocation, ...secrets)` | Secret appears in neither the response nor the logs |
| `assertMinified(invocation)` | Response is minified (any profile but `verbose`) |
| `assertPosixPaths(invocation)` | No Windows separators in the response |

`assertNoLeak` deserves a place in every tool test that touches credentials —
it checks the captured log records as well as the response body.

## Captured logs

```ts
const invocation = await invokeTool(myTool, {});
invocation.logs.saw("tool_refused");     // true / false
invocation.logs.at("warn");              // records at one level
```

The memory logger uses a fixed clock, so records are byte-stable across runs.

## Contract snapshots

The regression net from the migration plan (step S-06): capture the public tool
surface as deterministic JSON and diff against it.

```ts
import { diffSnapshots, formatDifferences, snapshotTools } from "@mcp/testing";

const actual = snapshotTools("my-server", allTools);
const differences = diffSnapshots(committed, actual);
assert.equal(differences.length, 0, formatDifferences(differences));
```

Snapshots are sorted by tool name, so ordering changes are not diffs. A changed
description, schema, title, or annotation **is** a diff, and the report names
which field moved.

This module builds snapshots from `ToolDefinition`s only. Capturing one from a
*running* server belongs with the server migration, not the foundation.

## Test

```bash
npm test --workspace @mcp/testing
```
