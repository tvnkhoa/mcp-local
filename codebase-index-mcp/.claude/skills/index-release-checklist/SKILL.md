---
name: index-release-checklist
description: "Ready/blocked verdict before tagging, handing over, or reinstalling codebase-index-mcp: runs the workspace gate plus this server's extra gates (guard:no-llm-runtime, benchmark:plan:check, smoke from dist/, contracts and generated-docs drift, live re-index of a real repo) and collects the results of the full-vs-incremental conformance procedure and the security skill. Use for 'is codebase-index ready to release/ship/merge to main'. It runs the other checks; it does not replace the conformance procedure in incremental-indexing or index-security-review."
---

# Index Release Checklist

Run the steps in order. Each step names the command and what a pass looks like. Stop at the first
hard failure and report it, because later steps assume the earlier ones held.

| # | Gate | Command (from) | Pass when |
|---|---|---|---|
| 1 | Packages built | `npm run build:packages` (root) | exit 0. Servers consume `packages/*/dist` |
| 2 | Types + unit | `npm run typecheck && npm run test:unit` (server) | exit 0. Covers `src/**/*.test.ts` via `tsconfig.test.json` |
| 3 | Build + integration | `npm run build && npm run test` (server) | every discovered `test:*` harness plus `guard:no-llm-runtime` and `verify:enhancements` green |
| 4 | No-LLM | `npm run guard:no-llm-runtime` (server) | exit 0. **Hard policy, never waived** |
| 5 | Smoke from `dist/` | `npm run smoke` (server) | handshake, `health_check`, index and graph queries all succeed |
| 6 | Token budget | `npm run benchmark:plan:check` (server) | compact savings ≥ 40%, no per-tool byte regression. CI runs this, `verify:all` does not |
| 7 | Workspace gate | `npm run verify:all` (root), **once** (~3 min) | green. Includes `contracts:check` (boots all five servers), `generate:check` and `docs:check`. Re-run only the narrow target that failed |
| 8 | Contract intent | `git diff contracts/codebase-index.json` | every tool/schema change is intended, and README, the skill template and `orient.ts` agree with it |
| 9 | Conformance | `incremental-indexing` → *Verification: full vs incremental* | `ready` |
| 10 | Security | `index-security-review` | `pass`, or only `low` findings |
| 11 | Live fidelity | Re-index flow in `.claude/rules/mcp-hard-mode.md` on `codebase-index-mcp` **and** `wec.communication-hub` | latest run `status: "ok"`, `health_reasons` empty, `parse_failures` 0, a representative `search_symbols` per language returns the right symbol |
| 12 | Docs | `workflow.md` §4 *Release readiness* table | every row confirmed by reading |

Notes:

- Before step 11, restart the MCP server. A live server running a replaced build fails every parse
  (MCP-ISSUE-040). Since that fix, `assessRunHealth` reports such a run as `degraded`, not `ok`.
- If `dist/` holds orphans from a moved file, harnesses keep resolving them. Clean first
  (`docs/development/workflow.md` §7).
- `verify:live` needs credentials for the *other* servers. codebase-index-mcp has no live backend,
  and step 11 is its live check.
- Do not run `verify:all` again after a single fix. Run the narrow target instead (`test:servers`,
  `contracts:check`, `docs:check`, …).

## Verdict

**`ready`** only if steps 1–11 pass. Otherwise **`blocked`**, listing each blocker with its step
number, the failing command or output, and an owner. "Probably fine" is not a verdict.

## Authoritative reference

`docs/development/workflow.md` §4 (the gate, the CI difference, the release-readiness table) and
`docs/development/ci.md`.
