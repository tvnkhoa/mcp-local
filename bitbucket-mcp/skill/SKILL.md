---
name: {{KEY}}
description: "Bitbucket Cloud: repos, branches, commits, PRs and diffs, compare refs, a file in any repo without cloning, file history, code search, build status, pipeline runs and a failed step's log; gated and previewed: open/comment/merge a PR, server-side commits, scratch branches. Use for: why did the build fail, is this commit green, review PR #123, open a PR. Prefer local git when checked out; not Jira."
---

# {{DISPLAY_NAME}}

{{TAGLINE}} Tools are exposed as `{{TOOL_NAMESPACE}}`.

`repoSlug` defaults to `BITBUCKET_DEFAULT_REPO`; the workspace is fixed by `BITBUCKET_WORKSPACE` (no
tool takes one). Run `health_check` first if a call fails on auth.

## Pick the tool

| User asks | Call |
|---|---|
| "why did the build fail" | the pipeline recipe below |
| "review PR 123" | `get_pull_request(id)`, `get_pull_request_diff(id)`, `list_pull_request_comments(id)` |
| "comment on PR 123" | `add_pull_request_comment(id, body, path?, line?, dryRun: true)` → confirm → `dryRun: false` |
| "is this SHA green" | `get_commit_statuses(sha)` — every CI, not just Pipelines |
| "develop vs master" | `compare_refs(base, head)` — three-dot; `statOnly: false` for the diff |
| "read X in repo Y" | `get_file_at_ref(repoSlug, ref?, path)` — `path: ""` lists the root |
| "who changed this file" | `get_file_history(path, ref?)` — there is no blame |
| "what changed on origin since X" | `list_commits(include?, exclude?, path?, since?, author?)` |

- When the repo is checked out locally, `git` is cheaper and exact; these tools say what the
  **remote** has.
- `list_commits` `since`/`author` filter at most 1000 commits a call: if `scanCapReached`, continue
  with `nextCursor` before saying "none". Cursor-paged tools: pass `nextCursor` back unchanged.
- `search_code` covers each repo's default branch only; `code_search_unavailable` → fall back to
  `get_file_at_ref`. `ref` defaults to the main branch (often `master`) — pass it when it matters.

## Why did the build fail — walk it to the log line

```
list_pipelines(repoSlug?, branch: "<branch>", status: ["FAILED"])   // newest first
list_pipeline_steps(repoSlug?, pipelineUuid)                        // the failed step -> stepUuid
get_pipeline_step_log(repoSlug?, pipelineUuid, stepUuid)            // tail of the log
```

- **Filter vocabulary ≠ response vocabulary**: a `SUCCESSFUL` run is selected with
  `status: ["PASSED"]`. An unknown value returns an empty page, not an error.
- The log is the **tail**; `truncated: true` means the head was dropped — raise `maxBytes` only if
  the cause is earlier. A step that has not started has no log (404).
- A 403 on pipeline tools while others work = the token lacks `read:pipeline`; quote `required` vs
  `granted`. There is no way to trigger, stop or re-run a build — say so.

## Gated writes — each preview first, then an explicit yes

| Action | Flag | Sequence |
|---|---|---|
| Open a PR | `BITBUCKET_WRITE_ENABLED` | `create_pull_request(..., dryRun: true)` → show payload → `dryRun: false` |
| Comment | `BITBUCKET_WRITE_ENABLED` | `add_pull_request_comment(..., dryRun: true)` → show text → `dryRun: false` |
| Merge | `BITBUCKET_MERGE_ENABLED` | `merge_pull_request(id)` (preview is the default) → `merge_pull_request(id, dryRun: false, expectedSourceCommit)` |
| Commit files | `BITBUCKET_COMMIT_ENABLED` | `commit_files_preview(branch, parent, message, files)` → `commit_files_apply(previewId, approvalToken)` |
| Scratch branch | `BITBUCKET_BRANCH_ENABLED` | `create_branch` / `delete_branch` — dryRun first |

- **Merge commit only** — no squash or fast-forward. `source_moved` → preview again;
  `pending: true` → Bitbucket merges asynchronously, check `get_pull_request`.
- A server-side commit is built from the content you send — nobody's staged work is swept in.
  `parent` = the branch head now (`compare_refs` gives it). `parent_not_head` → rebuild on the new
  head and preview again. Only allow-listed branches; for a shared branch the result carries
  `reconcile.script` — give it to the user to run in that worktree before anyone commits there.
- `delete_branch` refuses while an open PR uses the branch; pass the preview's `head` as `expectedHead`.

## Guardrails

- The repositories have **no server-side branch restriction**: merge-commit-only, never-force and the
  branch allowlists are enforced only by these tools. Never suggest squash, rebase or force push as a
  workaround.
- Never echo tokens or the `Authorization` header. A 403 lists `required` vs `granted` scopes — quote
  it; a repository access token sees only its own repo.

Setup, auth, token scopes, env vars and troubleshooting: see `bitbucket-mcp/README.md`.

## Tool reference

{{TOOL_LIST}}
