# S-25 — `observe-mcp` onto `@mcp/sdk`

**Date** — 2026-07-28
**Step** — S-25 (third server; follows the S-23 pilot and the S-24 postgres migration)

---

## Result

`src/index.ts` went from **519 lines to 63**. The `ListTools` array and the `switch` became eight
`defineTool` declarations in `src/tools.ts` (545 lines).

This one needed **no new SDK capability** — the first migration that didn't. S-23 added
`formatError`, S-24 added `resources` and `rawResult`; S-25 used all three as they stood. That is
the signal the platform surface has stopped growing under migration pressure.

## What the migration was not allowed to change

| Net | Covers | Result |
|---|---|---|
| `contracts/observe-mcp.json` | what `tools/list` advertises | names, descriptions, input schemas **byte-identical**; `annotations` added (+48 lines, 0 deletions) |
| 41-case stdio call replay | what `tools/call` returns, incl. error envelopes, pretty-printing, and tool order | **40 of 41 byte-identical** |

All eight tools are read-only, idempotent and open-world — this server never writes.

### The one intentional change

The same one as S-23 and S-24: an unknown tool now reports `not_found` instead of `mcp_error`.

---

## The finding that justified `rawResult` a second time

`run_observe_query` renders its SQL-guardrail rejection at **the caller's profile**, defaulting to
verbose:

```ts
if (!guard.ok) return asError(guard.error, args.profile ?? "verbose");
```

Every *other* failure in the server is rendered always-verbose by the catch-all. So the two paths
disagree, and the disagreement is only visible in whitespace: at `nano`, `compact` and `standard`
the rejection is minified; at `verbose` and with no profile at all it is pretty-printed.

Routing that through `formatError` would have flattened it — every rejection pretty-printed —
which is a byte-level contract change that **no schema and no type can reveal**. It was found by
capturing all four profiles in the replay rather than by reading the code, and it is now pinned by
a test that asserts the presence or absence of a newline at each profile.

That is the entire justification for `run_observe_query` being the one `rawResult` tool here. The
other seven return plain payloads and let dispatch serialize them.

Worth stating plainly: this is the second server where a single handler owned a serialization
decision the pipeline does not make, and in both cases it was invisible to `tools/list`. A
migration that only checked the contract snapshot would have shipped both.

---

## Verification

| Check | Result |
|---|---|
| 4 servers typecheck + build | **4/4 PASS** |
| `contracts:check` | **4/4 verified**, 76 tools |
| observe call replay vs pre-migration | **40/41 identical** |
| Package tests | core 28, shared 50, sdk 50, testing 16, cli 13 = **157** |
| Server tests | codebase-index 26 scripts, postgres 53, observe **54**, bitbucket 25 |
| `typecheck:tests` | clean |
| `verify:all` | **exit 0** |

observe +13 tests. `src/tools.ts` at 545 lines is over the 400-line soft cap and under the 600
hard cap; unlike postgres it was left as one file, because its eight handlers share the window /
size / stream-resolution vocabulary and splitting them would separate code that is read together.

## What remains

`codebase-index-mcp` is the last one: **43 tools and a 2,154-line entry point**. It should not be
migrated as-is — the entry point needs decomposing first, and that is a change worth planning
separately rather than folding into a migration step.

The pattern for it is otherwise established and unchanged across three servers:

1. Capture call responses over real stdio before touching anything. Include **profile variants** —
   both non-trivial findings so far were profile-dependent serialization the schema could not show.
2. Declare tools with `defineTool`, keeping descriptions and input schemas verbatim.
3. Pass the server's existing error mapper as `formatError`, wrapped in a `toWireError` that
   unwraps `PlatformError` first.
4. Reach for `rawResult` where a handler already builds its envelope.
5. Keep the entry point free of anything that needs testing.
6. Expect the `annotations` addition in the snapshot diff and review it.
