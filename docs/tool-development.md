# Tool Development Guide

Adding, changing, or removing an MCP tool. Everything here is `@mcp/sdk`; the reference for the
package itself is `packages/sdk/README.md`.

A tool's public contract is **three** things, and only the first is snapshotted:

1. what `tools/list` advertises — name, description, `inputSchema`, annotations
2. what a successful call returns
3. what a **failed** call returns

`contracts/` covers (1). `<server>/src/tools/tools.test.ts` is where (2) and (3) get pinned, and it
is not optional: a refactor can keep the advertised contract byte-identical while changing every
response.

---

## 1. Declare it

```ts
import { ok } from "@mcp/core";
import { annotations, defineTool, schema } from "@mcp/sdk";
import { z } from "zod";

export const listThings = defineTool({
  name: "list_things",                 // snake_case, verb-first, permanent
  title: "List things",                // optional, human-facing
  description: "List things visible to the caller.",
  annotations: annotations.read(),
  inputSchema: schema.object(
    {
      limit: schema.integer("Max rows", { minimum: 1, maximum: 500 }),
      profile: schema.profile()
    },
    { required: [] }
  ),
  input: z
    .object({
      limit: z.number().int().min(1).max(500).default(50),
      profile: responseProfileSchema.optional()
    })
    .strict(),
  guards: [],
  handler: async (args, ctx) => ok({ things: [] })
});
```

`defineTool` validates at **construction time** and freezes the result, so a malformed tool fails at
startup rather than on first call. It rejects:

- a name that is not `^[a-z][a-z0-9]*(_[a-z0-9]+)*$`
- an empty description
- an `inputSchema` that is not `type: "object"`
- annotations missing any of `readOnly` / `idempotent` / `destructive`
- `readOnly: true` together with `destructive: true`

`createTool` is an alias for `defineTool`; both exist so `createTool` / `createResource` /
`createPrompt` / `createServer` read as one vocabulary. All four servers call `defineTool`.

### Why two schemas

`input` (zod) is the **runtime** contract — it validates, applies defaults, and rejects unknown keys
with `.strict()`. `inputSchema` (JSON Schema) is what `tools/list` **advertises**. Keeping the
advertised contract hand-written means it is exactly what the author intended, with no generator in
between.

They can disagree, and that is a real hazard. Prefer `.strict()`, and be careful with
`.default(x).optional()` — `.optional()` short-circuits an absent value *before* the default applies,
which is the exact defect backlog **B-03** tracks: `list_repositories` declares
`profile: …default("compact").optional()`, so `profile` reaches its handler as `undefined` and it
answers at `standard` while dispatch would have answered at `compact`.

### `schema.*` builders

| Builder | Emits |
|---|---|
| `schema.object(props, { required, additionalProperties, description })` | `additionalProperties` defaults to **false** |
| `schema.string/number/integer(desc, extra)` | `extra` takes `minimum`, `maxLength`, … |
| `schema.boolean(desc)` · `schema.enumOf(values, desc)` | `enumOf` infers the advertised `type` from the first member |
| `schema.array(items, desc, { minItems, maxItems })` | |
| `schema.anyOf(members, desc)` | emits no sibling `type` — that would narrow the union |
| `schema.null()` | only meaningful inside `anyOf` |
| `schema.profile()` | the standard `nano \| compact \| standard \| verbose` argument |
| `EMPTY_OBJECT_SCHEMA` | for a tool taking no arguments |

`oneOf` is typed on `JsonSchemaNode` but has no builder — `codebase-index-mcp` publishes it on
parameters accepting either a scalar or an array of that scalar.

---

## 2. Annotate it honestly

Clients use these hints to decide what may be auto-approved. **A wrong one is a safety bug, not a
documentation bug.**

| Field | Means |
|---|---|
| `readOnly` | performs no state change of any kind |
| `idempotent` | calling twice with the same input has the same effect as once |
| `destructive` | may remove or overwrite existing state |
| `openWorld` | interacts with systems outside this machine (default `false` — local-first) |

Presets:

```ts
annotations.read()        // readOnly ✓  idempotent ✓  destructive ✗  openWorld ✗
annotations.readRemote()  // readOnly ✓  idempotent ✓  destructive ✗  openWorld ✓
annotations.preview()     // a preview step: computes a plan, changes nothing
annotations.apply()       // an apply step: changes state and may overwrite
annotations.create()      // creates without removing; openWorld ✓
```

Pick by what the tool actually does, not by which preset is nearest. The judgement calls made for
`codebase-index-mcp` are worth reading as precedent:

| Tool | readOnly | idempotent | destructive | Reasoning |
|---|---|---|---|---|
| `index_repository` | no | yes | **yes** | replaces symbols/edges and prunes on `mode:"full"` — but only derived state |
| `watch_repo` | no | yes | no | starts/stops a watcher; removes nothing. A running watcher later triggers re-indexes, but the hint describes the *call* |
| `refactor_replace_apply` | no | no | **yes** | the only tool that edits the user's source files |
| `refactor_replace_rollback` | no | yes | **yes** | overwrites working-tree files too; being the undo does not make it safe unprompted |
| `refactor_replace_preview`, `rename_assist` | yes | **no** | no | write nothing, but mint a `previewId` + approval token per call |

