# Refactor Plan — C# Extraction Gaps

Dựa trên review tools với `wec.be` (7243 files, 64036 symbols, C# microservices).
Ngày tạo: 2026-05-18 | Cập nhật: 2026-05-18T11:33:10Z

---

## Trạng thái: ✅ HOÀN THÀNH

Tất cả issues đã được implement, verify và deploy. Xem chi tiết bên dưới.

---

## Tổng quan vấn đề (gốc)

Toàn bộ các tools bị lỗi đều có chung **root cause**: C# tree-sitter extractor thiếu 3 loại edge/data:

1. **IMPLEMENTS edges** — không emit khi class implement interface
2. **CALLS edges đầy đủ** — emit `callee:<name>` nhưng không resolve được cross-file
3. **Routes không vào DB** — `collectAttachedAttributeTexts` dùng `previousNamedSibling` miss attributes trong AST layout thực tế

---

## Phase 1 — Core extraction fixes ✅

### P1.1 — IMPLEMENTS edges ✅ DONE

**File:** `src/extractors/csharpExtractor.ts`

**Root cause thực tế:** tree-sitter C# AST dùng `base_list` là named child của class node (không phải field), children là `identifier` trực tiếp — không phải `base_type` wrapper như tài liệu mô tả.

**Fix đã implement:**
```typescript
// Traverse base_list as named child (not childForFieldName("bases"))
const baseListNodes = node.descendantsOfType(["base_list"]);
for (const baseList of baseListNodes) {
  if (baseList.parent !== node) continue;
  for (const baseNode of baseList.namedChildren) {
    const typeName = baseNode.text?.trim();
    const baseName = typeName.replace(/<[^>]*>$/, "").trim();
    if (isLikelyCSharpInterfaceName(baseName)) {
      edges.push({ type: "IMPLEMENTS", toId: `iface:${baseName}`, confidence: 0.95 });
    } else {
      emitTypeRefEdge(input, symbolId, baseName, edges);
    }
  }
}
```

**Kết quả:** `find_implementations("ICampaignGalleryService")` → `[CampaignGalleryService]` ✅

---

### P1.2 — route_map fix ✅ DONE

**File:** `src/extractors/csharpExtractor.ts`

**Root cause thực tế:** AST layout thực tế của tree-sitter C#:
- Class attributes: nằm trong `namedChildren` của class node (không phải `previousNamedSibling`)
- Method attributes: `previousNamedSibling` là `method_declaration` trước đó, không phải `attribute_list`

**Fix đã implement — 3 strategies:**
```typescript
function collectAttachedAttributeTexts(node: Parser.SyntaxNode): string[] {
  // Strategy 1: previousNamedSibling chain
  // Strategy 2: attribute_list as first named children of the node itself (actual layout)
  // Strategy 3: walk parent's named children before this node
}
```

**Kết quả:** `route_map` trả về đầy đủ routes từ tất cả controllers ✅

---

### P1.3 — CALLS edges ✅ DONE

**File:** `src/extractors/csharpExtractor.ts`

**Fix đã implement:** Emit qualified edge cho receivers bắt đầu bằng `_` (DI field convention) hoặc uppercase, thêm `this_expression` support. Giữ guard để tránh edge explosion với plain camelCase locals.

```typescript
// Emit qualified edge for resolvable receivers only:
// - Uppercase: static/type calls (MyService.DoWork)
// - _ prefix: DI field convention (_campaignService.Execute)
// - this_expression: resolved to enclosing class name
if (receiverName && (/^[A-Z]/.test(receiverName) || receiverName.startsWith("_") || ...)) {
  edges.push({ toId: `callee:${receiverName}.${calleeName}`, confidence: 0.75 });
}
```

**Kết quả:** `get_call_chain` có edges, calls resolved tăng từ 973 → 5893 ✅

---

## Phase 2 — Quality / noise reduction ✅

### P2.1 — TRIVIAL_PROPERTY_TOKENS + impact filter ✅ DONE

**Files:** `src/extractors/extractorUtils.ts`, `src/impactAnalyzer.ts`

**Fix:** Thêm ~40 generic method names vào `TRIVIAL_PROPERTY_TOKENS` (Create, Cancel, Submit, Execute, v.v.) và filter PROPERTY_REF edges có confidence < 0.7 khỏi `find_impact_files` results.

**Kết quả:** `find_impact_files` — false positives giảm từ 27/27 xuống 0 ✅

---

## Phase 3 — UX / polish ✅

### P3.1 — query_docs description ✅ DONE

**File:** `src/index.ts`

**Fix:** Cập nhật description để nêu rõ required params cho từng mode:
- `mode=search` requires `query`
- `mode=stale` requires `symbolIds`
- `mode=coverage` requires `filePath`

---

## Phase 4 — Performance optimization ✅

Phát sinh trong quá trình implement do số lượng CALLS edges tăng đột biến sau P1.3.

### Perf-1 — Context pre-build ✅ DONE

**File:** `src/edgeResolver.ts`

**Fix:** Tách `buildCallResolutionContext()` (chạy 1 lần) khỏi `resolveCallEdgesBatch()` (chạy nhiều lần). Pre-fetch tất cả unresolved rows vào memory, slice theo batch — không re-query DB mỗi batch.

**Kết quả:** Context build 63s → <1s ✅

### Perf-2 — WAL session ✅ DONE

**File:** `src/graphStore.ts`

**Fix:**
- `busy_timeout` 5s → 30s
- `wal_autocheckpoint` 1000 → 8000 pages
- `beginIndexSession()` / `endIndexSession()` disable auto-checkpoint trong index

**Kết quả:** Không còn DB locked errors ✅

### Perf-3 — DB indexes ✅ DONE

**File:** `src/graphStore.ts`

**Indexes mới:**
- `idx_edges_repo_type_to` — tăng tốc query unresolved edges
- `idx_symbols_repo_kind` — tăng tốc buildNamedCandidateMap
- `idx_symbols_repo_kind_name` — tăng tốc symbol lookup
- `idx_edges_repo_from_to` — tăng tốc UPDATE lookup
- `idx_edges_repo_type_to_from` — covering index cho resolve queries

### Perf-4 — Bulk write optimization ✅ DONE

**File:** `src/edgeResolver.ts`

**Fix:** Tách resolve logic ra khỏi transaction — compute tất cả updates/inserts trong memory trước, sau đó write trong transaction duy nhất với temp table + UPDATE JOIN.

### Perf-5 — Hard limit (acknowledged)

**Kết quả cuối:** 5893 UPDATEs mất ~111s — đây là SQLite B-tree page locking limit trên Windows với DB 206MB. Đã thử: sub-transactions, temp table UPDATE JOIN, drop/rebuild indexes, `synchronous=OFF` — không có approach nào cải thiện được.

**Kết luận:** Accept ~2 phút cho full re-index. Incremental index hàng ngày nhanh hơn nhiều (<1s khi không có unresolved edges).

---

## Kết quả cuối cùng

### Tool verification (wec.be sau re-index)

| Tool | Trước | Sau |
|------|-------|-----|
| `find_implementations` | ❌ rỗng | ✅ tìm được implementations |
| `route_map` | ❌ 0 routes | ✅ routes từ tất cả controllers |
| `find_entry_points(route_handler)` | ❌ 0 | ✅ route handlers |
| `get_call_chain` | ❌ edges rỗng | ✅ có CALLS edges |
| `find_impact_files` | ⚠️ 27/27 false positives | ✅ 0 false positives |
| DB locked errors | ❌ thường xuyên | ✅ không còn |

### Performance (wec.be — 64036 symbols, 206MB DB)

| Phase | Trước | Sau |
|-------|-------|-----|
| Full index 10434 files | ~42s | ~42s (không đổi) |
| Context build | 63s | <1s |
| Call resolve (5893 edges) | treo/timeout | ~111s (SQLite limit) |
| Total post-phase | treo | ~2 phút |
| Incremental index | N/A | <1s |

### Calls resolved

| Metric | Trước | Sau |
|--------|-------|-----|
| Calls resolved | 973 | 5893 |
| IMPLEMENTS edges | 0 | ~thousands |
| Routes in DB | 0 | ~hundreds |

---

## Files đã thay đổi

| File | Changes |
|------|---------|
| `src/extractors/csharpExtractor.ts` | P1.1 IMPLEMENTS, P1.2 route attrs, P1.3 CALLS edges |
| `src/extractors/extractorUtils.ts` | P2.1 TRIVIAL_PROPERTY_TOKENS |
| `src/edgeResolver.ts` | Perf-1 context pre-build + in-memory batch + bulk write |
| `src/graphStore.ts` | Perf-2 WAL session + Perf-3 DB indexes + beginIndexSession/endIndexSession |
| `src/impactAnalyzer.ts` | P2.1 filter PROPERTY_REF < 0.7 |
| `src/index.ts` | P3.1 query_docs description + Perf-1 batch orchestration |

---

## Checklist đã pass

```bash
npm run typecheck          ✅
npm run build              ✅
npm run guard:no-llm-runtime  ✅
node scripts/test-csharp-inheritance-bridge.mjs  ✅
node scripts/smoke-test.mjs  ✅
npm run benchmark:plan:check  ✅ (compact savings 86.03%)
```

---

## Ghi chú cho tương lai

**Nếu muốn cải thiện call resolve performance hơn nữa:**
1. Giảm số `callee:` edges emit — filter aggressive hơn ở extraction phase
2. Migrate storage sang PostgreSQL hoặc DuckDB cho large repos (>100k symbols)
3. Resolve edges trong worker thread riêng để không block MCP server

**Known limitation:**
- `very-large` profile (`maxUnresolvedRows=50000`) sẽ bỏ sót một số edges — trade-off giữa speed và completeness
- Interface implementation resolution bị skip trong post-phase với `very-large` profile — cần full index để có IMPLEMENTS edges đầy đủ
