/**
 * ENH-029-C regression: get_persistence_mapping surfaces the EF mapping (column, converter,
 * maxLength, CHECK) for a value-converted property and flags the DB_TRANSLATED_PROJECTION trap
 * (converter used inside an EF-translated .Select()/.Where() with no preceding materialization),
 * while NOT flagging a projection that materializes first (.ToListAsync()).
 *
 * Both fixture files are padded past 32KB so the AST parse path uses the bufferSize fix. node-tree-sitter
 * throws "Invalid argument" on any source >32768 bytes parsed without an explicit bufferSize, so without
 * the fix extractMappingsFromFile / findProjectionTrapsInFile would throw and every assertion below fails.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bufferOverflowPad } from "./_fixtures.mjs";

let passed = 0, failed = 0;
function assert(cond, label, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const txt = (r) => Array.isArray(r?.content) ? (r.content.find((x) => x.type === "text")?.text ?? "") : "";
const js = (r) => { try { return JSON.parse(txt(r)); } catch { return null; } };

// >32KB pad that exercises the bufferSize fix without tripping the minified-file filter (see helper).
const PAD = bufferOverflowPad();

const tmpDir = mkdtempSync(join(tmpdir(), "pmap-test-"));
const repoId = `pmap-${Date.now()}`;
mkdirSync(join(tmpDir, "Data", "Configurations"), { recursive: true });
mkdirSync(join(tmpDir, "Repositories"), { recursive: true });

writeFileSync(join(tmpDir, "Data", "Configurations", "ConversationConfiguration.cs"), `public class ConversationConfiguration : IEntityTypeConfiguration<Conversation>
{
    public void Configure(EntityTypeBuilder<Conversation> builder)
    {
        builder.Property(x => x.HandledBy)
            .HasConversion(v => v.ToStorageValue(), v => ConversationHandledBy.FromStorage(v))
            .HasColumnName("handled_by")
            .HasMaxLength(50);
        builder.ToTable(t => t.HasCheckConstraint("CK_conversations_handled_by", "handled_by IN ('ai','human')"));
    }
}
${PAD}`, "utf8");

writeFileSync(join(tmpDir, "Repositories", "ConversationRepository.cs"), `public class ConversationRepository
{
    public async Task Bad()
    {
        var rows = await _db.Conversations.Select(x => x.HandledBy.ToStorageValue()).ToListAsync();
    }

    public async Task Good()
    {
        var items = await _db.Conversations.ToListAsync();
        var rows = items.Select(x => x.HandledBy);
    }
}
${PAD}`, "utf8");

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, CODEBASE_INDEX_ALLOWED_ROOTS: tmpDir, CODEBASE_INDEX_LLM_ENABLED: "false" },
  stderr: "pipe"
});
const client = new Client({ name: "pmap-test", version: "0.1.0" });
await client.connect(transport);
transport.stderr?.resume();

try {
  await client.callTool({ name: "index_repository", arguments: { repoId, repoPath: tmpDir, mode: "full" } });

  const res = js(await client.callTool({
    name: "get_persistence_mapping",
    arguments: { repoId, property: "HandledBy", ownerType: "Conversation" }
  }));

  assert(res?.mappings?.length >= 1, "returns a mapping for HandledBy (parses a >32KB config — bufferSize fix)", JSON.stringify(res)?.slice(0, 300));
  const m = (res?.mappings ?? [])[0] ?? {};
  assert(m.columnName === "handled_by", "captures column name", JSON.stringify(m));
  assert(m.hasConverter === true, "detects value converter", JSON.stringify(m));
  assert(m.maxLength === 50, "captures max length", JSON.stringify(m));
  assert(m.ownerType === "Conversation", "resolves owner type from IEntityTypeConfiguration<T>", JSON.stringify(m));
  assert((res?.checkConstraints ?? []).some((c) => /handled_by IN/.test(c.expression)), "captures CHECK constraint", JSON.stringify(res?.checkConstraints));
  assert(res?.isValueConverted === true, "isValueConverted flag set", JSON.stringify(res?.isValueConverted));

  const warns = res?.projectionWarnings ?? [];
  assert(warns.length === 1, "flags exactly one DB_TRANSLATED_PROJECTION (parses a >32KB repo file — bufferSize fix)", JSON.stringify(warns));
  assert(warns[0]?.code === "DB_TRANSLATED_PROJECTION" && warns[0]?.operator === "Select", "warning is the translated Select", JSON.stringify(warns[0]));
  assert(warns[0]?.filePath?.includes("ConversationRepository"), "warning points at the repository file", JSON.stringify(warns[0]));
} finally {
  await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
