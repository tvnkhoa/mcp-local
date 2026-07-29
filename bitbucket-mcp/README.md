# bitbucket-mcp

MCP server cho **Bitbucket Cloud** — đọc repository / pull request và **tạo pull request**. Read-only mặc định; việc tạo PR bị khóa sau một env flag.

Server này chỉ dùng ba nhóm quyền của Bitbucket:

- `read:repository:bitbucket` → `list_repositories`, `get_repository`, `list_branches`
- `read:pullrequest:bitbucket` → `list_pull_requests`, `get_pull_request`, `get_pull_request_diff`
- `write:pullrequest:bitbucket` → `create_pull_request`

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
| `BITBUCKET_ACCESS_TOKEN` | one of `bitbucket-auth` | — | **secret** · Auth: this (Bearer) OR BITBUCKET_EMAIL + BITBUCKET_API_TOKEN (Basic). Scopes: read:repository, read:pullrequest, write:pullrequest. |
| `BITBUCKET_EMAIL` | one of `bitbucket-auth` | — | Basic auth needs BOTH this and BITBUCKET_API_TOKEN. An Atlassian API token (ATATT…) is a Basic credential, not a Bearer one. |
| `BITBUCKET_API_TOKEN` | one of `bitbucket-auth` | — | **secret** |
| `BITBUCKET_WRITE_ENABLED` | no | `false` | create_pull_request is DISABLED unless true. The tool is still advertised; the gate is enforced when it is called. |
| `BITBUCKET_BASE_URL` | no | `https://api.bitbucket.org/2.0` *(code)* | — |
| `BITBUCKET_TIMEOUT_MS` | no | `30000` | Must be > 0, else the default applies. |
| `BITBUCKET_MAX_RETRIES` | no | `2` | Retries for transient failures (network / 429 / 5xx). 0 disables. |
| `BITBUCKET_DEFAULT_PAGELEN` | no | `25` *(code)* | — |
| `BITBUCKET_MAX_PAGELEN` | no | `100` *(code)* | — |

11 variables. Defaults marked *(code)* are the server's own fallback and are **not** written into your agent config — set them only to override.

<!-- END GENERATED: env-table -->

Thay thế (khi không dùng access token): đặt `BITBUCKET_EMAIL` + `BITBUCKET_API_TOKEN` (Atlassian API token) → server dùng Basic auth. Access token (Bearer) được ưu tiên nếu cả hai được set.

> Tạo Access Token trong Bitbucket: **Repository/Workspace settings → Access tokens**, chọn scope `read:repository`, `read:pullrequest`, `write:pullrequest`.

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

8 tools, namespaced `mcp__bitbucket-mcp__<tool>`:

- `create_pull_request`
- `get_pull_request`
- `get_pull_request_diff`
- `get_repository`
- `health_check`
- `list_branches`
- `list_pull_requests`
- `list_repositories`

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
| `create_pull_request` | write:pullrequest | Tạo PR (khóa sau `BITBUCKET_WRITE_ENABLED`; hỗ trợ `dryRun`) |

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

## Response profiles

`nano | compact | standard | verbose` (mặc định `compact`). Chỉ `verbose` in đẹp; các profile khác trả JSON tối giản (bỏ field `null`). Lỗi luôn trả ở dạng `verbose` kèm `isError: true`.

## Bảo mật

- Credential chỉ nằm trong header `Authorization`, **không bao giờ log**; startup log dùng `describeConfig` (đã mask thành `Bearer ****`).
- Thiếu `BITBUCKET_ACCESS_TOKEN`/`BITBUCKET_WORKSPACE` → server báo `config_error` và thoát ngay.
- Việc tạo PR bị khóa mặc định; phải bật `BITBUCKET_WRITE_ENABLED` một cách rõ ràng.
