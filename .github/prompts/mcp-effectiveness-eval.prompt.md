---
tools:
  - codebase-index-central
description: >
  Đánh giá hiệu quả khi sử dụng MCP codebase-index so với không sử dụng.
  Agent thực hiện cùng 1 tập câu hỏi phân tích code bằng 2 cách:
  (A) chỉ dùng file search/grep thông thường, (B) dùng MCP tools.
  Sau đó tổng hợp kết quả so sánh về độ chính xác, số bước, token estimate.
  Phiên bản này phản ánh index engine v0.3.1 với TYPE_REF edges, bootstrap entry point
  detection, path normalization fix, và intent search strategy.
---

# Đánh giá hiệu quả MCP codebase-index

## Mục tiêu

So sánh 2 workflow khi phân tích codebase **${repoId}** tại path **${repoPath}**:

- **Baseline (không MCP):** dùng `file_search`, `grep_search`, `read_file` để trả lời từng câu hỏi.
- **With MCP:** dùng các tool của `codebase-index-central` để trả lời cùng câu hỏi đó.

Cuối cùng tổng hợp bảng so sánh.

---

## Chuẩn bị

Trước khi bắt đầu, kiểm tra repo đã được index chưa:

```json
{
  "tool": "health_check",
  "arguments": { "repoId": "${repoId}" }
}
```

Nếu chưa, chạy index:

```json
{
  "tool": "index_repository",
  "arguments": {
    "repoId": "${repoId}",
    "repoPath": "${repoPath}",
    "mode": "incremental",
    "docsMode": "off",
    "maxFiles": 5000,
    "batchSize": 200
  }
}
```

---

## Tập câu hỏi đánh giá (Q1–Q5)

Thực hiện **từng câu hỏi** theo đúng thứ tự:

### Q1 — Tìm entry point chính của repo

**Baseline:** dùng `file_search` với pattern `**/Program.cs`, `**/Startup.cs`, `**/index.ts`, `**/main.ts`.

**With MCP:**
```json
{ "tool": "find_entry_points", "arguments": { "repoId": "${repoId}", "limit": 10 } }
```

Ghi nhận: số bước thực hiện, số file đọc, độ chính xác kết quả.

> **v0.3.1+:** Response giờ tách 2 nhóm:
> - `runtimeEntryPoints`: bootstrap files (`Program.cs`, `Startup.cs`, `main.ts`, v.v.) — luôn hiện dù không có caller nào.
> - `graphEntryPoints`: symbols có 0 caller trong call graph.
> Kiểm tra xem `Program.cs` có xuất hiện trong `runtimeEntryPoints` không.

---

### Q2 — Tìm tất cả callers của 1 symbol quan trọng

Chọn 1 class/method tiêu biểu (ví dụ: class service chính hoặc handler đầu tiên tìm được ở Q1).

**Baseline:** dùng `grep_search` tìm theo tên class, sau đó đọc từng file match để xác nhận caller thực sự.

**With MCP:**
```json
{
  "tool": "find_impact_surface",
  "arguments": {
    "repoId": "${repoId}",
    "filePath": "<file-path-from-Q1>",
    "limit": 20
  }
}
```

Ghi nhận: số file grep phải đọc (Baseline) vs số bước MCP.

> **v0.3.1+:** Impact surface giờ bao gồm cả callers qua `TYPE_REF` edges (ví dụ: DI registration dùng `typeof(ClassName<,>)`). Nếu repo dùng generic DI pattern (MediatR `typeof(T<,>)`), kết quả MCP sẽ bao gồm file DI setup — trước đây bỏ sót.

---

### Q3 — Blast radius khi thay đổi 1 file

Chọn 1 file model/DTO quan trọng trong repo.

**Baseline:** đọc file để biết tên class → `grep_search` tìm import/usage → tổng hợp thủ công.

**With MCP:**
```json
{
  "tool": "find_impact_files",
  "arguments": {
    "repoId": "${repoId}",
    "filePath": "<model-file>",
    "limit": 30
  }
}
```

Ghi nhận: thời gian ước tính, độ bao phủ (có bỏ sót file nào không).

> **v0.3.1+:** TYPE_REF edges từ field declarations (`private DbSet<T>`) và local variable declarations (`Conversation conv = ...`) giờ được capture. Infrastructure files dùng entity qua EF typed fields sẽ xuất hiện trong kết quả. Gap còn lại: access thuần qua member access expression chưa được capture.

