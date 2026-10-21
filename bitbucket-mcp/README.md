# bitbucket-mcp

MCP server cho **Bitbucket Cloud** — đọc repository / commit / source / pull request / pipeline và **tạo / comment / merge pull request, commit phía server, tạo / xoá nhánh tạm**. Read-only mặc định; mỗi thao tác ghi bị khóa sau env flag riêng.

Server này chỉ dùng bốn nhóm quyền của Bitbucket:

- `read:repository:bitbucket` → `list_repositories`, `get_repository`, `list_branches`, `list_commits`, `get_commit`, `get_commit_statuses`, `compare_refs`, `get_file_at_ref`, `get_file_history`, `search_code`
- `read:pullrequest:bitbucket` → `list_pull_requests`, `get_pull_request`, `get_pull_request_diff`, `list_pull_request_comments`
- `read:pipeline:bitbucket` → `list_pipelines`, `get_pipeline`, `list_pipeline_steps`, `get_pipeline_step_log`
- `write:pullrequest:bitbucket` → `create_pull_request`, `add_pull_request_comment`, `merge_pull_request`
- `write:repository:bitbucket` → `commit_files_apply`, `create_branch`, `delete_branch` — thiếu scope này Bitbucket trả 403 kèm `required`/`granted`; API token không thêm scope được, phải tạo token mới

> Token thiếu scope này sẽ trả **403** cho các tool pipeline, kèm detail liệt kê `required` / `granted` — đã xác nhận trên một workspace thật ngày 2026-08-21. Cần cấp lại token có `read:pipeline`.

Không có dependency HTTP ngoài — dùng `fetch` (undici) của Node. Cùng khuôn với `observe-mcp` (client HTTP + retry/timeout + error taxonomy) và cơ chế write-gating bằng env flag của `postgres-mcp`.

## Cài đặt

```bash
cd bitbucket-mcp
npm install
npm run build     # tsc → dist/
```

## Cấu hình (env)

<!-- BEGIN GENERATED: env-table -->

