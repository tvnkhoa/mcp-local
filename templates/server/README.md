# __DIR__

__DESC__

Scaffolded by `npm run new:server`. **Not yet registered** — see *Register* below.

## Commands

```bash
npm run build          # tsc -> dist/
npm run typecheck
npm run test           # node:test over src/**/*.test.ts
npm run smoke          # end-to-end over a real stdio handshake (needs a build)
npm run dev            # tsx, no build
```

## Configuration (env)

<!-- BEGIN GENERATED: env-table -->
<!-- END GENERATED: env-table -->

The table above is generated from `@mcp/manifest` once this server is registered — do not edit it
by hand. Until then it is empty. Add the contract to
`packages/manifest/src/envSpecs/__CAMEL__.ts`, then run `npm run generate:all`.

## Tools

<!-- BEGIN GENERATED: tool-list -->
<!-- END GENERATED: tool-list -->

Also generated, from `contracts/__KEY__.json`. Describe usage in prose here; the list itself is
derived.

## Register

Four steps, run from the workspace root, in this order — each one produces what the next reads:

```bash
# 1. Add the manifest entry + env contract, with a TEMPORARY tool list
#    - packages/manifest/src/servers.ts        (one entry, tools: ["health_check"])
#    - packages/manifest/src/envSpecs/__CAMEL__.ts   (the env contract)
npm run build:packages

# 2. Snapshot the tool contract (needs a build; writes contracts/__KEY__.json)
npm run build --prefix __DIR__
npm run contracts:update -- --server __KEY__

# 3. Derive the tool list, then switch the entry to tools: toolsFor("__KEY__")
npm run generate:tools
npm run generate:all

# 4. Install it
node scripts/install-mcp.mjs --server __KEY__
```

`packages/manifest/src/servers.ts` throws at import time if `toolsFor` finds no generated tool list,
and `contract-snapshot.mjs` only snapshots servers already in the manifest — hence the temporary
`tools: ["health_check"]` in step 1. See the `mcp-skill-authoring` skill for the full contract.

## Conventions this scaffold already follows

- The standard structure: `src/{tools,resources,prompts,middleware,services,repositories,config,types}/`
  plus `src/index.ts`. A folder is created only when it has content — this scaffold ships
  `tools/`, `middleware/` and `config/`, and you add the rest as the server grows.
- `src/config/` is the **only** place `process.env` is read (`guard:deps` enforces it).
- `src/middleware/errors.ts` owns the `{ code, message, detail? }` wire envelope; `src/middleware/`
  is where cross-cutting call-pipeline concerns live (guardrails, serialization, error mapping).
- Tools are declared as data in `src/tools/index.ts` and dispatched by `@mcp/sdk` — no hand-written
  `switch`. Each surface uses the same `create*` / `register*` pair: `defineTool` + `registerTool`
  for tools, `createResource` + `registerResource` for resources, `createPrompt` + `registerPrompt`
  for prompts. `register*` rejects a duplicate name at assembly, so it fails at start-up rather
  than at call time. See `packages/sdk/README.md` for the full table.
- `index.ts` is the entry point and holds no testable logic. It ends with `runServer(handle, …)`,
  which owns the start-and-exit tail — do not hand-write a `main()` / `process.exit` pair.
- stdout is the MCP transport: log to stderr only. `console.log` is a guard violation.
- No `.gitignore` here — the root one covers every server (ADR 0003).