`openWorld: false` throughout that server, because it touches only the local filesystem and a local
SQLite file. Copying `postgres-mcp`'s presets would have got that field wrong.

---

## 3. Gate it

A guard is the **declared** answer to "what gates this tool?". A security review reads the guard
list, not the handler body.

```ts
import { featureFlagGuard, immutableTargetGuard } from "@mcp/sdk";

guards: [
  featureFlagGuard("write_enabled", () => config.writeEnabled, "Writes are disabled."),
  immutableTargetGuard("prod_readonly", (i) => i.environment, ["prod"], "prod is read-only.")
]
```

Guards run **after** validation and **before** the handler, in declaration order, stopping at the
first refusal. A guard that throws is a refusal — `runGuards` converts it via `toPlatformError`.

Write a custom one with `defineGuard(name, check)`; `check` returns `Result<void, PlatformError>`.

A guard needing a capability — an approval service, a path allowlist — is built by the **server**
from `@mcp/shared` and passed in. The SDK never imports the capability tier, so the dependency
direction holds.

### The destructive-operation pattern

Every destructive capability in this workspace follows the same shape (target-architecture S7/S8):

```
<flag>_ENABLED=false by default, parsed strictly (exact "true" or "1")
        ↓
preview  → computes a plan, mints a previewId + HMAC approval token bound to it
apply    → verifies the token against the previewed plan
rollback → restores
```

`@mcp/shared/approval` provides the mechanism (`createApprovalService`, `issuePreviewToken`,
`verifyPreviewToken`). Tokens are bound to a subject, so a token issued for one preview cannot apply
another. When no secret is configured, `resolveApprovalSecret(undefined)` generates an ephemeral
per-process one — tokens then do not survive a restart, which is a safe default rather than a
failure.

---

## 4. Handle it

```ts
handler: async (args, ctx) => {
  ctx.logger.info("listing", { limit: args.limit });   // stderr; never stdout
  if (nothingFound) return err(notFound("No things matched."));
  return ok({ things });
}
```

`ToolContext` carries `logger` (already child-scoped with `tool` and `requestId`), `profile`,
`requestId`, and optionally `signal`.

**Return a payload, not a serialized result.** Dispatch resolves the profile from the raw arguments
and serializes for you. Returning `err(platformError)` is a clean failure; throwing is caught and
becomes `internal_error` with the detail logged and never returned.

### The dispatch pipeline

```
resolve → profile → validate → guards → handle → serialize
```

Nothing throws out of dispatch. Every failure path returns `isError: true` with a stable code.

### `rawResult: true` — the escape hatch

A handler may build the wire result itself:

```ts
defineTool({ …, rawResult: true, handler: async (args, ctx) => ok(myOwnCallToolResult) })
```

It exists so a server arriving with handlers that already own their envelope can adopt the SDK
without rewriting all of them — which is the behaviour change a migration must not make. It is
**migration debt**, and it reads as such: all 43 `codebase-index-mcp` tools are still `rawResult`,
which is why their profile resolution disagrees with dispatch's (backlog B-03).

Do not use it for new tools. If your serialization step has a side effect — telemetry, a stamped
request id — the seam for that is `renderResult` on the server, not `rawResult` on the tool.

---

## 5. Errors

Every failure leaves a server in that server's envelope, and the envelope is per-server, not
platform-wide. Three of the four use `createErrorMapper`:

```ts
export const mapError: (error: unknown) => MappedError = createErrorMapper({
  validation: { type: z.ZodError, message: "Invalid arguments.", rootLabel: "(root)" },
  coded: [PolicyViolationError, BitbucketHttpError],
  mcpError: McpError,
  rules: [abortRule("Request timed out.")]
  // no `fallback`: the platform default is internal_error carrying the thrown value's message.
  // Supply one if upstream errors here can carry a secret.
});
```

Branch order is fixed: **validation → coded classes → protocol error → the server's own `rules` →
fallback**.

The classes are **passed in, never imported by the SDK**. Per [ADR 0001](adr/0001-workspace-native-deps.md)
each server owns its own `zod`, so a `ZodError` thrown in a server is not an instance of any
`ZodError` a shared package could import. `errorMapper.test.ts` pins a same-named, same-shaped
`RivalZodError` reaching `internal_error` — which `.name` duck-typing would have misclassified.

### `toWireError` sits in front of the mapper

```ts
export function toWireError(error: unknown): MappedError {
  if (isPlatformError(error)) return { code: error.code, message: error.message };
  return mapError(error);
}
```

Unwrapping a `PlatformError` first is what makes an unknown tool answer `not_found` rather than
`internal_error` — telling a caller their own mistake is a defect in the server. It is deliberately
*not* part of `createErrorMapper`: "platform errors take precedence" is a per-server decision.

