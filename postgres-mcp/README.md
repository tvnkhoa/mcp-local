# PostgreSQL MCP (Read-only)

MCP server để query PostgreSQL theo chế độ read-only, có guardrails:
- Chỉ cho phép `SELECT` hoặc `WITH ... SELECT`
- Chặn token nguy hiểm: `insert`, `update`, `delete`, `truncate`, `alter`, `drop`, `create`, ...
- Chỉ cho phép 1 statement
- Giới hạn timeout và số dòng trả về

## 1. Cài dependencies

```powershell
cd D:/1.SourceCode/mcp-local/postgres-mcp
npm install
```

## 2. Cấu hình environment

Copy `.env.example` sang env local của bạn và set `CH_DB_CONNECTION`:

```powershell
$env:CH_DB_CONNECTION = "Server=...;Port=5432;Database=...;User Id=...;Password=...;"
$env:MCP_DB_DEFAULT_LIMIT = "500"
$env:MCP_DB_MAX_LIMIT = "2000"
$env:MCP_DB_DEFAULT_TIMEOUT_MS = "30000"
$env:MCP_DB_MAX_TIMEOUT_MS = "60000"
```

## 3. Chạy local

```powershell
npm run dev
```

Hoặc build/start:

```powershell
npm run build
npm start
```

## 4. Tools hiện có

- `health_check`
- `list_tables`
- `describe_table`
- `run_read_query`

`run_read_query` input:
- `sql` (required)
- `params` (optional)
- `limit` (optional, <= `MCP_DB_MAX_LIMIT`)
- `timeoutMs` (optional, <= `MCP_DB_MAX_TIMEOUT_MS`)
- `requestId` (optional)

## 5. Sample query

```json
{
  "sql": "select id, conversation_code from conversations where tenant_id = $1 order by created desc",
  "params": [1],
  "limit": 100
}
```

## 6. VS Code MCP client sample

Tạo file `.vscode/mcp.json` và tham chiếu server process:

```json
{
  "servers": {
    "communicationhub-postgres": {
      "command": "node",
      "args": [
        "D:/1.SourceCode/mcp-local/postgres-mcp/dist/index.js"
      ],
      "env": {
        "CH_DB_CONNECTION": "${env:CH_DB_CONNECTION}",
        "MCP_DB_DEFAULT_LIMIT": "500",
        "MCP_DB_MAX_LIMIT": "2000",
        "MCP_DB_DEFAULT_TIMEOUT_MS": "30000",
        "MCP_DB_MAX_TIMEOUT_MS": "60000"
      }
    }
  }
}
```

Giai đoạn dev nếu chưa build:
- dùng `npx tsx D:/1.SourceCode/mcp-local/postgres-mcp/src/index.ts` thay cho `node .../dist/index.js`.

## 7. Lưu ý bảo mật

- Không commit secret vào repo.
- Không trả raw SQL đầy đủ ra log nếu query có dữ liệu nhạy cảm.
- Đây là read-only bằng guardrail code; không thực thi mutation/DDL.
