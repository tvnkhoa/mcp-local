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

Three steps, in this order — the ordering matters because each one produces what the next reads:

```bash
# 1. Snapshot the tool contract (needs a build; writes contracts/__KEY__.json)
npm run build --prefix ../__DIR__
node ../scripts/contract-snapshot.mjs --server __KEY__

# 2. Add the manifest entry + env contract, then derive the tool list
#    - packages/manifest/src/servers.ts        (one entry)
#    - packages/manifest/src/envSpecs/__CAMEL__.ts   (the env contract)
npm run generate:tools
npm run generate:all

# 3. Install it
node scripts/install-mcp.mjs --server __KEY__
```

`packages/manifest/src/servers.ts` throws at import time if a server has no generated tool list, so
step 1 cannot be skipped. See the `mcp-skill-authoring` skill for the full contract.

## Conventions this scaffold already follows

- `src/config/` is the **only** place `process.env` is read (`guard:deps` enforces it).
- `src/errors.ts` owns the `{ code, message, detail? }` wire envelope.
- Tools are declared as data in `src/tools.ts` and dispatched by `@mcp/sdk` — no hand-written
  `switch`.
- `index.ts` is the entry point and holds no testable logic.
- stdout is the MCP transport: log to stderr only. `console.log` is a guard violation.
- No `.gitignore` here — the root one covers every server (ADR 0003).
