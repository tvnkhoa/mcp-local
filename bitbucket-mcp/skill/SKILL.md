---
name: {{KEY}}
description: "Browse Bitbucket Cloud repositories and pull requests, read PR diffs, and create pull requests via the {{DISPLAY_NAME}}. Triggers on: list repos/branches/PRs, view a pull request or its diff, open/create a PR. PR creation is gated and supports dryRun."
---

# {{DISPLAY_NAME}}

{{TAGLINE}} Tools are exposed as `{{TOOL_NAMESPACE}}`.

Use this to explore repositories, list and read pull requests and their diffs, and create pull requests. Reads are always available; **creating a PR is gated** behind `BITBUCKET_WRITE_ENABLED=true`.

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
- Reads use scopes `read:repository` / `read:pullrequest`; PR creation additionally needs `write:pullrequest`.

## Configuration (env)

Server entry: `node {{ENTRY_PATH}}`

Auth: **either** `BITBUCKET_ACCESS_TOKEN` (Bearer) **or** `BITBUCKET_EMAIL` + `BITBUCKET_API_TOKEN` (Basic). The siliconstack workspace uses an Atlassian API token → Basic auth.

{{ENV_TABLE}}

## Tool reference

{{TOOL_LIST}}
