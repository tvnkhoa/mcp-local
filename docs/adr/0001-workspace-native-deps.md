# ADR 0001 — Servers stay outside the npm workspace

**Status** — Accepted, implemented
**Step** — S-07 (Phase B, native dependency spike) / S-09 (Phase C, adopt npm workspaces)
**Date recorded** — 2026-07-28 (the decision itself predates this record; see *Why this was written late*)

## Context

The workspace holds five shared packages and four MCP servers. The obvious move when
adopting npm workspaces is to make all nine members, so one `npm install` at the root
resolves everything and every duplicate dependency is hoisted into a single copy.

Two servers make that hazardous:

- `codebase-index-mcp` depends on **`better-sqlite3`** and **`tree-sitter`** (plus its
  grammar packages), all of which compile native addons against the local toolchain.
  On Windows this needs Visual Studio C++ Build Tools, and the built `.node` binary is
  tied to the exact Node ABI it was compiled for.
- Hoisting relocates where those addons land relative to the package that loads them.
  A hoisted native module that resolves for one server and not another fails at
  *require* time, i.e. at server start-up, in a host that shows a dead MCP server and
  no stack trace.

## Decision

`workspaces` is scoped to `["packages/*"]` only. The four servers are **not** workspace
members. They depend on the shared packages through `file:` references and keep their
own `node_modules` and their own lockfile.

```jsonc
// root package.json
"workspaces": ["packages/*"]
```

## Consequences

**Accepted cost — dependencies are duplicated per server.** There are four separate
copies of `zod` and four of `@modelcontextprotocol/sdk`, one per server.

That is not merely disk: it means **`instanceof` does not work across the boundary**.
A `ZodError` thrown inside `postgres-mcp` is not an instance of the `ZodError` class
that `packages/shared` would import, because they are different class objects from
different module instances. Any shared code that needs to classify an error must
therefore never `instanceof` against a class **it imported itself**.

> **Amendment — the third option: injection.** This consequence was read for a while as
> "each server must own its own `mapError`" (`s24-notes.md`), leaving three near-identical
> copies. That does not follow. A shared classifier can take the class objects **as
> parameters**: `createErrorMapper` in `@mcp/sdk` imports neither `zod` nor
> `@modelcontextprotocol/sdk`, and each server passes its own `z.ZodError` and `McpError`
> in, so every `instanceof` runs against exactly the classes that server throws.
>
> This satisfies the constraint above rather than working around it, and it is strictly
> safer than the duck-typing escape hatch originally suggested: matching on `.name` would
> classify any object that happens to be called `ZodError`. `packages/sdk/src/errorMapper.test.ts`
> pins that difference with two same-named, same-shaped classes.
>
> What is shared is the branch order and the envelope shape; every client-visible string
> stays in the server. Deduplicating `zod` and `@modelcontextprotocol/sdk` (S-09) is no
> longer a prerequisite for sharing error classification.

**Accepted cost — five lockfiles.** CI caches all of them
(`.github/workflows/ci.yml`, `cache-dependency-path`), and the root aggregate scripts
(`scripts/run-servers.mjs`) drive per-server installs.

**Benefit — a native build failure is contained.** If `better-sqlite3` fails to compile,
`codebase-index-mcp` is broken and the other three servers still build, test, and boot.
`contracts:check` proves that every release, because it starts all four over real stdio.

**Benefit — `build:packages` before servers is a real ordering, not a convention.**
Servers consume `packages/*/dist` through `file:`, so the dependency is explicit.

## Alternatives rejected

**All nine as workspace members, with `nohoist`.** npm has no `nohoist` (that is a Yarn
Classic feature). The npm equivalent is `install-strategy=nested`, which forfeits the
only benefit hoisting offered.

**Servers as members, native deps as optional peer dependencies.** Moves the failure from
install time to run time and makes `npm run setup` unable to guarantee a working server.

## Why this was written late

The decision was made and implemented during Phase C, but S-07 was scoped as a
*throwaway spike* whose only durable artifact was supposed to be this record — and the
record was never written. The behaviour has been load-bearing ever since (`s24-notes.md`
cites the `instanceof` consequence without a decision to point at). Recorded now so the
constraint is discoverable from the ADR log rather than only from a migration note.
