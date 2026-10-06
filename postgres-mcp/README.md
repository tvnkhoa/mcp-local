# PostgreSQL MCP

MCP server cho PostgreSQL, **mặc định read-only**, các năng lực khác bật dần qua env:

1. **Read-only query** (luôn bật) — `SELECT` / `WITH ... SELECT`, single-statement, giới hạn limit/timeout.
2. **Đa môi trường** — chọn DB theo `environment` (dev/staging/prod), discover connection từ `appsettings*.json` hoặc env var. **prod luôn read-only.**
3. **Ghi có review/confirm** (bật bằng `POSTGRES_WRITE_ENABLED`) — `write_preview` → `write_apply` → `write_rollback`, HMAC approval token, bắt buộc WHERE, dry-run, audit log.
4. **EF Core migrations** (bật bằng `POSTGRES_MIGRATION_ENABLED`) — snapshot → preview → apply → verify, dry-run, so sánh schema giữa env.
5. **Raw-SQL DDL migrations** (bật bằng `POSTGRES_DDL_ENABLED`) — file `.sql` có version hoặc SQL inline; preview → dry-run → apply có risk gate, ledger, drift guard và rollback qua `.down.sql` (§6b).

## 1. Cài đặt

```powershell
cd D:/1.SourceCode/mcp-local/postgres-mcp
npm install
npm run build
```

## 2. Cấu hình

Copy `.env.example` và chỉnh. Tối thiểu cần một nguồn connection (xem `.env.example`):
- `POSTGRES_CONNECTION`  *(1 env; cũ: `CH_DB_CONNECTION`)*, **hoặc**
- `POSTGRES_APPSETTINGS_ROOTS` + `POSTGRES_CONNECTION_NAME` (đọc từ appsettings), **hoặc**
- `POSTGRES_ENV_DEV` / `POSTGRES_ENV_STAGING` / `POSTGRES_ENV_PROD`.

Connection string nhận cả `postgres://...` lẫn `Server=...;Database=...;User Id=...;Password=...;`.

## 3. Chạy

```powershell
npm run dev      # tsx, không cần build
# hoặc
npm run build; npm start
```

## 4. Tools

<!-- BEGIN GENERATED: tool-list -->

22 tools, namespaced `mcp__postgres-mcp__<tool>`:

- `compare_environments`
- `data_diff`
- `ddl_apply`
- `ddl_create`
- `ddl_dry_run`
- `ddl_preview`
- `ddl_status`
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
| `write_preview` / `write_apply` / `write_rollback` | Ghi có review/confirm (cần `POSTGRES_WRITE_ENABLED`) |
| `migration_status` / `migration_add` / `migration_preview` / `migration_apply` / `migration_dry_run` | EF Core migrations (cần `POSTGRES_MIGRATION_ENABLED`) |
| `compare_environments` | Diff schema (+ row count tùy chọn) giữa 2 env |
| `ddl_status` / `ddl_create` / `ddl_preview` / `ddl_dry_run` / `ddl_apply` | Raw-SQL DDL migrations (cần `POSTGRES_DDL_ENABLED`), §6b |

Mọi read-tool nhận thêm `environment` và `profile` (`nano`/`compact`/`standard`/`verbose`, mặc định `compact`).

Schema mỗi env cũng được expose dạng **MCP resource**: `schema://<env>`.

Snapshot (từ v2, trường `snapshotVersion: 2`) có hai phần:

- `tables`: cột, index, constraint của từng bảng.
- `objects`: view/materialized view, sequence (chỉ tham số, không lấy `last_value`), enum (giữ thứ tự label), domain, function/procedure, trigger (bỏ trigger nội bộ của FK), extension (tên + version).

Với view, function và trigger, snapshot chỉ lưu md5 của định nghĩa để payload nhỏ gọn. Object do extension tạo ra (như `vector`, `pg_trgm`) bị loại. Riêng extension thì vẫn có mặt, kèm version.

`compare_environments` và `migration_apply` trả thêm `diff.objectChanges`, trong đó chỉ có các loại object thực sự thay đổi, mỗi loại gồm `added` / `removed` / `changed`.

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
- Preview/token sống theo `POSTGRES_WRITE_PREVIEW_TTL_MS` (mặc định 15 phút), một preview chỉ apply một lần.

**Rollback không phải lúc nào cũng có.** Nguyên tắc: chỉ hỗ trợ khi server tự nắm được dữ liệu
hoàn nguyên. `write_preview` luôn trả `rollbackSupported`, và `rollbackNote` nói rõ lý do khi
không — **đọc nó trước khi apply**, vì `write_apply` sẽ trả `rollbackId: null` và lúc đó không còn
đường lùi. Các trường hợp bị từ chối:

