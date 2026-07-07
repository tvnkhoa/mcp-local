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

| Var | Bắt buộc | Mặc định | Ý nghĩa |
|-----|:---:|---|---|
| `BITBUCKET_ACCESS_TOKEN` | ✅ | — | Repository/Workspace/Project **Access Token** (gửi `Authorization: Bearer <token>`) |
| `BITBUCKET_WORKSPACE` | ✅ | — | Workspace slug |
| `BITBUCKET_DEFAULT_REPO` | — | — | Repo slug mặc định (khỏi truyền `repoSlug` mỗi call) |
| `BITBUCKET_BASE_URL` | — | `https://api.bitbucket.org/2.0` | Override base URL |
| `BITBUCKET_WRITE_ENABLED` | — | `false` | `true`/`1` mới cho phép `create_pull_request` |
| `BITBUCKET_TIMEOUT_MS` | — | `30000` | Timeout mỗi request (phải > 0) |
| `BITBUCKET_MAX_RETRIES` | — | `2` | Retry cho lỗi tạm thời (network / 429 / 5xx) |
| `BITBUCKET_DEFAULT_PAGELEN` | — | `25` | Page size mặc định cho list |
| `BITBUCKET_MAX_PAGELEN` | — | `100` | Trần page size |

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