---

### Q4 — Hiểu nhanh 1 module chưa quen

Chọn 1 folder/layer chưa từng đọc (ví dụ: `src/Application/Conversations/`).

**Baseline:** `list_dir` → đọc lần lượt từng file chính → tự tổng hợp.

**With MCP:**
```json
{
  "tool": "get_folder_summary",
  "arguments": {
    "repoId": "${repoId}",
    "folderPath": "<folder-path>",
    "maxFiles": 50
  }
}
```

Sau đó dùng thêm:
```json
{
  "tool": "get_file_summary",
  "arguments": {
    "repoId": "${repoId}",
    "filePath": "<key-file-in-folder>"
  }
}
```

Ghi nhận: số file phải mở (Baseline) vs số tool call (MCP).

---

### Q5 — Tìm symbol theo mô tả nghiệp vụ

Ví dụ: *"Tìm class xử lý khi cuộc hội thoại được giao cho AI"*

**Baseline:** brainstorm tên → `grep_search` với nhiều keyword khác nhau → đọc kết quả.

**With MCP — bước 1:** Thử `strategy: "name"` trước (tìm theo tên xấp xỉ):
```json
{
  "tool": "search_symbols",
  "arguments": {
    "repoId": "${repoId}",
    "query": "ConversationAssignedAI handler",
    "strategy": "name",
    "profile": "compact",
    "limit": 10
  }
}
```

**With MCP — bước 2:** Nếu bước 1 không tìm được, dùng `strategy: "intent"` (OR-based token expansion):
```json
{
  "tool": "search_symbols",
  "arguments": {
    "repoId": "${repoId}",
    "query": "ConversationAssignedAI handler",
    "strategy": "intent",
    "profile": "compact",
    "limit": 10
  }
}
```

> **Giải thích:** `strategy: "intent"` tách query thành tokens (camelCase/PascalCase aware) và dùng OR-match — phù hợp khi không biết tên chính xác. Lưu ý: query tiếng Việt thuần (ví dụ: *"cuộc hội thoại giao cho AI"*) vẫn không hiệu quả do FTS5 không có semantic embedding; nên dùng tên class/method tiếng Anh xấp xỉ.

Ghi nhận: số grep attempt (Baseline) vs số tool call MCP (1 lần name / 2 lần nếu cần intent).

---

## Bảng tổng hợp (điền sau khi hoàn tất Q1–Q5)

| # | Câu hỏi | Baseline: số bước | MCP: số bước | Baseline: chính xác? | MCP: chính xác? | Nhận xét |
|---|---------|-------------------|--------------|----------------------|-----------------|----------|
| Q1 | Entry point | | | | | |
| Q2 | Callers của symbol | | | | | |
| Q3 | Blast radius | | | | | |
| Q4 | Hiểu module mới | | | | | |
| Q5 | Tìm theo mô tả | | | | | |
| **Tổng** | | | | | | |

---

## Kết luận

Sau khi điền bảng, hãy viết:

1. **Token saving estimate:** ước tính % token tiết kiệm khi dùng MCP so với Baseline.
2. **Accuracy delta:** MCP có bỏ sót hoặc trả sai kết quả nào không (do index chưa đầy đủ)?
3. **Trường hợp MCP phát huy tốt nhất:** loại câu hỏi nào hưởng lợi nhiều nhất?
4. **Trường hợp Baseline vẫn cần thiết:** khi nào nên đọc file trực tiếp thay vì dùng MCP?
5. **Đề xuất workflow kết hợp:** thứ tự tool call lý tưởng cho Plan mode và Agent mode.

---

## Lưu ý kỹ thuật (v0.3.1)

- **Re-index bắt buộc** sau khi upgrade engine để populate TYPE_REF edges. Dùng `mode: "full"` để flush edge data cũ.
- **TYPE_REF coverage:** `typeof(T<,>)` (DI), field declarations (`DbSet<T>`), local variable declarations, constructor calls, parameter types, base class list.
- **Gap còn lại:** usage thuần qua member access expression (`obj.Property`) chưa được capture nếu không có explicit type annotation trong cùng method.
- **`strategy: "intent"`** chỉ hiệu quả với English terms — Vietnamese NL queries không được hỗ trợ ở mức semantic.