| Trường hợp | Vì sao |
|---|---|
| Bảng không có primary key | không định danh được dòng để khôi phục |
| Câu lệnh tự viết `RETURNING` | capture cần tự gắn `returning *, xmin` |
| `INSERT ... ON CONFLICT DO UPDATE` | có thể sửa dòng đã tồn tại, không capture được giá trị cũ (`DO NOTHING` thì **được** hỗ trợ) |
| `UPDATE` gán vào cột PK | khôi phục theo PK đã capture sẽ không khớp dòng nào |
| `UPDATE` có SET list không đọc được chắc chắn (ví dụ comment nằm giữa `set` và tên cột) | không biết được nó có gán vào PK hay không, nên không dám nhận |
| `UPDATE` có params / có `FROM`-join / không `WHERE` | snapshot chạy lại chính `WHERE` đó nên nó phải tự đủ |
| Ảnh hưởng > 10.000 dòng | snapshot nằm trong RAM; chia nhỏ theo batch |

`write_apply` cũng có thể **hạ** quyết định của preview: nếu số dòng capture được không khớp số
dòng thực sự bị ảnh hưởng thì undo sẽ không đầy đủ, nên nó trả `rollbackId: null` kèm
`rollbackNote` thay vì đưa ra một rollback chỉ hoàn nguyên được một phần mà không nói.

- Rollback khôi phục **từng dòng độc lập** (mỗi dòng một `SAVEPOINT`): một dòng xung đột không
  làm mất phần còn lại. Response trả `status` của lần gọi đó (`restored` / `partial` / `failed`),
  `pending` là số dòng còn lại, và `unrestored[]` nêu lý do từng dòng — `row_changed_since_apply`,
  `row_missing`, `version_unavailable`, `no_restorable_columns`, hoặc `conflict` kèm `sqlState`
  (SQLSTATE của Postgres, để phân biệt vi phạm khóa ngoại với deadlock hay timeout). Một rollback
  `partial` hay `failed` **vẫn gọi lại được**, và lần sau chỉ chạm những dòng còn thiếu.
- Dòng bị người/hệ thống khác sửa sau khi apply thì **không bị ghi đè**: rollback so `xmin` (row
  version của Postgres) và báo `row_changed_since_apply` thay vì xóa mất thay đổi đó.
- Rollback record chỉ nằm trong RAM tiến trình: restart hoặc quá 1.000 apply gần nhất thì
  `rollbackId` trả `ROLLBACK_NOT_FOUND`. Nhật ký bền nằm ở `mcp_ops.audit_log` trên chính database.

## 6. Luồng migration (EF Core)

```jsonc
migration_status   { "environment": "dev" }                  // applied vs pending
migration_add      { "name": "AddFooColumn" }                // gen file .cs (sửa tay được)
migration_dry_run  { "environment": "dev" }                  // chạy đúng SQL preview hiển thị, từng statement, trong BEGIN...ROLLBACK
migration_preview  { "environment": "dev" }                  // snapshot + script "expect" + token
migration_apply    { "environment": "dev", "previewId": "...", "approvalToken": "..." } // drift-guard + verify
migration_preview  { "environment": "dev", "targetMigration": "20260101000000_Init" } // ROLLBACK: revert mọi migration apply sau Init ("0" = tất cả)
migration_apply    { "previewId": "...", "approvalToken": "...", "acknowledgeRisks": ["EF_REVERT", "DROP_TABLE"] }
compare_environments { "source": "dev", "target": "staging", "includeRowCounts": true }
```

`dotnet ef` được gọi với argv cố định (không nối shell), tên migration bắt buộc `^[A-Za-z0-9_]+$`, connection inject qua `CH_DB_CONNECTION` cho đúng env (tên này là **outbound contract** với project .NET, không phải config của server — xem `docs/reference/dependency-rules.md` §4).

`migration_dry_run` chạy đúng phần SQL mà `migration_preview` hiển thị: delta, hoặc script idempotent khi tập pending không liên tục. Script được tách bằng tokenizer của lane DDL rồi chạy từng statement, nên khi lỗi sẽ chỉ ra đúng statement và SQLSTATE (`failure`). Lệnh điều khiển transaction bị bỏ ở mọi dạng viết, kể cả `commit;` nằm chung dòng với lệnh khác. Statement không chạy được trong transaction (`CONCURRENTLY`, `VACUUM`) bị bỏ qua và liệt kê trong `skipped`; nếu cả script đều như vậy thì kết quả là `not_dry_runnable`.

