---
name: {{KEY}}
description: "Browse Bitbucket Cloud repositories, pull requests and CI pipelines, read PR diffs and build logs, and create pull requests via the {{DISPLAY_NAME}}. Triggers on: list repos/branches/PRs, view a pull request or its diff, open/create a PR, why did the build fail, pipeline status, CI log for a step. PR creation is gated and supports dryRun."
---

# {{DISPLAY_NAME}}

{{TAGLINE}} Tools are exposed as `{{TOOL_NAMESPACE}}`.

Use this to explore repositories, list and read pull requests and their diffs, inspect CI pipeline runs and read step logs, and create pull requests. Reads are always available; **creating a PR is gated** behind `BITBUCKET_WRITE_ENABLED=true`.

## Step 0 — Orient

```
health_check                 // verify auth + connectivity
list_repositories(workspace?)
get_repository(repoSlug)
list_branches(repoSlug)
```
`BITBUCKET_WORKSPACE` and (optionally) `BITBUCKET_DEFAULT_REPO` let you omit those args.

## Pull requests (read)

```
list_pull_requests(repoSlug?, state?)     // OPEN / MERGED / DECLINED
get_pull_request(repoSlug?, id)
get_pull_request_diff(repoSlug?, id)      // unified diff for review
```

## Pipelines (read)

Walk one CI failure end to end — do not stop at "the build failed", get to the log line:

```
list_pipelines(repoSlug?, branch?, status?, pagelen?)            // newest first
get_pipeline(repoSlug?, pipelineUuid)                            // uuid or build number
list_pipeline_steps(repoSlug?, pipelineUuid)                     // which step failed -> stepUuid
get_pipeline_step_log(repoSlug?, pipelineUuid, stepUuid, maxBytes?)
```
- `status: ["FAILED"]` + `branch` is the usual first call; several statuses are ORed.
- **The filter vocabulary is not the response vocabulary.** A run reported as `SUCCESSFUL` is selected by `PASSED`. Filtering by `SUCCESSFUL` or `COMPLETED` returns nothing — upstream answers 200 with an empty page for a status it does not know, so an empty result can mean a wrong value rather than no runs. Verified live 2026-08-21.
- There is no `q`/BBQL on this endpoint — it is silently ignored upstream, so the tool does not offer it.
- `pipelineUuid` takes the uuid with or without braces, or a plain build number.
- `get_pipeline_step_log` returns the **tail** (default 256 KiB, max 1 MiB) — that is where the error is. `truncated: true` means the head was dropped; raise `maxBytes` only if the failure is genuinely earlier.
- Needs the `read:pipeline` scope on the token. A 403 here while the repo/PR tools work means exactly that — the error detail lists `required` vs `granted`, so quote it rather than guessing.
- A step that has not started has no log and answers 404 — check `list_pipeline_steps` state first.

## Create a pull request (gated)

```
create_pull_request(repoSlug?, title, source, destination, description?, dryRun?)
```
- **Always run with `dryRun: true` first** and show the user the payload; only then create for real.
- Disabled unless `BITBUCKET_WRITE_ENABLED=true`. Requires scope `write:pullrequest`.
- Confirm `source`/`destination` branch names against `list_branches` before creating.

## Guardrails

- Creating a PR is outward-facing — confirm with the user before the non-dryRun call.
- Never echo tokens. Auth is env-only.
- Reads use scopes `read:repository` / `read:pullrequest`, plus `read:pipeline` for the pipeline tools; PR creation additionally needs `write:pullrequest`.
- Pipeline tools are read-only: there is no way to trigger, stop or re-run a build from here. Say so rather than improvising.

## Configuration (env)

Server entry: `node {{ENTRY_PATH}}`

Auth: **either** `BITBUCKET_ACCESS_TOKEN` (Bearer) **or** `BITBUCKET_EMAIL` + `BITBUCKET_API_TOKEN` (Basic). The siliconstack workspace uses an Atlassian API token → Basic auth.

{{ENV_TABLE}}

## Tool reference

{{TOOL_LIST}}
