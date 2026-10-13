---
name: {{KEY}}
description: "Bitbucket Cloud via the {{DISPLAY_NAME}}: list repos, branches, commits and pull requests, read a commit or PR and its diff, compare two branches (ahead/behind, changed files), read a file as it was at a branch/tag/SHA in any workspace repo without cloning, file history, workspace code search, build status of a commit, inspect CI pipeline runs and read a failed step's log, and open a PR (gated, dryRun first). Use for: why did the build/pipeline fail, is this commit green, what changed on origin since <sha/date>, how far is develop ahead of master, who changed this file, read the docs in another repo (e.g. wec.knowledge-base), search code across repos, review PR #123, create/open a pull request. Prefer local git when the repo is checked out; not for Jira tickets. Read-only except create_pull_request; it cannot push, commit, merge, or trigger/stop/re-run a pipeline."
---

# {{DISPLAY_NAME}}

{{TAGLINE}} Tools are exposed as `{{TOOL_NAMESPACE}}`.

`repoSlug` defaults to `BITBUCKET_DEFAULT_REPO`; the workspace is always `BITBUCKET_WORKSPACE` (no
tool takes a workspace argument). Run `health_check` first if a call fails on auth.

## Pick the tool

| User asks | Call |
|---|---|
| "why did the build fail" / "CI log" | the pipeline recipe below |
| "list open PRs" | `list_pull_requests(state: "OPEN")` — also `MERGED`, `DECLINED`, `SUPERSEDED` |
| "review PR 123" / "what changed" | `get_pull_request(id)` then `get_pull_request_diff(id)` |
| "which repos / branches" | `list_repositories(q?, role?)`, `list_branches(repoSlug, q?)` |
| "what changed on origin since X" | `list_commits(include?, exclude?, path?, since?, author?)` |
| "show commit abc123" / "files in that commit" | `get_commit(sha)` |
| "is this SHA green" | `get_commit_statuses(sha)` — every CI, not just Pipelines |
| "develop vs master" / "ahead/behind" | `compare_refs(base, head)` — `statOnly:false` for the diff |
| "read X in repo Y" / "file at that commit" | `get_file_at_ref(repoSlug, ref?, path)` — `path: ""` lists the root |
| "who changed this file" | `get_file_history(path, ref?)` — there is no blame endpoint |
| "where is X used across repos" | `search_code(query, repoSlug?)` |
| "open a PR" | the create recipe below |

`list_*` tools page with `page` / `pagelen` (max 100) and accept `sort`; `q` is BBQL on repos,
branches and PRs (`name ~ "api"`). `list_commits`, directory listings and `get_file_history` page with
`cursor` instead: pass `nextCursor` back unchanged.

## Commits, compare and source — what to know

- When the repo is checked out locally, `git` is cheaper and exact. These tools say what the
  **remote** has, and they let an agent read a repo it has not cloned.
- `compare_refs(base, head)` is three-dot: the files head changed since its merge base.
  `ahead`/`behind` stop counting at 500 and show `"≥500"`.
- `list_commits` `since`/`author` filter client-side over at most 1000 commits a call; if
  `scanCapReached` is true, continue with `nextCursor` before saying "none". `since` uses the author date.
- Content is cut at `maxBytes` (`truncated: true`); binary files return metadata only.
- `search_code` covers each repo's **default branch only**, as last indexed, and ignores
  `BITBUCKET_DEFAULT_REPO`. Terms are tokenized; quote a phrase. `code_search_unavailable` means the
  workspace has not enabled it — fall back to `get_file_at_ref`.
- `ref` defaults to the repo's main branch (often `master`, not `develop`) — pass it when it matters.

## Why did the build fail — walk it to the log line

```
list_pipelines(repoSlug?, branch: "<branch>", status: ["FAILED"])   // newest first
list_pipeline_steps(repoSlug?, pipelineUuid)                        // find the failed step -> stepUuid
get_pipeline_step_log(repoSlug?, pipelineUuid, stepUuid)            // tail of the log
```

- **Filter vocabulary ≠ response vocabulary.** A run shown as `SUCCESSFUL` is selected with
  `status: ["PASSED"]`; `SUCCESSFUL` / `COMPLETED` are not filter values. Upstream answers an
  unknown value with an empty page, so an empty result can mean a wrong filter, not "no runs".
- `pipelineUuid` takes the uuid with or without braces, or the plain build number.
- The log is the **tail** (default 256 KiB, `maxBytes` up to 1 MiB) — that is where the error is.
  `truncated: true` means the head was dropped; raise `maxBytes` only if the cause is earlier.
- A step that has not started has no log and answers 404 — check its state in `list_pipeline_steps`.
- A 403 on pipeline tools while repo/PR tools work = the token lacks `read:pipeline`. The error lists
  `required` vs `granted`; quote it.
- There is no `q` on pipelines (upstream ignores it), and no way to trigger/stop/re-run a build. Say so.

## Create a pull request (OFF unless `BITBUCKET_WRITE_ENABLED=true`)

```
list_branches(repoSlug?, q: 'name ~ "<branch>"')        // confirm the source branch exists
create_pull_request(title, sourceBranch, destinationBranch?, description?, reviewers?, closeSourceBranch?, dryRun: true)
// show the user the payload, get an explicit yes
create_pull_request(... same args ..., dryRun: false)
```

- `destinationBranch` defaults to the repo's main branch. `reviewers` are UUIDs or account_ids.
- A PR is outward-facing: never skip the dryRun + confirmation. Needs `write:pullrequest`.

## Guardrails

- Never echo tokens or the `Authorization` header. Auth is env-only.
- Scopes: `read:repository`, `read:pullrequest`, `read:pipeline`; `write:pullrequest` for PR creation
  (Bitbucket names them with a `:bitbucket` suffix in the token UI). A repository access token sees
  only its own repo: another repo or `search_code` answers 403.

## Configuration (env)

Server entry: `node {{ENTRY_PATH}}`

Auth: **either** `BITBUCKET_ACCESS_TOKEN` (Bearer) **or** `BITBUCKET_EMAIL` + `BITBUCKET_API_TOKEN`
(Basic). An Atlassian API token (`ATATT…`) is Basic auth — that is what the siliconstack workspace uses.

{{ENV_TABLE}}

## Tool reference

{{TOOL_LIST}}
