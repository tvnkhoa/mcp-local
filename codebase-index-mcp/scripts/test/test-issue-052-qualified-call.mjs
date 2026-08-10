/**
 * MCP-ISSUE-052 — a qualified static call must produce ONE edge, not the correct one plus a
 * same-named wrong one.
 *
 * The shape, taken verbatim from `wec.communication-hub`: `ConversationReplyTargetResolver.Resolve`
 * contains exactly one qualified static call, `ConversationLoopCorrelationCodec.Parse(...)`. A second
 * class in a different layer — `OutboundMetadataResolver` — happens to declare its own `Parse`.
 *
 * What went wrong: the C# extractor emits BOTH `callee:Parse` and `callee:Codec.Parse` for that one
 * call site, relying on the unique index on `edges(repo_id, from_id, to_id, type)` to collapse them.
 * MCP-ISSUE-036 then taught the qualified token to follow its receiver, so the two halves stopped
 * agreeing: the qualified one resolved to the codec while the bare one kept picking a winner by name
 * and landed on `OutboundMetadataResolver.Parse`. Nothing collapsed. `trace_execution_flow` from
 * `Resolve` returned 9 nodes of which 7 were the false subtree, reporting `confidence: "high"` and
 * `knownGaps: []` — a wrong answer a consuming agent has no way to detect.
 *
 * Asserts, end to end through the real resolver:
 *  1. exactly one CALLS edge named `Parse` leaves `Resolve`, and it points at the codec;
 *  2. that edge is labelled `resolved callee by receiver type` — the MCP-ISSUE-036 branch is
 *     distinguishable from a name guess, which it was not when this was filed;
 *  3. the bare token survives as a demoted placeholder rather than a deleted row, so the decision
 *     stays auditable;
 *  4. a genuine same-file bare call to a same-named local method is NOT collateral damage.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GraphStore } from "../../dist/repositories/graphStore.js";
import { extractGraphData } from "../../dist/services/extractors/treeSitterExtractor.js";

const REPO_ID = "issue-052";

function createTempDbPath(tag) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `cbi-${tag}-`));
  return path.join(tempDir, "test.db");
}

function indexFile(store, filePath, source) {
  const extracted = extractGraphData({ repoId: REPO_ID, filePath, language: "csharp", source });
  store.replaceSymbolsForFile(REPO_ID, filePath, extracted.symbols);
  store.replaceEdgesForFile(REPO_ID, filePath, extracted.edges);
  return extracted;
}

const codecSource = `
namespace App.Application.Common.Messaging;

public static class ConversationLoopCorrelationCodec
{
    public const string Separator = ":";

    public static ParseResult Parse(string? raw)
    {
        return new ParseResult(true, raw, null);
    }
}
`;

// The decoy: a different class, in a different layer, with a same-named method.
const outboundSource = `
namespace App.Infrastructure.BackgroundJobs;

public sealed class OutboundMetadataResolver
{
    public static string Parse(string payload)
    {
        return ReadString(payload);
    }

    private static string ReadString(string payload) => payload;
}
`;

const callerSource = `
namespace App.Application.Common.Messaging;

public static class ConversationReplyTargetResolver
{
    public static ReplyTarget Resolve(string routeConversationId, string? bodyTokenOrCorrelationId)
    {
        var parsed = ConversationLoopCorrelationCodec.Parse(bodyTokenOrCorrelationId);
        return new ReplyTarget(routeConversationId, parsed);
    }
}
`;

// A caller that qualifies one call AND makes a genuine bare call to its OWN same-named method.
// Suppressing this bare edge would be a false negative, so it is pinned here.
const mixedCallerSource = `
namespace App.Application.Common.Messaging;

public static class MixedCaller
{
    public static string Handle(string raw)
    {
        var viaCodec = ConversationLoopCorrelationCodec.Parse(raw);
        var viaLocal = Parse(raw);
        return viaLocal;
    }

    private static string Parse(string raw) => raw;
}
`;

const dbPath = createTempDbPath("issue-052");
const store = new GraphStore(dbPath);
store.ensureRepository(REPO_ID, "/tmp/issue-052");

indexFile(store, "src/Application/Common/Messaging/ConversationLoopCorrelationCodec.cs", codecSource);
indexFile(store, "src/Infrastructure/BackgroundJobs/OutboundMetadataResolver.cs", outboundSource);
indexFile(store, "src/Application/Common/Messaging/ConversationReplyTargetResolver.cs", callerSource);
indexFile(store, "src/Application/Common/Messaging/MixedCaller.cs", mixedCallerSource);

// Drive the real resolver the way indexRunner does.
const ctx = store.buildCallResolutionContext(REPO_ID);
const stats = { rowsUpdated: 0, dispatchInserted: 0 };
let guard = 0;
while (store.resolveCallEdgesBatch(REPO_ID, ctx, 500, stats) > 0 && guard++ < 50) {
  /* drain */
}

const rows = store.runReadOnlyGraphQuery(
  `select s.name as callerName, t.name as calleeName, t.file_path as calleeFile, e.reason, e.confidence
   from edges e
   join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
   join symbols t on t.repo_id = e.repo_id and t.symbol_id = e.to_id
   where e.repo_id = :repoId and e.type = 'CALLS' and t.name = 'Parse'
   order by s.name, t.file_path`,
  { repoId: REPO_ID },
  100,
  5000
).rows;

// ── 1 + 2: the filed case ────────────────────────────────────────────────────
const fromResolve = rows.filter((r) => r.callerName === "Resolve");
assert.strictEqual(
  fromResolve.length,
  1,
  `expected exactly one Parse edge from Resolve, got ${fromResolve.length}: ${JSON.stringify(fromResolve)}`
);
assert.match(
  fromResolve[0].calleeFile,
  /ConversationLoopCorrelationCodec\.cs$/,
  `Parse resolved to the wrong file: ${fromResolve[0].calleeFile}`
);
assert.strictEqual(
  fromResolve[0].reason,
  "resolved callee by receiver type",
  `expected the receiver-typed label, got '${fromResolve[0].reason}'`
);

// ── 3: demoted, not deleted ──────────────────────────────────────────────────
const superseded = store.runReadOnlyGraphQuery(
  `select e.to_id as toId, e.reason, e.confidence
   from edges e
   join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
   where e.repo_id = :repoId and s.name = 'Resolve' and e.reason = 'superseded by qualified call'`,
  { repoId: REPO_ID },
  10,
  5000
).rows;
assert.strictEqual(superseded.length, 1, "the bare token should survive as an auditable placeholder");
assert.strictEqual(superseded[0].toId, "callee:Parse");
assert.strictEqual(superseded[0].confidence, 0.1);

// ── 4: the genuine same-file bare call is untouched ──────────────────────────
const fromMixed = rows.filter((r) => r.callerName === "Handle");
const localEdge = fromMixed.find((r) => /MixedCaller\.cs$/.test(r.calleeFile));
assert.ok(
  localEdge,
  `the same-file bare call to MixedCaller.Parse was lost — suppression is too aggressive. Got: ${JSON.stringify(fromMixed)}`
);
const codecEdge = fromMixed.find((r) => /ConversationLoopCorrelationCodec\.cs$/.test(r.calleeFile));
assert.ok(codecEdge, "the qualified codec call from Handle should still resolve");

store.close();
fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });

console.log("PASS test-issue-052-qualified-call: one edge from Resolve, receiver-typed, bare token demoted, local call preserved");
