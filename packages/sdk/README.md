# @mcp/sdk

**Tier 1 · Stability: evolving · Depends on: `@mcp/core`, `zod`, `@modelcontextprotocol/sdk`**

The reusable tool builder and the MCP runtime. **The only package permitted to
import `@modelcontextprotocol/sdk`** — so a protocol SDK upgrade is a change to
one file here, not to every server.

## The builder family

One vocabulary across the three MCP surfaces. Every `create*` builds frozen,
protocol-free data and validates it at construction time; every `register*`
assembles many of them into the one thing `createServer` takes.

| Surface | Declare one | Assemble | Served over |
|---|---|---|---|
| Tools | `createTool` (= `defineTool`) | `registerTool` | `tools/list`, `tools/call` |
| Resources | `createResource` | `registerResource` | `resources/list`, `resources/read` |
| Prompts | `createPrompt` | `registerPrompt` | `prompts/list`, `prompts/get` |

`createServer` (= `createMcpServer`) wires them, and `runServer` owns the entry
point's start-and-exit tail.

`createTool`/`createServer` are aliases, not replacements: all four servers call
`defineTool`/`createMcpServer` and renaming those call sites would be churn.

Every `register*` takes a list whose entries may themselves be lists, so a server
passes its per-domain groups without flattening, and a duplicate name fails at
assembly rather than in the runtime a frame later:

```ts
registerTool([buildReadTools(deps), buildWriteTools(deps), buildMigrationTools(deps)])
```

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

`runServer` is the entry-point tail — start, report, exit — and the one reviewed
place that calls `process.exit`:

```ts
runServer(handle, {
  onStarted: () => eventLog.info("server_started", { config: describeConfig(config) }),
  onCrash: (error) => eventLog.error("server_crashed", { error: mapError(error) })
});
```

Set `stopOnCrash` when the server acquires state *before* `start()` — a database
handle, a file watcher — so a failed start-up still runs its shutdown hooks.

## Resources

A resource is read-addressable state a client fetches by URI instead of calling a
tool. `createResource` takes either one fixed `uri` or a family with its own
`match`, and owns the descriptor shape, the mime type, serialization, and the
not-my-URI contract:

```ts
const schemaResource = createResource({
  name: "schema",
  list: () => connections.list().map((env) => ({ uri: `schema://${env.name}`, name: env.name })),
  match: (uri) => {
    const found = /^schema:\/\/(.+)$/.exec(uri);
    return found === null ? undefined : { environment: found[1] };
  },
  read: ({ params }) => captureSchema(connections.getPool(params.environment))
});

createServer({ name, version, tools, resources: [schemaResource] });
```

Routing stays the server's own `match` rather than a template language, because
both existing providers parse more than path segments (a percent-encoded id, a
case-insensitive kind, a clamped `?limit=`) — that parser is the server's
contract, not boilerplate.

`registerResource` composes several, tries them in declaration order, and takes
the two options a provider would otherwise lose to a platform default:
`emptyOnCursor` (answer a cursored list with an empty page) and `onUnmatched`
(keep the server's own error for an unroutable URI).

A URI nothing routes yields `undefined`, which becomes the protocol's
invalid-params rejection. Anything a `read` *throws* propagates unchanged, so a
genuine read failure stays distinguishable from an unroutable URI.

## Prompts

`createPrompt` declares an argument-taking message template; every argument marked
`required` is guaranteed present by the time `render` runs.

```ts
const reviewDiff = createPrompt({
  name: "review_diff",
  description: "Review a unified diff.",
  arguments: [{ name: "diff", required: true }, { name: "focus" }],
  render: (args) => ({
    messages: [{ role: "user", content: { type: "text", text: `Review (${args.focus ?? "all"}):\n${args.diff}` } }]
  })
});

createServer({ name, version, tools, prompts: [reviewDiff] });
```

**Supplying `resources` or `prompts` is what declares the capability.** A server
with none must not advertise it, so both are optional and both are absent from the
`initialize` response until a server passes one. No server in this workspace
declares prompts yet; the wiring is covered by `builders.test.ts` over a real
client.

## Error envelopes

A server's failure shape is its own contract, so `formatError` injects it. What the
three network-facing servers *did* share — the branch order — is now
`createErrorMapper`, and the classes are **passed in, never imported here**:

```ts
export const mapError = createErrorMapper({
  validation: { type: z.ZodError, message: "Invalid arguments.", rootLabel: "(root)" },
  coded: [PolicyViolationError, BitbucketHttpError],   // classes carrying their own code
  mcpError: McpError,
  rules: [abortRule("Request to Bitbucket timed out.")]
});
```

Order is fixed: validation → coded classes → protocol error → the server's own
`rules` → `fallback`. Injection is what makes this safe under ADR-0001 — servers are
not workspace members, so a `ZodError` thrown in one is not an instance of any
`ZodError` a shared package could import. Duck-typing on `.name` would have
classified any object claiming to be one; matching the injected class cannot.

codebase-index-mcp keeps its own mapper: UPPER_SNAKE codes, a `requestId`, and a
tool-name prefix on every message make it a different envelope, and there is only
one copy of it.

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
