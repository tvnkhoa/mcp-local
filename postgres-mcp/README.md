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

<!-- BEGIN GENERATED: tool-list -->

17 tools, namespaced `mcp__postgres-mcp__<tool>`:

- `compare_environments`
- `data_diff`
- `describe_table`
- `get_table_relationships`
- `health_check`
- `list_environments`
- `list_tables`
- `migration_add`
- `migration_apply`
- `migration_dry_run`
- `migration_preview`
- `migration_status`
- `profile_table`
- `run_read_query`
- `write_apply`
- `write_preview`
- `write_rollback`

<!-- END GENERATED: tool-list -->

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

<!-- BEGIN GENERATED: env-table -->

| Variable | Required | Default | Notes |
|---|---|---|---|
| `POSTGRES_CONNECTION` | one of `connection-source` | — | **secret** · renamed — still accepts `CH_DB_CONNECTION` · Connection source. Need ONE of: POSTGRES_CONNECTION \| POSTGRES_ENV_* \| POSTGRES_APPSETTINGS_ROOTS. |
| `POSTGRES_APPSETTINGS_ROOTS` | one of `connection-source` | — | renamed — still accepts `CH_APPSETTINGS_ROOTS` · Alternative connection source: discover connection strings from .NET appsettings*.json. |
| `POSTGRES_ENV_*` | one of `connection-source` | — | **secret** · renamed — still accepts `PG_ENV_` · Per-env connection strings, declared directly instead of discovered from appsettings. Any one satisfies the connection source. `POSTGRES_ENV_*` is a family, not a literal var name — the trailing underscore is part of the prefix, so POSTGRES_ENVIRONMENT would not count (and no such var exists). The legacy `PG_ENV_` prefix is still accepted. |
| `POSTGRES_CONNECTION_NAME` | no | `CommunicationHubDb` | renamed — still accepts `CH_CONNECTION_NAME` · Which named connection to pick out of appsettings. |
| `POSTGRES_ALLOWED_ENVIRONMENTS` | no | `dev` | renamed — still accepts `PG_ALLOWED_ENVIRONMENTS` |
| `POSTGRES_WRITABLE_ENVIRONMENTS` | no | — | renamed — still accepts `PG_WRITABLE_ENVIRONMENTS` · prod is ALWAYS read-only regardless of this value. |
| `POSTGRES_DEFAULT_ENVIRONMENT` | no | `dev` | renamed — still accepts `PG_DEFAULT_ENVIRONMENT` |
| `POSTGRES_DEFAULT_LIMIT` | no | `500` | renamed — still accepts `MCP_DB_DEFAULT_LIMIT` |
| `POSTGRES_MAX_LIMIT` | no | `2000` | renamed — still accepts `MCP_DB_MAX_LIMIT` |
| `POSTGRES_DEFAULT_TIMEOUT_MS` | no | `30000` | renamed — still accepts `MCP_DB_DEFAULT_TIMEOUT_MS` |
| `POSTGRES_MAX_TIMEOUT_MS` | no | `60000` | renamed — still accepts `MCP_DB_MAX_TIMEOUT_MS` |
| `POSTGRES_EXPLAIN_COST_WARN` | no | `1000000` *(code)* | renamed — still accepts `PG_EXPLAIN_COST_WARN` · EXPLAIN cost above which a read query is flagged as expensive. |
| `POSTGRES_WRITE_ENABLED` | no | `false` | renamed — still accepts `PG_WRITE_ENABLED` · Data writes (preview→apply→rollback) OFF unless true. Parsed strictly: exact "true" or "1". |
| `POSTGRES_WRITE_APPROVAL_SECRET` | no | — | **secret** · renamed — still accepts `PG_WRITE_APPROVAL_SECRET` · Auto-generated per process if empty; set to keep tokens valid across restarts. |
| `POSTGRES_WRITE_PREVIEW_TTL_MS` | no | `900000` *(code)* | renamed — still accepts `PG_WRITE_PREVIEW_TTL_MS` · Write-preview lifetime — 15 minutes. |
| `POSTGRES_WRITE_SAMPLE_LIMIT` | no | `20` *(code)* | renamed — still accepts `PG_WRITE_SAMPLE_LIMIT` · Rows sampled into a write preview. |
| `POSTGRES_MIGRATION_ENABLED` | no | `false` | renamed — still accepts `PG_MIGRATION_ENABLED` · EF Core migration tooling OFF unless true. Parsed strictly: exact "true" or "1". |
| `POSTGRES_MIGRATION_PREVIEW_TTL_MS` | no | `3600000` *(code)* | renamed — still accepts `PG_MIGRATION_PREVIEW_TTL_MS` · Migration-preview lifetime — 1 hour. |
| `POSTGRES_DOTNET_PROJECT` | no | — | renamed — still accepts `CH_DOTNET_PROJECT` · Path to the EF Core project (the one holding the DbContext). |
| `POSTGRES_DOTNET_STARTUP_PROJECT` | no | — | renamed — still accepts `CH_DOTNET_STARTUP_PROJECT` · Startup project passed to `dotnet ef --startup-project`. |
| `POSTGRES_DOTNET_TIMEOUT_MS` | no | `120000` *(code)* | renamed — still accepts `PG_DOTNET_TIMEOUT_MS` · Timeout for a `dotnet ef` invocation. |
| `PGSSLMODE` | no | — | libpq's own TLS mode (`disable` \| `require` \| `verify-ca` \| `verify-full`), read by the driver, not by this server. Set it when the target requires TLS but the connection string does not say so. |
| `NODE_TLS_REJECT_UNAUTHORIZED` | no | — | Set to 0 ONLY if the database host presents a self-signed/untrusted TLS certificate. This is a Node flag, not a server setting, and it disables certificate verification for the WHOLE process — every outbound TLS connection, not just Postgres. Prefer `PGSSLMODE=verify-full` with a trusted CA. |

23 variables. Defaults marked *(code)* are the server's own fallback and are **not** written into your agent config — set them only to override.

<!-- END GENERATED: env-table -->
