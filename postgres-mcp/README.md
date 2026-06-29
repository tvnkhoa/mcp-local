# PostgreSQL MCP

MCP server cho PostgreSQL với 3 nhóm năng lực, **mặc định read-only** và bật dần qua env:

1. **Read-only query** (luôn bật) — `SELECT` / `WITH ... SELECT`, single-statement, giới hạn limit/timeout.
2. **Đa môi trường** — chọn DB theo `environment` (dev/staging/prod), discover connection từ `appsettings*.json` hoặc env var. **prod luôn read-only.**
3. **Ghi có review/confirm** (bật bằng `PG_WRITE_ENABLED`) — `write_preview` → `write_apply` → `write_rollback`, HMAC approval token, bắt buộc WHERE, dry-run, audit log.
4. **EF Core migrations** (bật bằng `PG_MIGRATION_ENABLED`) — snapshot → preview → apply → verify, dry-run, so sánh schema giữa env.

## 1. Cài đặt

```powershell
cd D:/1.SourceCode/mcp-local/postgres-mcp
npm install
npm run build
```

## 2. Cấu hình

Copy `.env.example` và chỉnh. Tối thiểu cần một nguồn connection (xem `.env.example`):
- `CH_DB_CONNECTION` (legacy, 1 env), **hoặc**
- `CH_APPSETTINGS_ROOTS` + `CH_CONNECTION_NAME` (đọc từ appsettings), **hoặc**
- `PG_ENV_DEV` / `PG_ENV_STAGING` / `PG_ENV_PROD`.

Connection string nhận cả `postgres://...` lẫn `Server=...;Database=...;User Id=...;Password=...;`.

## 3. Chạy

```powershell
npm run dev      # tsx, không cần build
# hoặc
npm run build; npm start
```

## 4. Tools

| Tool | Mô tả |
|---|---|
| `health_check` | Kiểm tra kết nối (theo `environment`) |
| `list_environments` | Liệt kê env, capability, connection đã mask |
| `list_tables` / `describe_table` | Liệt kê bảng / mô tả cột |
| `run_read_query` | Query read-only; `explain:true` để xem EXPLAIN + cảnh báo cost |
| `get_table_relationships` | FK graph (cho JOIN & phân tích impact) |
| `profile_table` | Row count ước lượng + stats cột + sample |
| `data_diff` | So dữ liệu 1 bảng giữa 2 env (count + checksum) |
| `write_preview` / `write_apply` / `write_rollback` | Ghi có review/confirm (cần `PG_WRITE_ENABLED`) |
| `migration_status` / `migration_add` / `migration_preview` / `migration_apply` / `migration_dry_run` | EF Core migrations (cần `PG_MIGRATION_ENABLED`) |
| `compare_environments` | Diff schema (+ row count tùy chọn) giữa 2 env |

Mọi read-tool nhận thêm `environment` và `profile` (`nano`/`compact`/`standard`/`verbose`, mặc định `compact`).

Schema mỗi env cũng được expose dạng **MCP resource**: `schema://<env>`.

## 5. Luồng ghi có review

```jsonc
// 1) Preview (dry-run, rolled back) → nhận previewId + approvalToken + rowsAffected + sample
write_preview { "environment": "dev", "sql": "update conversations set status='closed' where id=$1", "params": [42] }
// 2) Apply (commit) → nhận rollbackId
write_apply { "environment": "dev", "previewId": "...", "approvalToken": "..." }
// 3) Rollback (khôi phục) nếu cần
write_rollback { "rollbackId": "..." }
```

- UPDATE/DELETE thiếu `WHERE` bị chặn (`MISSING_WHERE`) trừ khi `allowFullTable:true`.
- Rollback hỗ trợ INSERT/DELETE đầy đủ; UPDATE chỉ khi bảng có PK, single-table, có WHERE và không dùng params.
- Preview/token sống theo `PG_WRITE_PREVIEW_TTL_MS` (mặc định 15 phút), một preview chỉ apply một lần.

## 6. Luồng migration (EF Core)

```jsonc
migration_status   { "environment": "dev" }                  // applied vs pending
migration_add      { "name": "AddFooColumn" }                // gen file .cs (sửa tay được)
migration_dry_run  { "environment": "dev" }                  // chạy script trong BEGIN...ROLLBACK
migration_preview  { "environment": "dev" }                  // snapshot + script "expect" + token
migration_apply    { "environment": "dev", "previewId": "...", "approvalToken": "..." } // drift-guard + verify
compare_environments { "source": "dev", "target": "staging", "includeRowCounts": true }
```

`dotnet ef` được gọi với argv cố định (không nối shell), tên migration bắt buộc `^[A-Za-z0-9_]+$`, connection inject qua `CH_DB_CONNECTION` cho đúng env.

## 7. Audit

Mọi `write_apply` / `write_rollback` / `migration_apply` được ghi vào bảng `mcp_ops.audit_log` trên DB đích (tự tạo khi dùng lần đầu) và stderr JSON.

