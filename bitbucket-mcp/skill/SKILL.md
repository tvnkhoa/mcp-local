---
name: {{KEY}}
description: "Bitbucket Cloud via the {{DISPLAY_NAME}}: list repos, branches and pull requests, read a PR and its diff, inspect CI pipeline runs and read a failed step's log, and open a PR (gated, dryRun first). Use for: why did the build/pipeline fail, CI status of a branch, show the build log, review PR #123, what changed in this PR, list open PRs, create/open a pull request from my branch. Not for local git history (use git) or Jira tickets. Read-only except create_pull_request; it cannot trigger, stop or re-run a pipeline."
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
| "open a PR" | the create recipe below |

`list_*` tools page with `page` / `pagelen` (max 100) and accept `sort`; `q` is BBQL on repos,
branches and PRs (`name ~ "api"`).

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
  (Bitbucket names them with a `:bitbucket` suffix in the token UI).

## Configuration (env)

Server entry: `node {{ENTRY_PATH}}`

Auth: **either** `BITBUCKET_ACCESS_TOKEN` (Bearer) **or** `BITBUCKET_EMAIL` + `BITBUCKET_API_TOKEN`
(Basic). An Atlassian API token (`ATATT…`) is Basic auth — that is what the siliconstack workspace uses.

{{ENV_TABLE}}

## Tool reference

{{TOOL_LIST}}