**Rollback:** `migration_preview { targetMigration }` lập plan revert về một migration đã apply, hoặc `"0"` để revert tất cả. Script là SQL của các hàm Down (`dotnet ef migrations script <latest> <target>`). Khi apply sẽ chạy `dotnet ef database update <target>`. `migration_apply` bắt buộc có `acknowledgeRisks` chứa `EF_REVERT`, cộng thêm mọi mã high mà risk lint của lane DDL tìm thấy trong SQL Down (ví dụ `DROP_TABLE`, `DROP_COLUMN`). Drift guard của rollback so sánh danh sách migration **đã apply**: một migration được apply hoặc revert chen vào giữa preview và apply sẽ bị chặn. Target chưa được apply bị từ chối (`MIGRATION_UNKNOWN_TARGET`). Plan up cũng trả `risks` (chỉ để tham khảo, không bắt buộc acknowledge).

`lock_timeout`: mọi lần gọi `dotnet ef` đều nhận `Options=-c lock_timeout=N` ghép vào connection string. N lấy từ `POSTGRES_MIGRATION_LOCK_TIMEOUT_MS`, mặc định 5000; đặt `0` để tắt. Cần Npgsql 5 trở lên. Dry run cũng dùng cùng mức chờ này. Kết quả của `migration_preview` và `migration_apply` có trường `lockTimeout.applied` để báo mức chờ có thật sự được áp hay không. Hai trường hợp không được áp: connection string dạng `postgres://` URI (Npgsql không đọc được), hoặc connection string đã tự đặt `lock_timeout` (giữ nguyên lựa chọn của người vận hành).

Giữa các process: `migration_apply` giữ cùng advisory lock với lane DDL (`pg_try_advisory_lock`, trên một session phụ), từ lúc kiểm tra drift cho tới khi chụp snapshot sau apply. Một lần apply ở process khác, dù ở lane EF hay lane DDL, sẽ bị từ chối ngay (`MIGRATION_LOCKED` / `DDL_LOCKED`) chứ không chờ. Preview vẫn còn hiệu lực, nên retry được bằng chính preview đó. Lock này cần kết nối trực tiếp, không hoạt động qua PgBouncer ở chế độ transaction pooling.

`migration_apply` dùng chung một mutex theo từng môi trường với `write_apply` / `write_rollback`. Trên cùng một DB, migration và thao tác ghi dữ liệu chạy lần lượt: một lệnh ghi phải đợi migration đang chạy xong. Nếu hai lần apply cùng một preview được gọi đồng thời, lần sau sẽ nhận `PREVIEW_NOT_FOUND`. Mutex chỉ có hiệu lực trong một process server.

## 6b. Luồng DDL (raw SQL)

Đây là lane migration bằng SQL thuần, độc lập với EF Core. Lane **TẮT** cho tới khi đặt `POSTGRES_DDL_ENABLED=true`. Lane ghi được vào đúng những môi trường mà write lane ghi được (`POSTGRES_WRITABLE_ENVIRONMENTS`); `prod` luôn chỉ đọc.

```jsonc
ddl_status  { "environment": "dev" }                         // applied / pending / file bị sửa / file mất / sai thứ tự — chỉ đọc, chạy được trên prod
ddl_create  { "name": "add_orders_note",
              "up":   "alter table orders add column note text",
              "down": "alter table orders drop column if exists note" }  // chỉ ghi file, không chạm DB
ddl_preview { "environment": "dev" }                         // plan + risks + approvalToken; không thực thi gì
ddl_dry_run { "previewId": "..." }                           // chạy trong 1 transaction rồi ROLLBACK
ddl_apply   { "previewId": "...", "approvalToken": "...",
              "acknowledgeRisks": ["DROP_COLUMN"] }          // chỉ khi preview có requiredAcknowledgements
```

**Rollback** cũng đi qua `ddl_preview { "direction": "down", "target": "<version>" }`: revert mọi migration mới hơn `target`, từ mới về cũ, bằng file `.down.sql` của chúng (`"0"` nghĩa là revert tất cả). Rollback đi qua đúng preview → token → apply như chiều up, không có tool riêng.

**Inline:** `ddl_preview { "sql": "create index concurrently …", "noTransaction": true, "label": "orders_idx" }` chạy DDL không cần file. Nếu sau đó lưu đúng SQL đó thành file bằng `ddl_create`, lần `up` kế tiếp sẽ **adopt** file (chỉ ghi vào ledger, không chạy lại).

### Input

