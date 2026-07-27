# @mcp/sdk

**Tier 1 · Stability: evolving · Depends on: `@mcp/core`, `zod`, `@modelcontextprotocol/sdk`**

The reusable tool builder and the MCP runtime. **The only package permitted to
import `@modelcontextprotocol/sdk`** — so a protocol SDK upgrade is a change to
one file here, not to every server.

## The tool builder

`defineTool` is the single way a tool enters the platform. It validates the
declaration at construction time, so a malformed tool fails at startup rather
than on first call, and freezes the result.

```ts
import { annotations, defineTool, schema } from "@mcp/sdk";
import { ok } from "@mcp/core";
import { z } from "zod";

export const listThings = defineTool({
  name: "list_things",                       // snake_case, stable forever
  description: "List things visible to the caller.",
  input: z.object({ limit: z.number().int().optional() }).strict(),
  inputSchema: schema.object({
    limit: schema.integer("Max rows", { maximum: 500 }),
    profile: schema.profile()
  }),
  annotations: annotations.read(),           // readOnly / idempotent / destructive
  guards: [],                                // declared gates, see below
  handler: async (input, ctx) => ok({ things: [] })
});
```

A `ToolDefinition` is a plain object with **no protocol knowledge**, which is
what makes every tool unit-testable without a server (see `@mcp/testing`).

Two schemas is deliberate: `input` (zod) validates at runtime, `inputSchema`
(JSON Schema) is what `tools/list` advertises. Keeping the advertised contract
hand-written — as all four existing servers already do — means it is exactly
what the author intended, with no generator in between.

## Guards

A guard is the declared answer to "what gates this tool?". A security review
reads the guard list, not the handler body.

```ts
import { featureFlagGuard, immutableTargetGuard } from "@mcp/sdk";

guards: [
  featureFlagGuard("write_enabled", () => config.writeEnabled, "Writes are disabled."),
  immutableTargetGuard("prod_readonly", (i) => i.environment, ["prod"], "prod is read-only.")
]
```

Guards needing a capability (an approval service, a path allowlist) are built by
the **server** from `@mcp/shared` and passed in — the SDK never imports the
capability tier, so the dependency direction holds.

## Runtime

```ts
import { createHealthCheckTool, createMcpServer } from "@mcp/sdk";

const handle = createMcpServer({
  name: "my-server",
  version: "0.1.0",
  tools: [createHealthCheckTool({ serverName: "my-server", version: "0.1.0" }), listThings]
});

await handle.start();
```

`createMcpServer` wires the stdio transport, registers `tools/list` and
`tools/call`, redirects `console.*` to stderr, and installs signal handlers.

## Dispatch pipeline

```
resolve → profile → validate → guards → handle → serialize
```

Nothing throws out of dispatch. A handler exception becomes an `internal_error`
whose detail is logged and never returned.

## Migrating a server incrementally

`LegacyBridge` lets the registry sit in front of an existing dispatcher, so
tools move a few at a time and the server is never half-broken:

```ts
createMcpServer({
  name: "my-server",
  version: "0.1.0",
  tools: migratedTools,                    // served by the registry
  legacy: { listTools, has, call }         // everything else, as before
});
```

## Test

```bash
npm test --workspace @mcp/sdk
```
