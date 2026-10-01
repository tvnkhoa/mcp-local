---
name: index-security-review
description: "Security review of a codebase-index-mcp change: repo isolation (repoId scoping, query_graph), the CODEBASE_INDEX_ALLOWED_ROOTS path allowlist, secret-file exclusion and redactSensitive, tools that read source from disk, refactor write gates (HMAC approval), git blame email redaction, and the no-LLM policy. Use before merging a change to src/middleware/, fileFilter.ts, a handler that reads files or runs SQL, the refactor engine, or a new env var. Workspace-wide review of DB servers is mcp-security-review; release readiness is index-release-checklist."
---

# Index Security Review

Check each item against the diff. Mark it `pass` / `fail` / `n/a`. Give every `fail` a severity
and a concrete fix.

## 1. Path allowlist

- [ ] Every entry point that takes `repoPath` calls `assertPathAllowed` (`middleware/indexGuardrails.ts`).
      Today that is `index_repository` and `watch_repo` (`tools/handlers/indexHandler.ts`,
      `services/watch/watchLifecycle.ts`), plus auto-watch in `src/index.ts`. A new tool that takes
      a path must join that list.
- [ ] `CODEBASE_INDEX_ALLOWED_ROOTS` stays the only required env var, parsed by `parseAllowedRoots`.

## 2. Repo isolation

- [ ] Every new SQL in `repositories/` filters on `repo_id` in **each** table it touches, including
      joins and subqueries. The indexes are `(repo_id, …)`.
- [ ] `query_graph`: `validateReadOnlyGraphSql` (`middleware/sqliteGuardrails.ts`) blocks write/admin
      tokens and multiple statements, and it **requires `:repoId` to appear**. Presence is not
      scoping: `… where repo_id = :repoId or 1=1`, or a second unfiltered table, reads other repos.
      Also review the table allowlist `ALLOWED_QUERY_GRAPH_TABLES` (`tools/handlers/impactHandler.ts`),
      which includes the `refactor_*` tables. Run `npm run test:sqlite-guardrails`.

## 3. Secrets

- [ ] Secret-bearing files are never read: `isSecretBearingFile` (`services/indexing/fileFilter.ts`)
      covers `.env*`, `.npmrc`, keys and keystores, but **not** `.env.example`. It also gates
      `search_regex(scanAll: true)` (`services/search/regexSearch.ts`). Its tests are in
      `fileFilter.test.ts`.
- [ ] `redactSensitive` (`SECRET_PATTERNS`: AWS, Google API keys, PEM private keys, `key|token|secret|password = "…"`)
      runs **only on the indexing path** (`indexPipeline.ts`, before hashing and storage).
      `get_symbol_source`, `search_regex` and `get_feature_bundle(includeSource: true)` return
      bytes read from disk at call time, unredacted. A new disk-reading tool must decide this
      explicitly.
- [ ] `get_symbol_blame` keeps `redactEmail` defaulting to `true` (`types/schemas/refactor.ts`).
- [ ] No secret or full source span goes into logs (`indexLog` / `indexWarn`) or into an error
      message. `query_graph` errors truncate and mask quoted strings, so keep that.

## 4. Write paths

- [ ] Every write path stays preview-gated with an HMAC `approvalToken`:
      `refactor_replace_apply`, `rename_assist(emitPreview: true)` → apply,
      `refactor_symbol_migration` and `change_value_representation` (`dryRun: false` needs
      `previewId` + `approvalToken`, enforced since 2026-09-17). Run `npm run test:approval-token`
      and `npm run test:refactor-engine`.
- [ ] `CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET` / `_PREVIEW_TTL_MS` / `_STRICT_APPROVAL` defaults are
      unchanged. A new env var is declared in `packages/manifest/src/envSpecs/codebaseIndex.ts`, not
      read ad hoc. Only `src/config/` may read `process.env`.
- [ ] Harnesses never touch the real index DB (`npm run test:harness-db-isolation`).

## 5. No-LLM policy (hard)

- [ ] `npm run guard:no-llm-runtime` passes. It matches import specifiers by substring, comments
      included. `CODEBASE_INDEX_LLM_ENABLED=true` must still fail start-up.

## Output

`pass` or `fail`, followed by findings tagged `high|medium|low`, each with a file:line and a fix.
For a SQL-construction-heavy diff, also run the `db-tool-review` skill (Part 1).

## Authoritative reference

`docs/reference/conventions.md` (enforced rules), `codebase-index-mcp/CLAUDE.md` (allowlist,
no-LLM), and `src/middleware/`.