## 8. Lưu ý bảo mật

- Mặc định read-only. Ghi/migration phải bật cờ tường minh (`PG_WRITE_ENABLED` / `PG_MIGRATION_ENABLED`). Approval token được ký/xác minh hoàn toàn trong process: nếu không set `PG_WRITE_APPROVAL_SECRET`, MCP tự sinh secret ngẫu nhiên mỗi lần khởi động (token không thể giả mạo, không cần cấu hình). Chỉ set secret nếu muốn token còn hiệu lực qua restart.
- **prod không bao giờ ghi được** (ép read-only bất kể cấu hình).
- Không commit secret vào repo. Không log raw SQL nhạy cảm (chỉ log hash).

## 9. Biến môi trường (env)

> Quy ước: biến số (`*_MS`, limit…) chỉ nhận giá trị **> 0 và hữu hạn**, sai → dùng mặc định. Biến cờ (`*_ENABLED`) bật khi giá trị là `true` hoặc `1`.

### 9.1. Nguồn connection — **bắt buộc ít nhất một**

| Biến | Mặc định | Mô tả |
|---|---|---|
| `CH_DB_CONNECTION` | — | Connection string đơn (legacy) → đăng ký env tên `default`. |
| `PG_ENV_<NAME>` | — | Connection string cho từng env, vd `PG_ENV_DEV`, `PG_ENV_STAGING`, `PG_ENV_PROD`. `<NAME>` được canonical hoá (`PRODUCTION`→`prod`, `DEVELOPMENT`→`dev`…). Ghi đè nguồn từ appsettings. |
| `CH_APPSETTINGS_ROOTS` | — | CSV các thư mục chứa `appsettings*.json`; mỗi `appsettings.<Env>.json` → một env. Quét 1 cấp/thư mục. |
| `CH_CONNECTION_NAME` | `CommunicationHubDb` | Tên key trong `ConnectionStrings` của appsettings để lấy connection. |

Connection string nhận cả `postgres://user:pass@host:5432/db` lẫn `Server=...;Port=...;Database=...;Username=...;Password=...;` (Npgsql-style).

### 9.2. Đa môi trường

| Biến | Mặc định | Mô tả |
|---|---|---|
| `PG_ALLOWED_ENVIRONMENTS` | (rỗng = cho phép tất cả) | CSV allowlist env được nạp; env ngoài danh sách bị bỏ qua. |
| `PG_WRITABLE_ENVIRONMENTS` | `dev,staging,default` | CSV env được phép ghi. **`prod` luôn bị ép read-only** bất kể giá trị này. |
| `PG_DEFAULT_ENVIRONMENT` | `dev` nếu có, không thì `default`, không thì env đầu tiên | Env dùng khi request không nêu `environment`. |

### 9.3. Read query

| Biến | Mặc định | Mô tả |
|---|---|---|
| `MCP_DB_DEFAULT_LIMIT` | `500` | Limit mặc định khi query không nêu `limit`. |
| `MCP_DB_MAX_LIMIT` | `2000` | Trần limit (chặn trên cả `limit` do client gửi). |
| `MCP_DB_DEFAULT_TIMEOUT_MS` | `30000` | `statement_timeout` mặc định / pool. |
| `MCP_DB_MAX_TIMEOUT_MS` | `60000` | Trần `timeoutMs` của một query. |
| `PG_EXPLAIN_COST_WARN` | `1000000` | Ngưỡng cost để gắn `costWarning` khi `run_read_query` chạy với `explain:true`. |

### 9.4. Ghi có review (cần `PG_WRITE_ENABLED`)

| Biến | Mặc định | Mô tả |
|---|---|---|
| `PG_WRITE_ENABLED` | `false` | Bật nhóm tool `write_*`. |
| `PG_WRITE_APPROVAL_SECRET` | (tự sinh ngẫu nhiên/process) | Secret HMAC ký/xác minh approval token. Không cần set; chỉ set nếu muốn token sống qua restart. |
| `PG_WRITE_PREVIEW_TTL_MS` | `900000` (15 phút) | TTL của preview + approval token (dùng chung cho cả migration preview). |
| `PG_WRITE_SAMPLE_LIMIT` | `20` | Số hàng mẫu (`affectedSample`) trả về trong `write_preview`. |

### 9.5. Migration EF Core (cần `PG_MIGRATION_ENABLED`)

| Biến | Mặc định | Mô tả |
|---|---|---|
| `PG_MIGRATION_ENABLED` | `false` | Bật nhóm tool `migration_*` + `compare_environments`. |
| `CH_DOTNET_PROJECT` | — | **Bắt buộc khi bật.** Project chứa `DbContext` + thư mục `Migrations` (vd `src/Infrastructure`). |
| `CH_DOTNET_STARTUP_PROJECT` | — | **Bắt buộc khi bật.** Startup project (vd `src/Web`). |
| `PG_DOTNET_TIMEOUT_MS` | `120000` | Timeout cho mỗi lệnh `dotnet ef`. |