| Tool | Tham số |
|---|---|
| `ddl_status` | `environment?`, `profile?` |
| `ddl_create` | `name` (`^[a-z0-9_]{1,100}$`), `up`, `down?` (≤ 256 KB mỗi script), `noTransaction?`, `version?` (14 chữ số), `profile?` |
| `ddl_preview` | Chế độ file: `direction?` (`up`\|`down`), `target?` (`^\d{14}$`, prefix `^\d{4,13}$` khi dùng ledger của repo, hoặc `"0"`), `allowOutOfOrder?`. Chế độ inline: `sql`, `label?`, `noTransaction?`. Không được trộn tham số của hai chế độ (`DDL_INVALID_ARGS`). Luôn có `environment?`, `profile?`; `sql` của từng bước chỉ hiện ở `profile: "verbose"` |
| `ddl_dry_run` | `previewId`, `profile?` |
| `ddl_apply` | `previewId`, `approvalToken`, `acknowledgeRisks?` (≤ 50 mã), `profile?` |

### Quy tắc

- **Tên file:** `V<yyyymmddhhmmss>__<name>.up.sql` + `.down.sql` (tuỳ chọn), đặt trong `POSTGRES_DDL_MIGRATIONS_DIR`. `ddl_create` không bao giờ ghi đè file có sẵn.
- **Checksum:** sha256 của nội dung file, bỏ qua BOM, CRLF và khoảng trắng ở cuối. File đã apply mà bị sửa thì mọi plan theo file đều bị chặn (`DDL_CHECKSUM_MISMATCH`). Khôi phục file gốc, rồi viết migration mới cho thay đổi.
- **Lệnh được phép:** `CREATE` / `ALTER` / `DROP` trên table, index, view, materialized view, sequence, type, domain, schema, function (sql/plpgsql), procedure, trigger, policy; cộng thêm `COMMENT ON` và `CREATE EXTENSION`.
- **Quyền và owner** (ADR 0005, Decision 2 đã sửa đổi): đều cần acknowledge `PRIVILEGE_CHANGE`.
  - `GRANT` / `REVOKE` trên một object có tên (table, sequence, function, procedure, routine, schema), cho role có tên hoặc `PUBLIC`.
  - `CREATE` / `ALTER` / `DROP POLICY`, và `ALTER TABLE … DISABLE ROW LEVEL SECURITY` / `NO FORCE …`.
  - `ALTER <table|view|sequence|type|domain|schema|function|procedure> … OWNER TO <role>`: phải là action duy nhất của statement, và `<role>` phải nằm trong `POSTGRES_DDL_OWNER_ROLES` (mặc định rỗng = từ chối mọi `OWNER TO`).
  - `CREATE SCHEMA [IF NOT EXISTS] [name] AUTHORIZATION <role>`, với `<role>` trong `POSTGRES_DDL_OWNER_ROLES`. Không được có schema element đi kèm.
  - Với cả hai dạng trên, lúc preview role được đọc từ `pg_roles`: role không tồn tại thì bị `OWNER_ROLE_UNKNOWN`; role có `SUPERUSER` / `CREATEROLE` / `BYPASSRLS` / `REPLICATION` thì bị `OWNER_ROLE_PRIVILEGED`, dù có trong allowlist; role mà migration không `SET ROLE` sang được thì bị `OWNER_ROLE_NOT_MEMBER`. Ngoại lệ: role có quyền đặc biệt nhưng **chính là login** đang kết nối (ví dụ `POSTGRES_USER` của Postgres docker local, vốn là superuser) thì chỉ cảnh báo, vì giao object cho chính login không cho thêm quyền gì.
- **Dữ liệu và `DO`** (ADR 0005, Decision 2 đã sửa đổi lần hai):
  - `INSERT` / `UPDATE` / `DELETE` (kể cả `INSERT … SELECT`) chỉ được nhận trong file của repo có ledger riêng (`POSTGRES_DDL_EXTERNAL_LEDGER`), và cần acknowledge `DATA_CHANGE`. `ddl_dry_run` và `ddl_apply` báo số row của từng statement trong `rowsAffected`. Inline SQL và file của ledger `mcp_ops` vẫn từ chối DML; dùng `write_preview`.
  - `DO [LANGUAGE plpgsql] $$ … $$` cần acknowledge `DO_BLOCK`. **Thân block không bị kiểm tra**: một `DO` đã acknowledge sẽ chạy mọi thứ bên trong, kể cả lệnh mà lane từ chối khi đứng riêng (ví dụ `CREATE ROLE`). Hãy đọc thân block trước khi acknowledge.