| Variable | Required | Default | Notes |
|---|---|---|---|
| `BITBUCKET_WORKSPACE` | **yes** | — | The ID in bitbucket.org/<workspace>/… |
| `BITBUCKET_DEFAULT_REPO` | no | — | Lets you omit `repoSlug` on every call. |
| `BITBUCKET_ACCESS_TOKEN` | one of `bitbucket-auth` | — | **secret** · Auth: this (Bearer) OR BITBUCKET_EMAIL + BITBUCKET_API_TOKEN (Basic). Scopes: read:repository, read:pullrequest, read:pipeline, write:pullrequest; write:repository for commit_files and create/delete_branch. A repository access token reads only its own repo: other repos and search_code need a workspace token or an API token. |
| `BITBUCKET_EMAIL` | one of `bitbucket-auth` | — | Basic auth needs BOTH this and BITBUCKET_API_TOKEN. An Atlassian API token (ATATT…) is a Basic credential, not a Bearer one. |
| `BITBUCKET_API_TOKEN` | one of `bitbucket-auth` | — | **secret** |
| `BITBUCKET_WRITE_ENABLED` | no | `false` | create_pull_request and add_pull_request_comment are DISABLED unless true. The tools are still advertised; the gate is enforced when they are called. |
| `BITBUCKET_MERGE_ENABLED` | no | `false` | merge_pull_request is DISABLED unless true (dryRun still works). Merge commit only; the repo has no server-side branch protection, so this tool is the only guard. |
| `BITBUCKET_COMMIT_ENABLED` | no | `false` | commit_files_apply is DISABLED unless true (commit_files_preview still works). Never force-pushes; refused unless the parent is the branch head. |
| `BITBUCKET_BRANCH_ENABLED` | no | `false` | create_branch / delete_branch are DISABLED unless true (dryRun still works). Only names on BITBUCKET_COMMIT_BRANCHES; never a shared or main branch. |
| `BITBUCKET_COMMIT_BRANCHES` | no | — | Comma-separated repo:branch globs that commit_files, create_branch and delete_branch may write — branches nobody checks out locally, e.g. my-repo:sandbox/*. Empty = none. |
| `BITBUCKET_COMMIT_SHARED_BRANCHES` | no | — | Comma-separated repo:branch globs checked out in a shared worktree, e.g. my-repo:develop. Writable; the result carries the local reconcile steps. |
| `BITBUCKET_BASE_URL` | no | `https://api.bitbucket.org/2.0` *(code)* | — |
| `BITBUCKET_TIMEOUT_MS` | no | `30000` | Must be > 0, else the default applies. |
| `BITBUCKET_MAX_RETRIES` | no | `2` | Retries for transient failures (network / 429 / 5xx). 0 disables. |
| `BITBUCKET_DEFAULT_LIMIT` | no | `25` *(code)* | renamed — still accepts `BITBUCKET_DEFAULT_PAGELEN` |
| `BITBUCKET_MAX_LIMIT` | no | `100` *(code)* | renamed — still accepts `BITBUCKET_MAX_PAGELEN` |

16 variables. Defaults marked *(code)* are the server's own fallback and are **not** written into your agent config — set them only to override.

<!-- END GENERATED: env-table -->

Thay thế (khi không dùng access token): đặt `BITBUCKET_EMAIL` + `BITBUCKET_API_TOKEN` (Atlassian API token) → server dùng Basic auth. Access token (Bearer) được ưu tiên nếu cả hai được set.

> Tạo Access Token trong Bitbucket: **Repository/Workspace settings → Access tokens**, chọn scope `read:repository`, `read:pullrequest`, `read:pipeline`, `write:pullrequest`.
>
> Repository Access Token chỉ đọc được **đúng repo đó**: `get_file_at_ref` sang repo khác (vd `other-repo`) và `search_code` toàn workspace sẽ trả 403. Cần Workspace Access Token hoặc Atlassian API token (Basic).

## Chạy

```bash
npm run dev                 # chạy trực tiếp bằng tsx (không cần build)
npm run start               # chạy bản dist/ đã build
npm run typecheck
npm run smoke-test          # cần build trước + env credentials (read-only + dry-run)
```

## Đăng ký MCP (`~/.claude.json`)

Thêm vào block `mcpServers` (global):

```jsonc
"bitbucket-mcp": {
  "type": "stdio",
  "command": "node",
  "args": ["D:/1.SourceCode/mcp-local/bitbucket-mcp/dist/index.js"],
  "env": {
    "BITBUCKET_WORKSPACE": "<workspace-slug>",
    "BITBUCKET_ACCESS_TOKEN": "<token>",
    "BITBUCKET_DEFAULT_REPO": "<repo-slug>",
    "BITBUCKET_WRITE_ENABLED": "true"
  }
}
```

Restart MCP (`/mcp` trong Claude Code) để nạp bản build mới.

## Tools

<!-- BEGIN GENERATED: tool-list -->

26 tools, namespaced `mcp__bitbucket-mcp__<tool>`:

- `add_pull_request_comment`
- `commit_files_apply`
- `commit_files_preview`
- `compare_refs`
- `create_branch`
- `create_pull_request`
- `delete_branch`
- `get_commit`
- `get_commit_statuses`
- `get_file_at_ref`
- `get_file_history`
- `get_pipeline`
- `get_pipeline_step_log`
- `get_pull_request`
- `get_pull_request_diff`
- `get_repository`
- `health_check`
- `list_branches`
- `list_commits`
- `list_pipeline_steps`
- `list_pipelines`
- `list_pull_request_comments`
- `list_pull_requests`
- `list_repositories`
- `merge_pull_request`
- `search_code`

<!-- END GENERATED: tool-list -->

| Tool | Quyền | Mô tả |
|------|-------|-------|
| `health_check` | read | Kiểm tra kết nối + auth, echo config (đã mask secret) |
| `list_repositories` | read:repository | Liệt kê repo trong workspace (`role`, `q`, `sort`, phân trang) |
| `get_repository` | read:repository | Metadata một repo |
| `list_branches` | read:repository | Liệt kê branch (chọn source/destination trước khi tạo PR) |
| `list_pull_requests` | read:pullrequest | Liệt kê PR (mặc định `OPEN`; lọc theo `state`) |
| `get_pull_request` | read:pullrequest | Chi tiết một PR theo `id` |
| `get_pull_request_diff` | read:pullrequest | Diff dạng text của PR |
| `list_commits` | read:repository | Commit trên remote (`include`/`exclude`/`path`); `since`/`author` lọc phía client, quét tối đa 1000 commit/lần; phân trang bằng `cursor` |
| `get_commit` | read:repository | Một commit: message, parents, và từng file +/- (`maxFiles`, mặc định 200, tối đa 500) |
| `get_commit_statuses` | read:repository | Build status của một SHA từ mọi CI (Pipelines, Azure DevOps…) |
| `compare_refs` | read:repository | So sánh `base`…`head`: merge base, ahead/behind (chặn ở ≥500), file thay đổi; `statOnly:false` thêm diff (mặc định 256 KiB, tối đa 1 MiB); `path` lọc theo một file hoặc thư mục |
| `get_file_at_ref` | read:repository | File hoặc thư mục tại một branch/tag/SHA ở **bất kỳ repo nào** trong workspace (`maxBytes`, mặc định 256 KiB, tối đa 1 MiB) |
| `get_file_history` | read:repository | Các commit đã sửa một file, theo dõi qua rename (thay cho blame) |
| `search_code` | read:repository | Code search toàn workspace hoặc một repo — **chỉ default branch**, theo lần index gần nhất |
| `list_pipelines` | read:pipeline | Liệt kê pipeline run (mới nhất trước); lọc `branch` và `status[]` (nhiều status = OR) |
| `get_pipeline` | read:pipeline | Một run theo UUID (không cần ngoặc) hoặc theo build number |
| `list_pipeline_steps` | read:pipeline | Các step của một run — tìm step nào fail và lấy `stepUuid` |
| `get_pipeline_step_log` | read:pipeline | Log của một step; trả **phần cuối** (`maxBytes`, mặc định 256 KiB, tối đa 1 MiB) |
| `list_pull_request_comments` | read:pullrequest | Comment của một PR (cũ nhất trước): nội dung, vị trí inline, `parentId` của reply |
| `create_pull_request` | write:pullrequest | Tạo PR (khóa sau `BITBUCKET_WRITE_ENABLED`; hỗ trợ `dryRun`) |
| `add_pull_request_comment` | write:pullrequest | Comment chung, inline (`path` + `line`/`oldLine`) hoặc reply (`parentId`); khóa sau `BITBUCKET_WRITE_ENABLED`; hỗ trợ `dryRun` |
| `merge_pull_request` | write:pullrequest | Merge PR **chỉ bằng merge commit**; `dryRun` mặc định **true**; khóa sau `BITBUCKET_MERGE_ENABLED`; cần `expectedSourceCommit` từ preview |
| `commit_files_preview` | read:repository | Lên kế hoạch MỘT commit phía server (thêm/sửa/xoá file text): kiểm allowlist nhánh, parent phải là head, mô tả từng file; trả `previewId` + `approvalToken` (15 phút, dùng một lần) |
| `commit_files_apply` | write:repository | Tạo đúng commit đã preview; khóa sau `BITBUCKET_COMMIT_ENABLED`; không bao giờ force; nhánh dùng chung thì trả kèm script reconcile |
| `create_branch` | write:repository | Tạo nhánh tại một ref; chỉ tên trong `BITBUCKET_COMMIT_BRANCHES`; `dryRun` mặc định **true**; khóa sau `BITBUCKET_BRANCH_ENABLED` |
| `delete_branch` | write:repository | Xoá nhánh; cùng allowlist; từ chối khi có PR OPEN dùng nhánh; cần `expectedHead` từ preview |

### Tạo PR

```jsonc
create_pull_request {
  "repoSlug": "my-repo",            // hoặc bỏ, dùng BITBUCKET_DEFAULT_REPO
  "title": "Fix: null check on login",
  "sourceBranch": "feature/login-fix",
  "destinationBranch": "main",       // bỏ trống → dùng main branch của repo
  "description": "…",
  "closeSourceBranch": true,
  "reviewers": ["{uuid-1}", "account-id-2"],
  "dryRun": false                    // true = xem trước payload, KHÔNG gọi API
}
```

- `dryRun:true` luôn chạy được kể cả khi write đang tắt — trả về `{ method, path, body }` để bạn kiểm tra trước.
- `dryRun:false` cần `BITBUCKET_WRITE_ENABLED=true`, nếu không sẽ trả lỗi `WRITE_DISABLED`.
- `reviewers`: chuỗi bắt đầu bằng `{` được coi là `uuid`, còn lại là `account_id`.

### Commit, so sánh ref, đọc file ở repo khác

```jsonc
// commit trên develop mà master chưa có, chạm vào một path
list_commits { "repoSlug": "my-repo", "include": ["develop"], "exclude": ["master"], "path": "packages/db" }

// commit từ một ngày, của một người — lọc phía client; dùng nextCursor để đi tiếp
list_commits { "repoSlug": "my-repo", "since": "2026-10-07", "author": "alice", "pagelen": 20 }

// một commit và các file nó đổi (như git show --stat)
get_commit { "repoSlug": "my-repo", "sha": "b2dce2fd01b7" }

// develop đi trước/sau master bao nhiêu, đổi những file nào
compare_refs { "repoSlug": "my-repo", "base": "master", "head": "develop" }

// đọc tài liệu ở repo khác, không cần clone (ref bỏ trống = main branch)
get_file_at_ref { "repoSlug": "other-repo", "path": "glossary/business-terms.md" }

// SHA này đã xanh chưa
get_commit_statuses { "repoSlug": "my-repo", "sha": "b2dce2fd01b742570618a44c8249680dd35b4fe5" }
```

- **Thứ tự `x..y` của Bitbucket ngược với git**: `diffstat/<head>..<base>` mới là "head có gì mà base chưa có". Tool nhận `base`/`head` có tên nên không cần nhớ; đã xác minh trên một repo thật ngày 2026-10-13 (develop..master liệt kê file develop thêm, chiều ngược lại rỗng). Response có field `semantics` ghi rõ.
- Ref được **resolve sang SHA trước** (branch → tag → SHA rút gọn) và echo lại `resolvedSha`: branch có `/` (vd `docs/phase-0b`) không lẫn với path, và `/src/<branch>/…` trả 403 với API token.
- Nội dung file đọc bằng `?format=raw`. Đã xác minh 2026-10-13: `/src/<sha>/<path>` không có `format` trả **403** với Atlassian API token, còn `format=meta` và `format=raw` trả 200.
- Mọi body lớn (file, diff) được đọc theo stream và **cắt ở `maxBytes`** — `truncated: true` khi bị cắt. File binary chỉ trả metadata.
- `list_commits`, thư mục và `get_file_history` phân trang bằng **`cursor`** (truyền lại `nextCursor` y nguyên), không phải số trang: Bitbucket dùng `page=2&ctx=…` hoặc token như `page=E8Ux`.
- `since` so với **author date** và chỉ gần đúng qua merge; quét dừng khi cả một trang cũ hơn `since`. `scanCapReached: true` nghĩa là còn commit chưa quét — gọi tiếp với `nextCursor`.
- `search_code` không dùng `BITBUCKET_DEFAULT_REPO`: bỏ `repoSlug` là tìm cả workspace. Từ khoá bị tách token (`aria-migrate-check` khớp cả `aria`); dùng `"cụm chính xác"` khi cần.
- Khi repo đã clone sẵn trên máy, `git` local rẻ hơn và chính xác hơn; các tool này trả lời "remote đang có gì".

### Debug một build fail

```jsonc
// 1. build nào vừa chạy trên branch, và cái nào fail
list_pipelines {
  "repoSlug": "my-repo",
  "branch": "main",
  "status": ["FAILED", "ERROR"],   // nhiều status = OR
  "pagelen": 5
}

// 2. chi tiết một run — nhận uuid có/không ngoặc, hoặc build number
get_pipeline { "repoSlug": "my-repo", "pipelineUuid": "1234" }

// 3. step nào fail, và lấy stepUuid
list_pipeline_steps { "repoSlug": "my-repo", "pipelineUuid": "1234" }

// 4. đọc log của step đó — trả PHẦN CUỐI, nơi lỗi nằm
get_pipeline_step_log {
  "repoSlug": "my-repo",
  "pipelineUuid": "1234",
  "stepUuid": "11111111-2222-3333-4444-555555555555",
  "maxBytes": 65536
}
```

- **Từ vựng lọc KHÁC từ vựng response.** Run có `result: "SUCCESSFUL"` phải lọc bằng `status: ["PASSED"]`; lọc `SUCCESSFUL` hay `COMPLETED` sẽ ra rỗng. Đã xác minh trên API thật ngày 2026-08-21.
- Giá trị `status` sai → Bitbucket trả **200 kèm page rỗng**, không có lỗi. Vì vậy `status` là enum đóng ở tầng tool: gửi giá trị lạ bị chặn bằng `validation_error` thay vì đọc thành "không có run nào".
- Endpoint pipelines **bỏ qua `q`/BBQL hoàn toàn** (`q=totally_not_a_field="zzz"` vẫn trả đủ run), nên tool không có tham số `q` — advertise nó là advertise một no-op.
- Response echo lại `filters` khi có lọc, để phân biệt "page rỗng vì bộ lọc" với "repo không có run".
- `webUrl` là link mở được trên browser (dựng từ build number); `href` của Bitbucket trỏ repo bằng UUID nên người không dùng được.
- `get_pipeline_step_log` xin phần cuối bằng header `Range`; nếu server bỏ qua `Range` thì phần cắt vẫn được áp ở tầng tool, nên response luôn bị chặn theo `maxBytes`. `truncated: true` nghĩa là log đã bị cắt đầu.
- Step chưa bắt đầu chạy thì chưa có log và sẽ trả 404.

## Response profiles

`nano | compact | standard | verbose` (mặc định `compact`). Chỉ `verbose` in đẹp; các profile khác trả JSON tối giản (bỏ field `null`). Lỗi luôn trả ở dạng `verbose` kèm `isError: true`.

### Comment và merge PR

```jsonc
// comment inline trên diff — xem trước, rồi gửi
add_pull_request_comment { "repoSlug": "my-repo", "id": 12, "body": "…", "path": "src/a.ts", "line": 42, "dryRun": true }

// merge: bước 1 là preview (mặc định), trả về sourceCommit
merge_pull_request { "repoSlug": "my-repo", "id": 12 }
// bước 2: merge đúng commit vừa review
merge_pull_request { "repoSlug": "my-repo", "id": 12, "dryRun": false, "expectedSourceCommit": "f02e5cfc8fb6" }
```

- **Chỉ merge commit, không có tuỳ chọn nào khác.** Squash hay fast-forward viết lại hoặc bỏ qua các SHA mà công cụ phía sau (vd một board theo dõi commit) dựa vào.
- **Repo không có branch restriction phía server** (owner xác nhận ngày 2026-10-13: không bật được trên develop/master). Vì vậy luật "không viết lại lịch sử, chỉ merge commit" **chỉ do tool giữ** — tool là lớp bảo vệ duy nhất; người hoặc công cụ khác vẫn có thể squash hay force push.
- `dryRun` mặc định là `true`. Merge thật cần `BITBUCKET_MERGE_ENABLED=true` **và** `expectedSourceCommit` khớp commit hiện tại của PR; nếu PR đã có commit mới sau lần preview thì bị từ chối (`source_moved`). PR không ở trạng thái `OPEN` → `pr_not_open`.
- `BITBUCKET_MERGE_ENABLED` tách khỏi `BITBUCKET_WRITE_ENABLED`: bật quyền tạo PR/comment không kéo theo quyền merge.
- Merge chậm có thể được Bitbucket nhận bất đồng bộ (`pending: true`); kiểm lại bằng `get_pull_request`.

### Commit phía server và nhánh tạm

Dành cho nhiều session dùng chung một worktree: commit được tạo trên Bitbucket từ nội dung file gửi lên, không qua index local, nên không thể cuốn theo file người khác đã stage.

```jsonc
// 1. nhánh tạm (dryRun mặc định — gọi lại với dryRun:false)
create_branch { "repoSlug": "my-repo", "name": "sandbox/my-change", "fromRef": "develop", "dryRun": false }

// 2. lên kế hoạch commit — parent PHẢI là head hiện tại của nhánh
commit_files_preview {
  "repoSlug": "my-repo", "branch": "sandbox/my-change", "parent": "<sha head>",
  "message": "…", "files": [{ "path": "docs/a.md", "content": "…" }, { "path": "old.md", "delete": true }]
}
// 3. tạo đúng commit đã preview
commit_files_apply { "previewId": "…", "approvalToken": "…" }

// 4. sau khi merge PR: xoá nhánh (preview trả head, rồi xoá đúng head đó)
delete_branch { "repoSlug": "my-repo", "name": "sandbox/my-change", "dryRun": false, "expectedHead": "<head>" }
```

- **Không bao giờ force.** Server MCP kiểm parent == head trước khi gửi, và Bitbucket tự kiểm lần nữa. Đã xác minh 2026-10-13: parent cũ bị từ chối với **400** "The parent commit specified (…) is not the head of branch …" (tài liệu ghi 409) và không ghi gì; cả hai đều được báo thành lỗi `parent_not_head`.
- **Repo không có branch restriction phía server**, nên allowlist và các lần từ chối của tool là lớp bảo vệ duy nhất.
- Allowlist: `BITBUCKET_COMMIT_BRANCHES` cho nhánh không ai checkout local (vd `my-repo:sandbox/*`); `BITBUCKET_COMMIT_SHARED_BRANCHES` cho nhánh đang checkout trong worktree chung (vd `my-repo:develop`). Mẫu là `repo:glob`, `*` khớp cả `/`.
- create/delete_branch **không bao giờ** đụng `master`, `main`, `develop`, main branch của repo hay nhánh dùng chung, dù allowlist nói gì.
- **Nhánh dùng chung:** commit nằm trên origin còn worktree vẫn ở parent và path vẫn dirty; `git merge --ff-only` sẽ từ chối. `commit_files_apply` trả `reconcile.script` (bash) để chạy trong worktree đó: dừng mà không đổi gì nếu HEAD local khác parent hoặc nội dung file khác commit; nếu khớp thì `git update-ref` nhánh và `git reset` **chỉ** các path đã commit — file người khác đã stage giữ nguyên.
- Chỉ file text (có NUL bị từ chối), tối đa 50 file, 512 KiB/file, 1 MiB/commit. Apply chỉ nhận `previewId` + `approvalToken`, nên thứ được commit đúng là thứ đã review; token mất hiệu lực khi server khởi động lại.

## Bảo mật

- Credential chỉ nằm trong header `Authorization`, **không bao giờ log**; startup log dùng `describeConfig` (đã mask thành `Bearer ****`).
- Thiếu `BITBUCKET_ACCESS_TOKEN`/`BITBUCKET_WORKSPACE` → server báo `config_error` và thoát ngay.
- Việc tạo PR và comment bị khóa mặc định; phải bật `BITBUCKET_WRITE_ENABLED` một cách rõ ràng. Merge có cờ riêng `BITBUCKET_MERGE_ENABLED`; commit `BITBUCKET_COMMIT_ENABLED`; tạo/xoá nhánh `BITBUCKET_BRANCH_ENABLED`.