`codebase-index-mcp` keeps its own mapper: UPPER_SNAKE codes, a `requestId`, and a tool-name prefix
on every message make it a different envelope, and there is only one copy of it.

---

## 6. Register it

```ts
export function buildTools(deps: Deps): readonly AnyToolDefinition[] {
  return registerTool([buildReadTools(deps), buildWriteTools(deps), buildMigrationTools(deps)]);
}
```

`registerTool` flattens nested groups and **rejects a duplicate name at assembly** — at start-up —
rather than letting one tool silently shadow another at call time.

Every server exposes `health_check` with an identical SDK-supplied shape, so `mcp:doctor` and the
smoke tests need no per-server special cases:

```ts
createHealthCheckTool({
  serverName: "my-server",
  version: "0.1.0",
  describeConfig: () => describeConfig(config),
  probe: async () => { /* returning an error marks the server degraded, not down */ }
})
```

Return an error from `probe` rather than throwing — a health check must always answer.

---

## 7. Test it

Two layers, both required for a new tool.

### Unit — the definition and the envelope

`<server>/src/tools/tools.test.ts` dispatches exactly as `index.ts` wires it, so the envelope under
test is the one a client actually receives:

```ts
const bodyOf = async (name: string, args: Record<string, unknown>) => {
  const registry = createToolRegistry(buildTools(config));
  const result = await dispatchToolCall(registry, name, args, {
    logger,
    formatError: (error) => asErrorPayload(toWireError(error), "verbose")
  });
  return { isError: result.isError, payload: JSON.parse(result.content[0]?.text ?? "null") };
};
```

At minimum, pin:

- every tool is snake_case, has a non-empty description, and declares all three annotations
- `health_check` is present
- the happy path returns what it claims
- the zod schema **rejects** what it should — an empty string, an extra key
- a bad argument is `validation_error` with readable issues, not a raw zod dump
- an unknown tool is `not_found`

### With `@mcp/testing`

```ts
const invocation = await invokeTool(myTool, { limit: 10 });
assertToolOk(invocation);
assertNoLeak(invocation, config.apiToken);   // checks the captured LOGS too
assertPosixPaths(invocation);
```

`assertNoLeak` belongs in every tool test that touches a credential.

### Integration

`node scripts/smoke-test.mjs` performs a real stdio handshake and lists tools. It is the check that
catches what typecheck and unit tests cannot: module initialization order, transport wiring, startup
failure. **It runs `dist/`, so build first.**

---

## 8. Update the contract

A change to `tools/list` — a new tool, a renamed one, an edited description or schema, added
annotations — makes `contracts:check` fail. That is the design: it turns *"did I change the API?"*
from a review judgement into a mechanical answer.

```bash
cd <server> && npm run build && cd ..
npm run contracts:update -- --server <key>    # re-snapshot
git diff contracts/                            # READ THIS — it is the contract change
npm run generate:all                           # tool lists → env → README blocks
npm run verify:all
```

The snapshotter overrides every manifest-declared env var with a fixed placeholder, and sorts tools
and object keys, so a developer's real credentials can neither leak into a snapshot nor make one
machine's output differ from another's.

**Never re-snapshot to make a red check green.** Read the diff first; if the change was not
intended, it is a defect you just caught.

---

## 9. Removing or renaming a tool

A tool name is a permanent contract — clients call it as `mcp__<serverKey>__<tool>`. Renaming one is
a breaking change for every agent config, skill and doc that names it. If you do:

1. rename in the tool declaration and its handler
2. `npm run build` in the server
3. `npm run contracts:update -- --server <key>` and read the diff
4. `npm run generate:all` — the tool list, the README block and the installed skill all follow
5. grep the docs and `<server>/skill/SKILL.md` for the old name
6. `npm run mcp:update -- --server <key>` to reinstall the skill

---

## Checklist

- [ ] snake_case name, verb-first, non-empty description
- [ ] `annotations` chosen by what the tool does, not by nearest preset
- [ ] zod `input` is `.strict()`; `inputSchema` matches it
- [ ] every gate is a declared `guard`, not an `if` in the handler
- [ ] handler returns `ok(payload)` — no `rawResult` for new tools
- [ ] destructive? then `preview → apply → rollback` behind an env flag and an HMAC token
- [ ] no `console.log` anywhere — stdout is the transport
- [ ] no secret in a response, a log line, or `describeConfig`
- [ ] tests: definition, happy path, rejection, error envelope, `assertNoLeak`
- [ ] `contracts:update` + read the diff, then `generate:all`
- [ ] `npm run verify:all` exits 0

---

## Related

- [Server Development Guide](server-development.md) — the server around the tool
- [Package Overview](packages.md) — `@mcp/sdk`'s full surface
- `packages/sdk/README.md` — the SDK reference, including resources and prompts
- `contracts/README.md` — what the golden snapshots are and how to update them
- `.claude/skills/mcp-tool-annotations/` · `mcp-error-taxonomy/` · `mcp-contract-conformance/`