- **Session role:** đặt `POSTGRES_DDL_SESSION_ROLE` thì statement của mỗi migration chạy dưới `SET ROLE <role>`, nên object mới thuộc về role đó chứ không thuộc login cá nhân (tương đương `PGOPTIONS='-c role=…'` của runner). Role phải nằm trong `POSTGRES_DDL_OWNER_ROLES`. Lúc preview, nếu role không tồn tại, có thuộc tính bị cấm, hoặc login không `SET ROLE` sang được, thì preview bị từ chối (`DDL_SESSION_ROLE_UNKNOWN` / `_PRIVILEGED` / `_NOT_MEMBER`). Riêng session role có quyền đặc biệt mà trùng với login thì chỉ là cảnh báo trong preview, vì `SET ROLE` sang chính mình không cho thêm quyền gì (trường hợp Postgres docker local). Dòng ledger và audit log vẫn được ghi bằng login. Preview trả `runsAs`, và role được tính vào approval digest.
- **Lệnh bị từ chối:**
  - DML ngoài trường hợp ở trên: dữ liệu đi qua `write_preview`. Pattern chuẩn: thêm cột nullable (ddl) → backfill (`write_preview`) → `SET NOT NULL` (ddl). `MERGE`, `TRUNCATE`, `COPY`, `WITH …` và `SELECT` luôn bị từ chối.
  - `DO` bằng ngôn ngữ khác `plpgsql`, và `CALL`.
  - ROLE, membership (`GRANT role TO role`), `WITH GRANT OPTION`, `GRANTED BY`, `ON ALL … IN SCHEMA`, `ON DATABASE` / `PARAMETER` / `LANGUAGE` / …, `ALTER DEFAULT PRIVILEGES` (mọi dạng; REVOKE theo schema cũng không giúp được gì, vì nó chỉ gỡ được một GRANT theo schema trước đó), `REASSIGN OWNED`, `CURRENT_USER` / `SESSION_USER` / `CURRENT_ROLE`.
  - `SET` / `BEGIN` và các lệnh điều khiển transaction.
  - VACUUM và các lệnh bảo trì.
  - Mọi tham chiếu tới `mcp_ops`.
- **Transaction:** mỗi migration chạy trong một transaction riêng, cùng với dòng ledger của nó. Gặp lỗi đầu tiên thì dừng; các migration trước đó vẫn giữ nguyên trạng thái đã commit.
- **`CONCURRENTLY`:** cần `-- mcp:no-transaction` (hoặc `noTransaction: true`), và migration chỉ được có đúng một statement. Dry run sẽ bỏ qua và báo `skipped`. Tương tự, một migration dùng giá trị enum mà migration trước trong cùng plan vừa thêm sẽ được dry run báo `skipped` (`ENUM_VALUE_UNCOMMITTED`), vì Postgres chỉ cho dùng giá trị đó sau khi commit; apply thì commit từng migration nên không bị ảnh hưởng. Nếu build index thất bại để lại index INVALID, response sẽ chỉ tên index đó (`invalidIndexesLeft`).
- **Risk:** `ddl_preview` báo risk của từng migration. Các mã mức `high` (`DROP_TABLE`, `DROP_COLUMN`, `ALTER_COLUMN_TYPE`, `SET_NOT_NULL`, `RENAME_*`, `ADD_COLUMN_VOLATILE_DEFAULT`, `SECURITY_DEFINER`, `CREATE_EXTENSION`, `PRIVILEGE_CHANGE`, `DATA_CHANGE`, `DO_BLOCK`, …) phải có trong `acknowledgeRisks`, nếu không sẽ bị `DDL_RISK_NOT_ACKNOWLEDGED`. `DROP SCHEMA … CASCADE` thì luôn bị chặn.
- **Drift:** `ddl_apply` lập lại plan dưới advisory lock, rồi từ chối với `DDL_DRIFT` nếu ledger, schema hoặc file migration đã thay đổi kể từ lúc preview. Mỗi preview chỉ apply được một lần.
- **Đồng thời:**
  - Advisory lock `pg_try_advisory_lock` cho từng database: một process khác đang apply thì trả `DDL_LOCKED`, không chờ.
  - Trong cùng một process, lane DDL dùng chung mutex theo môi trường với write lane và EF lane.
  - Lock này không hoạt động sau PgBouncer ở chế độ transaction pooling, nên lane cần kết nối trực tiếp. Nếu phát hiện session bị chuyển sang backend khác, hoặc lock không còn nằm trên backend hiện tại, server sẽ từ chối với `DDL_POOLED_CONNECTION` / `MIGRATION_POOLED_CONNECTION` (PG-DDL-002). Riêng trường hợp pooler luôn trả về đúng một backend thì không phát hiện được.
- **Ghi vào `mcp_ops` lúc chạy** (qua default expression, trigger hay function mà migration gọi) bị phát hiện, migration bị rollback và trả `DDL_RESERVED_SCHEMA`.

### Limit và timeout

