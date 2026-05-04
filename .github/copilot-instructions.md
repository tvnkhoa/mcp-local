# Copilot Instructions for `mcp-local`

## Mục tiêu workspace
- Workspace này dùng để tạo các MCP local hỗ trợ công việc nội bộ.
- Ưu tiên server an toàn, dễ vận hành, dễ mở rộng và có guardrails rõ ràng.

## Ngôn ngữ và stack mặc định
- Ưu tiên TypeScript + Node.js.
- Dùng ESM (`"type": "module"`) và giữ strict typing.
- Validate input bằng schema (ưu tiên `zod`).

## Quy ước triển khai MCP
- Mỗi MCP cần có:
  - `src/index.ts` làm entrypoint.
  - Guardrails tách riêng file (ví dụ `sqlGuardrails.ts`) nếu có logic an toàn.
  - Tool schemas rõ ràng, message lỗi rõ nguyên nhân và cách xử lý.
- Mặc định thiết kế theo nguyên tắc **least privilege**.
- Nếu liên quan DB, mặc định **read-only** trừ khi có yêu cầu rõ ràng.
- Chặn nhiều statement trong 1 query và chặn token nguy hiểm khi cần.

## Bảo mật
- Không hardcode secrets, tokens, connection strings.
- Dùng biến môi trường cho cấu hình nhạy cảm.
- Không ghi log dữ liệu nhạy cảm hoặc raw payload có thông tin bí mật.

## Chất lượng mã
- Thay đổi phải tối thiểu nhưng đúng mục tiêu.
- Ưu tiên hàm nhỏ, tên rõ nghĩa, dễ test.
- Giữ tương thích với scripts hiện có: `build`, `dev`, `start`, `typecheck`.
- Khi thêm tính năng mới, cập nhật `README.md` với cách chạy và ví dụ input/output.

## Cách phản hồi khi hỗ trợ coding trong repo này
- Trả lời ngắn gọn, bám mục tiêu công việc.
- Nêu rõ file thay đổi và lý do.
- Nếu yêu cầu mơ hồ, đề xuất 1 phương án mặc định an toàn rồi hỏi xác nhận.

## Kiến trúc customization 2 lớp
- Lớp **Base**: áp dụng cho mọi MCP package trong workspace.
- Lớp **Domain**: áp dụng theo từng MCP cụ thể (ví dụ: DB, codebase-index).
- Khi có xung đột quy tắc, **Domain override Base** trong phạm vi package được scope.
- Ưu tiên dùng skill theo vòng đời: scaffold -> implement -> test -> security -> release.

## Customization files trong workspace

### File-specific instructions
- `.github/instructions/mcp-base.instructions.md`: Quy tắc nền tảng cho toàn bộ MCP trong workspace (2-layer base).
- `.github/instructions/typescript-mcp.instructions.md`: Quy ước khi viết/refactor TypeScript MCP server.
- `.github/instructions/db-guardrails.instructions.md`: Quy tắc an toàn DB và SQL guardrails.
- `.github/instructions/codebase-index.instructions.md`: Quy ước cho MCP index codebase, graph schema, và guardrails lưu trữ nội bộ.

### Reusable skills
- `.github/skills/mcp-scaffold/SKILL.md`: Quy trình scaffold MCP/tool mới theo chuẩn workspace.
- `.github/skills/mcp-security-review/SKILL.md`: Checklist review bảo mật cho thay đổi liên quan MCP/DB.
- `.github/skills/mcp-release-checklist/SKILL.md`: Checklist trước release/handoff.
- `.github/skills/mcp-contract-conformance/SKILL.md`: Kiểm tra MCP contract stability cho tools/list, tools/call, schema, backward compatibility.
- `.github/skills/mcp-tool-annotations/SKILL.md`: Quy tắc gắn readOnly/idempotent/destructive hints cho tool semantics.
- `.github/skills/mcp-error-taxonomy/SKILL.md`: Chuẩn hóa nhóm lỗi user-actionable vs internal/developer errors.
- `.github/skills/mcp-observability-runbook/SKILL.md`: Thiết kế log/metric/alert và runbook vận hành sự cố cho MCP.
- `.github/skills/mcp-host-integration-security/SKILL.md`: Checklist hardening khi tích hợp MCP host/client (token, scope, transport).
- `.github/skills/codebase-index-scaffold/SKILL.md`: Scaffold MCP mới cho indexing + graph query.
- `.github/skills/tree-sitter-extraction/SKILL.md`: Quy trình extract AST/symbol/import/call edges bằng tree-sitter.
- `.github/skills/magika-file-filtering/SKILL.md`: Lọc file bằng Magika để nâng chất lượng index.
- `.github/skills/graph-schema-design/SKILL.md`: Thiết kế schema đồ thị cho dependencies/call-chain/flow.
- `.github/skills/incremental-indexing/SKILL.md`: Quy trình re-index tăng dần theo hash/commit.
- `.github/skills/index-security-review/SKILL.md`: Checklist bảo mật riêng cho MCP index nội bộ.
- `.github/skills/index-release-checklist/SKILL.md`: Checklist release cho MCP index codebase.
- `.github/skills/db-query-budgeting/SKILL.md`: Kiểm soát ngân sách query DB theo timeout/limit/concurrency.
- `.github/skills/db-parameterization-audit/SKILL.md`: Audit parameterization, anti-concatenation và read-only posture.
- `.github/skills/index-metadata-governance/SKILL.md`: Chuẩn metadata index-run và provenance để audit/reproducibility.
- `.github/skills/index-conformance-full-vs-incremental/SKILL.md`: So sánh tính đúng đắn giữa full và incremental indexing.
- `.github/skills/index-unresolved-symbol-policy/SKILL.md`: Quy tắc xử lý unresolved symbols, counters, và fallback an toàn.