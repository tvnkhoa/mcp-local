---
name: {{KEY}}
description: "Bitbucket Cloud via the {{DISPLAY_NAME}}: repos, branches, commits and pull requests; a commit or PR and its diff; compare two branches (ahead/behind, changed files); a file at a branch/tag/SHA in any workspace repo without cloning; file history; workspace code search; a commit's build status; CI pipeline runs and a failed step's log; and, gated and previewed first, open/comment on/merge a PR (merge commit only), commit files server-side without a local index, and create/delete scratch branches. Use for: why did the build fail, is this commit green, what changed on origin since <sha/date>, how far is develop ahead of master, who changed this file, read docs in another repo (e.g. wec.knowledge-base), search code across repos, review/comment on PR #123, open or merge a pull request, commit only my files, make a sandbox branch. Prefer local git when the repo is checked out; not for Jira. It never force-pushes, rebases or squashes, and cannot trigger/stop/re-run a pipeline."
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
| "review PR 123" / "what changed" | `get_pull_request(id)`, `get_pull_request_diff(id)`, `list_pull_request_comments(id)` |
| "comment on PR 123" | `add_pull_request_comment(id, body, path?, line?, dryRun: true)` → confirm → `dryRun: false` |
| "merge PR 123" | the merge recipe below |
| "commit only my files" / "commit without touching the shared worktree" | the server-side commit recipe below |
| "make / remove a scratch branch" | `create_branch(name, fromRef)` / `delete_branch(name)` — both preview first |
| "diff of one file/dir between two refs" | `compare_refs(base, head, path, statOnly: false)` |
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
- `add_pull_request_comment` is gated the same way (`BITBUCKET_WRITE_ENABLED`): a comment is visible to
  everyone on the PR, so show the text and get a yes first. Inline = `path` + `line` (new side) or
  `oldLine` (removed side); a reply = `parentId`.

## Merge a pull request (OFF unless `BITBUCKET_MERGE_ENABLED=true`)

```
merge_pull_request(id)                                              // preview: dryRun is the DEFAULT
// show the user title, source -> destination and sourceCommit; get an explicit yes
merge_pull_request(id, dryRun: false, expectedSourceCommit: "<sourceCommit from the preview>")
```

- **Merge commit only** — there is no squash/fast-forward option, by design: history is keyed on SHAs.
- **The repository has no server-side branch restriction**, so this tool is the only thing holding
  "no rewrite, merge commit only". Never suggest squash, rebase or force push as a workaround.
- `source_moved` = the PR got new commits since the preview: preview again, show what changed.
  `pr_not_open` = already merged/declined. `pending: true` = Bitbucket merges asynchronously; check
  `get_pull_request`.

## Server-side commit (OFF unless `BITBUCKET_COMMIT_ENABLED=true`)

```
compare_refs(base: "<branch>", head: "<branch>")                   // head.sha = the branch head now
commit_files_preview(branch, parent: "<that sha>", message, files)   // each file: {path, content} or {path, delete: true}
// show the user the changes list; get an explicit yes
commit_files_apply(previewId, approvalToken)
```

- The commit is built on Bitbucket from the content you send — no local index, so nobody else's
  staged work can be swept in. Text only; 50 files, 512 KiB each, 1 MiB total.
- **Never forces.** `parent_not_head` = someone committed first: rebuild on the new head and preview
  again. Never suggest a force push or a rebase instead.
- Only branches on `BITBUCKET_COMMIT_BRANCHES` (nobody checks them out) or
  `BITBUCKET_COMMIT_SHARED_BRANCHES` (a shared worktree has them checked out). For a shared branch
  the result has `reconcile.script`: give it to the user to run in that worktree **before anyone
  commits there**. It stops without changing anything if the worktree does not match.
- For an isolated branch: `create_branch` first (dryRun, then `dryRun: false`), commit, open a PR,
  and after the merge `delete_branch` (preview returns `head`; pass it as `expectedHead`).
  These never touch master/main/develop, the main branch or a shared branch, and `delete_branch`
  refuses while an open PR uses the branch. Gated by `BITBUCKET_BRANCH_ENABLED`.

## Guardrails

- Never echo tokens or the `Authorization` header. Auth is env-only.
- Scopes: `read:repository`, `read:pullrequest`, `read:pipeline`; `write:pullrequest` for PR
  create/comment/merge; `write:repository` for commits and branches (Bitbucket names them with a
  `:bitbucket` suffix in the token UI). A 403 lists `required` vs `granted` — quote it. A repository
  access token sees only its own repo: another repo or `search_code` answers 403.
- The repositories have **no server-side branch restriction**: merge-commit-only, never-force and the
  branch allowlists are enforced only by these tools. Do not route around them.

## Configuration (env)

Server entry: `node {{ENTRY_PATH}}`

Auth: **either** `BITBUCKET_ACCESS_TOKEN` (Bearer) **or** `BITBUCKET_EMAIL` + `BITBUCKET_API_TOKEN`
(Basic). An Atlassian API token (`ATATT…`) is Basic auth — that is what the siliconstack workspace uses.

{{ENV_TABLE}}

## Tool reference

{{TOOL_LIST}}