| Env | Mặc định | Ý nghĩa |
|---|---|---|
| `POSTGRES_DDL_LOCK_TIMEOUT_MS` | 5000 | `lock_timeout` cho mỗi migration. Directive `-- mcp:lock-timeout-ms=N` chỉ được hạ, không được nâng |
| `POSTGRES_DDL_STATEMENT_TIMEOUT_MS` | 300000 | `statement_timeout` mặc định cho mỗi statement |
| `POSTGRES_DDL_MAX_STATEMENT_TIMEOUT_MS` | 3600000 | Trần cho directive `-- mcp:statement-timeout-ms=N` |
| `POSTGRES_DDL_PREVIEW_TTL_MS` | 3600000 | Thời gian sống của preview trong bộ nhớ |

Ngoài ra: tối đa 256 KB và 200 statement cho mỗi migration. Giá trị vượt giới hạn bị từ chối (`DDL_DIRECTIVE_EXCEEDS_LIMIT`), không lặng lẽ bị kẹp về giới hạn. Bước lập plan lúc apply dùng lock wait ngắn nhất trong plan, nên một bảng đang bị khoá sẽ fail nhanh (`DDL_LOCK_TIMEOUT`) chứ không treo.

### Ledger của repo (`POSTGRES_DDL_EXTERNAL_LEDGER`)

Dùng khi repo đã có runner riêng (ví dụ `db/migrate.sh` của wec.aria) với file psql `NNNN-<name>.sql` và bảng ledger `(filename, checksum)`. Lane sẽ đọc và ghi **đúng bảng đó**, nên runner của repo và `ddl_*` thay nhau apply được mà không có ledger thứ hai (ADR 0005, Decision 7).

```bash
POSTGRES_DDL_ENABLED=true
POSTGRES_DDL_MIGRATIONS_DIR=D:/repo/db/migrations
POSTGRES_DDL_EXTERNAL_LEDGER=public.schema_migration
POSTGRES_DDL_OWNER_ROLES=aria                       # tuỳ chọn: cho phép OWNER TO aria
POSTGRES_DDL_SESSION_SETTINGS=aria.expected_market=AU   # tuỳ chọn: set_config(…, local) trước mỗi migration
POSTGRES_DDL_ADOPTION_SENTINEL=public.chunks        # tuỳ chọn: chặn apply lên schema có sẵn mà ledger rỗng
```

- **Checksum** là sha256 của **byte thô** trong file, giống hệt `sha256sum`, không bỏ BOM/CRLF. File có CRLF sẽ có cảnh báo, vì ledger ghi từ một checkout LF sẽ không khớp.
- **Thứ tự** theo tên file. `target` là prefix số (`"0017"`). Hai file trùng prefix bị từ chối (`DDL_DUPLICATE_VERSION`).
- **Tương thích psql:** dòng `\set ON_ERROR_STOP …` bị bỏ qua; mọi meta-command khác (`\i`, `\c`, `\gexec`, …) bị từ chối (`DDL_PSQL_META_COMMAND`). Cặp `BEGIN;` … `COMMIT;` bao toàn file được bỏ, vì server tự mở transaction đó; `BEGIN` / `COMMIT` ở chỗ khác vẫn bị từ chối.
- **Một transaction:** statement của file và dòng ledger commit cùng nhau, hoặc không cái nào.
- **Down:** file `NNNN-slug.down.sql` (cùng prefix và slug) là down của `NNNN-slug.sql`; nó không bao giờ là migration pending. `ddl_preview { direction: "down", target: "NNNN" }` revert mọi file đã apply có số lớn hơn `NNNN`, file mới nhất trước, mỗi file một transaction, và xoá dòng ledger của file up **trong cùng transaction** đó (khớp cả tên file lẫn checksum, nếu không thì rollback với `DDL_DRIFT`). Thiếu down ở bất kỳ bước nào thì cả plan bị từ chối trước khi chạy gì (`DDL_NO_DOWN_SCRIPT`). Down không có checksum trong ledger, nên vẫn sửa được sau khi up đã chạy; nó được gắn vào approval digest của preview.
- **Chỉ có file:** SQL inline (`DDL_INLINE_UNSUPPORTED`) và `ddl_create` (`DDL_CREATE_UNSUPPORTED`) bị từ chối.
- **Lane không tạo bảng ledger.** Env không có bảng này thì `ddl_preview` / `ddl_apply` trả `DDL_LEDGER_MISSING` ngay từ đầu, trước cả kiểm tra session role, kèm tên env (và `ddl_status` cảnh báo). Thường đó là gọi nhầm env: config DDL mô tả database của một repo, nên hãy truyền `environment` của database đó. Nếu đúng env thì tạo bảng bằng runner của repo. Ledger ghi một file dưới tên khác với file trên đĩa thì bị `DDL_LEDGER_FILENAME_MISMATCH`, vì runner của repo sẽ apply lại file đã đổi tên.
- **Adoption guard:** khi `POSTGRES_DDL_ADOPTION_SENTINEL` tồn tại mà ledger rỗng thì plan up bị `DDL_ADOPTION_REQUIRED`. Baseline ledger trước.
- Lần apply thất bại không ghi vào ledger của repo (ledger đó không có khái niệm "failed"), nhưng vẫn có trong `mcp_ops.audit_log`.
- Giá trị env sai (tên bảng, role, setting) không bị bỏ qua: mọi tool `ddl_*` trả `DDL_CONFIG_INVALID` kèm tên biến.

