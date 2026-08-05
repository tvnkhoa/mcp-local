/**
 * B-13 / MCP-ISSUE-043 — the owner prover, end to end through the MCP tools.
 *
 * The filed defect, verbatim: `refactor_symbol_migration{requiredOwnerType:"<declaring type>"}`
 * returned `totalMatches:1` with `rejectedSiteCount:2` against a symbol that
 * `refactor_replace_preview` found at 3 sites, each rejection naming the *caller's* own class as the
 * inferred owner. The guarded tool was strictly weaker than the unguarded one.
 *
 * The fixture below is that shape: one static method on `Codec`, called from two other classes. The
 * load-bearing assertion is `guarded totalMatches === unguarded totalMatches` — under the old
 * enclosing-class scan that equality cannot hold, because two of the three sites sit in `Notifier`
 * and `Handler`. A foreign type's same-named method must still be REJECTED, or the guard would have
 * been fixed by simply removing it.
 *
 * Padded past 32KB so the on-demand C# parse goes through the bufferSize path (MCP-ISSUE-030).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { bufferOverflowPad, makeTempDir } from "./_fixtures.mjs";

let passed = 0, failed = 0;
function assert(cond, label, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const txt = (r) => Array.isArray(r?.content) ? (r.content.find((x) => x.type === "text")?.text ?? "") : "";
const js = (r) => { try { return JSON.parse(txt(r)); } catch { return null; } };

const PAD = bufferOverflowPad();
const tmpDir = makeTempDir("owner-prover-");
const repoId = `owner-${Date.now()}`;
mkdirSync(join(tmpDir, "src"), { recursive: true });

// Three sites of Codec.Normalize: the declaration, and two calls from OTHER classes.
// Plus OtherCodec.Normalize — a genuinely different owner that must be rejected, not migrated.
writeFileSync(join(tmpDir, "src", "Codec.cs"), `namespace App;

public class Codec
{
    public static string Normalize(string raw) => raw.Trim();
}

public class OtherCodec
{
    public static string Normalize(string raw) => raw;
}

public class Notifier
{
    public string Send(string raw) => Codec.Normalize(raw);
}

public class Handler
{
    public string Handle(string raw)
    {
        var viaOther = OtherCodec.Normalize(raw);
        return Codec.Normalize(viaOther);
    }
}
${PAD}`, "utf8");

// MCP-ISSUE-043 Scenario B: an owned-entity property behind a two-hop receiver.
writeFileSync(join(tmpDir, "src", "Conversation.cs"), `namespace App;

public class ConversationAssignmentState
{
    public string HandledBy { get; set; }
}

public class Conversation
{
    public ConversationAssignmentState Assignment { get; set; }
}

public class AssignmentService
{
    public void Handle(Conversation conversation)
    {
        conversation.Assignment.HandledBy = "ai";
    }
}
${PAD}`, "utf8");

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, CODEBASE_INDEX_ALLOWED_ROOTS: tmpDir, CODEBASE_INDEX_DB_PATH: join(tmpDir, "index.db"), CODEBASE_INDEX_LLM_ENABLED: "false" },
  stderr: "pipe"
});
const client = new Client({ name: "owner-prover-test", version: "0.1.0" });
await client.connect(transport);
transport.stderr?.resume();

try {
  await client.callTool({ name: "index_repository", arguments: { repoId, repoPath: tmpDir, mode: "full" } });

  // ── 1. The regression: guarded must reach every site the unguarded preview reaches ──────────
  const unguarded = js(await client.callTool({
    name: "refactor_replace_preview",
    arguments: {
      repoId, find: "Normalize", replaceExpression: "NormalizeX",
      scope: { includePaths: ["src/Codec.cs"] }, mode: "text", profile: "standard"
    }
  }));
  // 4 textual sites: Codec's declaration + 2 Codec.* calls + OtherCodec's declaration + the
  // OtherCodec.* call = 5. The unguarded preview has no owner opinion at all.
  assert(unguarded?.totalMatches === 5, "unguarded preview finds all 5 textual sites", `totalMatches=${unguarded?.totalMatches}`);

  const guarded = js(await client.callTool({
    name: "refactor_symbol_migration",
    arguments: {
      repoId,
      migrations: [{ fromSymbol: "Normalize", toSymbol: "NormalizeX", requiredOwnerType: "Codec" }],
      scopePaths: ["src/Codec.cs"], dryRun: true
    }
  }));
  const row = guarded?.migrationMap?.[0];
  assert(row?.totalMatches === 3, "requiredOwnerType:'Codec' now matches all 3 Codec sites (was 1 of 3)", JSON.stringify(row)?.slice(0, 400));
  assert(row?.unresolvedOccurrences === 0, "all 3 are PROVEN, so none is flagged ambiguous", `unresolved=${row?.unresolvedOccurrences}`);

  // ── 2. The guard still bites: a different owner is rejected, naming the rule ────────────────
  assert(row?.rejectedSiteCount === 2, "the 2 OtherCodec sites are still rejected", `rejectedSiteCount=${row?.rejectedSiteCount}`);
  const rejectedOwners = (row?.rejectedSites ?? []).map((x) => x.detail).join(" | ");
  assert(
    rejectedOwners.includes("OtherCodec") && !rejectedOwners.includes("'Notifier'") && !rejectedOwners.includes("'Handler'"),
    "rejections name OtherCodec — NOT the callers' own classes, which is the filed defect",
    rejectedOwners
  );

  // ── 3. Sites are appliable: a proven owner carries no risk flag ─────────────────────────────
  const allHunks = (row?.previewSummary ?? []).flatMap((f) => f.hunks ?? []);
  assert(allHunks.length === 3 && allHunks.every((h) => (h.riskFlags ?? []).length === 0),
    "every matched site is risk-free, so the migration can actually apply",
    JSON.stringify(allHunks.map((h) => ({ line: h.line, owner: h.ownerType, risk: h.riskFlags }))));
  assert(allHunks.every((h) => h.ownerType === "Codec"), "every hunk reports Codec as the owner", JSON.stringify(allHunks.map((h) => h.ownerType)));

  // ── 4. Scenario B: a two-hop receiver resolves to the OWNED type ────────────────────────────
  const twoHop = js(await client.callTool({
    name: "change_value_representation",
    arguments: {
      repoId, property: "HandledBy", requiredOwnerType: "ConversationAssignmentState",
      valueMap: { ai: "ConversationHandledBy.Ai" }, dryRun: true
    }
  }));
  assert(twoHop?.totalMatches === 1, "conversation.Assignment.HandledBy is found", JSON.stringify(twoHop)?.slice(0, 300));
  assert(twoHop?.ambiguousOccurrences === 0,
    "the two-hop receiver is PROVEN (was permanently receiver_not_identifier)",
    JSON.stringify(twoHop?.ambiguousReasons ?? twoHop?.ambiguousOccurrences));

  // ...and the same site under the OWNING type is a proven mismatch, not an ambiguity.
  const wrongOwner = js(await client.callTool({
    name: "change_value_representation",
    arguments: {
      repoId, property: "HandledBy", requiredOwnerType: "Conversation",
      valueMap: { ai: "ConversationHandledBy.Ai" }, dryRun: true
    }
  }));
  assert(wrongOwner?.totalMatches === 0 && (wrongOwner?.rejectedSites ?? []).length === 1,
    "requiredOwnerType:'Conversation' rejects the owned-type site instead of rewriting it",
    JSON.stringify(wrongOwner)?.slice(0, 300));

  // ── 5. An unprovable site is KEPT and flagged, never silently dropped (B-13 decision 2) ─────
  const unprovable = js(await client.callTool({
    name: "refactor_symbol_migration",
    arguments: {
      repoId,
      // A regex-free literal that lands mid-token: not a whole identifier, so unattributable.
      migrations: [{ fromSymbol: "ec.Normalize", toSymbol: "ec.NormalizeX", requiredOwnerType: "Codec" }],
      scopePaths: ["src/Codec.cs"], dryRun: true
    }
  }));
  const unprovableRow = unprovable?.migrationMap?.[0];
  assert(unprovableRow?.totalMatches > 0, "an unprovable site is still reported (not dropped to 0)", JSON.stringify(unprovableRow)?.slice(0, 300));
  assert(unprovableRow?.unresolvedOccurrences === unprovableRow?.totalMatches,
    "every unprovable site is flagged ambiguous, so none can apply",
    `unresolved=${unprovableRow?.unresolvedOccurrences} total=${unprovableRow?.totalMatches}`);
  assert((unprovableRow?.ambiguousReasons ?? []).some((x) => x.rule === "site_not_an_identifier"),
    "ambiguousReasons names the rule that failed",
    JSON.stringify(unprovableRow?.ambiguousReasons)?.slice(0, 300));
} finally {
  await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