### Ví dụ an toàn

```sql
-- V20261001093000__add_orders_note.up.sql
alter table orders add column if not exists note text;

-- V20261001093000__add_orders_note.down.sql
alter table orders drop column if exists note;
```

Down script `drop column` cũng được tính là risk: lúc rollback, apply sẽ yêu cầu `acknowledgeRisks: ["DROP_COLUMN"]`.

## 7. Audit

Mọi `write_apply` / `write_rollback` / `migration_apply` / `ddl_apply` được ghi vào bảng `mcp_ops.audit_log` trên DB đích (tự tạo khi dùng lần đầu) và stderr JSON.

Lane DDL còn có ledger riêng là `mcp_ops.ddl_history` (append-only), ghi lại mọi lần apply/revert, kể cả lần thất bại. Khi đặt `POSTGRES_DDL_EXTERNAL_LEDGER` thì ledger của repo thay thế bảng này, và `mcp_ops.ddl_history` không được dùng.

Schema `mcp_ops` thuộc về server, không phải schema của ứng dụng:

- Không ghi được qua `write_preview`. Lệnh ghi vào đó bị trả `WRITE_RESERVED_SCHEMA`. Server kiểm tra hai lần: lúc parse SQL, rồi trên plan mà Postgres resolve ra (`EXPLAIN`), nên viết `mcp_ops . audit_log` hay chèn comment quanh dấu chấm cũng không lọt. Trigger trên bảng của ứng dụng mà ghi vào `mcp_ops` cũng bị chặn, cả khi preview lẫn khi apply.
- Bảng đích (`targetTable`, PK dùng cho rollback) được lấy từ plan Postgres resolve ra, không phải đoán từ SQL.
- Không có trong snapshot schema. `compare_environments`, resource `schema://<env>` và drift guard của `migration_apply` đều bỏ qua nó (PG-MIG-005).

## 8. Lưu ý bảo mật

- Mặc định read-only. Ghi/migration phải bật cờ tường minh (`POSTGRES_WRITE_ENABLED` / `POSTGRES_MIGRATION_ENABLED`). Approval token được ký/xác minh hoàn toàn trong process: nếu không set `POSTGRES_APPROVAL_SECRET`, MCP tự sinh secret ngẫu nhiên mỗi lần khởi động (token không thể giả mạo, không cần cấu hình). Chỉ set secret nếu muốn token còn hiệu lực qua restart.
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
| `POSTGRES_EXPLAIN_COST_WARN_THRESHOLD` | no | `1000000` *(code)* | renamed — still accepts `POSTGRES_EXPLAIN_COST_WARN`, `PG_EXPLAIN_COST_WARN` · EXPLAIN cost above which a read query is flagged as expensive. |
| `POSTGRES_WRITE_ENABLED` | no | `false` | renamed — still accepts `PG_WRITE_ENABLED` · Data writes (preview→apply→rollback) OFF unless true. Parsed strictly: exact "true" or "1". |
| `POSTGRES_APPROVAL_SECRET` | no | — | **secret** · renamed — still accepts `POSTGRES_WRITE_APPROVAL_SECRET`, `PG_WRITE_APPROVAL_SECRET` · Auto-generated per process if empty; set to keep tokens valid across restarts. |
| `POSTGRES_WRITE_PREVIEW_TTL_MS` | no | `900000` *(code)* | renamed — still accepts `PG_WRITE_PREVIEW_TTL_MS` · Write-preview lifetime — 15 minutes. |
| `POSTGRES_WRITE_SAMPLE_LIMIT` | no | `20` *(code)* | renamed — still accepts `PG_WRITE_SAMPLE_LIMIT` · Rows sampled into a write preview. |
| `POSTGRES_MIGRATION_ENABLED` | no | `false` | renamed — still accepts `PG_MIGRATION_ENABLED` · EF Core migration tooling OFF unless true. Parsed strictly: exact "true" or "1". |
| `POSTGRES_MIGRATION_PREVIEW_TTL_MS` | no | `3600000` *(code)* | renamed — still accepts `PG_MIGRATION_PREVIEW_TTL_MS` · Migration-preview lifetime — 1 hour. |
| `POSTGRES_MIGRATION_DOTNET_PROJECT` | no | — | renamed — still accepts `POSTGRES_DOTNET_PROJECT`, `CH_DOTNET_PROJECT` · Path to the EF Core project (the one holding the DbContext). |
| `POSTGRES_MIGRATION_DOTNET_STARTUP_PROJECT` | no | — | renamed — still accepts `POSTGRES_DOTNET_STARTUP_PROJECT`, `CH_DOTNET_STARTUP_PROJECT` · Startup project passed to `dotnet ef --startup-project`. |
| `POSTGRES_MIGRATION_DOTNET_TIMEOUT_MS` | no | `120000` *(code)* | renamed — still accepts `POSTGRES_DOTNET_TIMEOUT_MS`, `PG_DOTNET_TIMEOUT_MS` · Timeout for a `dotnet ef` invocation. |
| `POSTGRES_MIGRATION_LOCK_TIMEOUT_MS` | no | `5000` *(code)* | lock_timeout for every `dotnet ef` session, via Npgsql `Options` (Npgsql 5+); also used by migration_dry_run. 0 = off (server default). |
| `POSTGRES_DDL_ENABLED` | no | `false` | Raw-SQL DDL migrations (ddl_*) OFF unless true. Parsed strictly: exact "true" or "1". |
| `POSTGRES_DDL_MIGRATIONS_DIR` | no | — | Directory of V<yyyymmddhhmmss>__<name>.up.sql / .down.sql files. Needed by file-based plans and ddl_create; inline SQL works without it. |
| `POSTGRES_DDL_LOCK_TIMEOUT_MS` | no | `5000` *(code)* | lock_timeout per migration. A file's -- mcp:lock-timeout-ms may lower it, never raise it. |
| `POSTGRES_DDL_STATEMENT_TIMEOUT_MS` | no | `300000` *(code)* | Default statement_timeout per DDL statement — 5 minutes. |
| `POSTGRES_DDL_MAX_STATEMENT_TIMEOUT_MS` | no | `3600000` *(code)* | Ceiling for -- mcp:statement-timeout-ms (e.g. a long CREATE INDEX CONCURRENTLY) — 1 hour. |
| `POSTGRES_DDL_PREVIEW_TTL_MS` | no | `3600000` *(code)* | DDL-preview lifetime — 1 hour. Freshness at apply is checked by the drift guard, not this. |
| `POSTGRES_DDL_EXTERNAL_LEDGER` | no | — | [schema.]table of a repo's own (filename, checksum) ledger, e.g. public.schema_migration. Replaces mcp_ops.ddl_history; the directory then holds psql-style NNNN-name.sql files (and optional NNNN-name.down.sql), sha256 over raw bytes. ADR 0005 Decision 7. |
| `POSTGRES_DDL_OWNER_ROLES` | no | — | Comma-separated roles that ALTER … OWNER TO and CREATE SCHEMA … AUTHORIZATION may name. Empty refuses both; a SUPERUSER/CREATEROLE/BYPASSRLS/REPLICATION role is refused even when listed. |
| `POSTGRES_DDL_SESSION_ROLE` | no | — | Role each migration's statements run as (SET LOCAL ROLE), so new objects are owned by it, not the login — what a runner gets from PGOPTIONS='-c role=…'. Must also be in POSTGRES_DDL_OWNER_ROLES; the login must be able to SET ROLE to it. |
| `POSTGRES_DDL_SESSION_SETTINGS` | no | — | Comma-separated prefix.name=value custom settings, set transaction-locally before every migration (e.g. aria.expected_market=AU). Core settings are refused. |
| `POSTGRES_DDL_ADOPTION_SENTINEL` | no | — | [schema.]relation whose presence means the schema already exists. An up plan against an EMPTY ledger is refused while it exists (DDL_ADOPTION_REQUIRED). |
| `PGSSLMODE` | no | — | libpq's own TLS mode (`disable` \| `require` \| `verify-ca` \| `verify-full`), read by the driver, not by this server. Set it when the target requires TLS but the connection string does not say so. |
| `NODE_TLS_REJECT_UNAUTHORIZED` | no | — | Set to 0 ONLY if the database host presents a self-signed/untrusted TLS certificate. This is a Node flag, not a server setting, and it disables certificate verification for the WHOLE process — every outbound TLS connection, not just Postgres. Prefer `PGSSLMODE=verify-full` with a trusted CA. |

35 variables. Defaults marked *(code)* are the server's own fallback and are **not** written into your agent config — set them only to override.

<!-- END GENERATED: env-table -->
