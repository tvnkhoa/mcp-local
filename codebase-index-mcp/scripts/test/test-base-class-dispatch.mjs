/**
 * MCP-ISSUE-037 — an `override` of an abstract/virtual base member must be reachable from the call site,
 * and a `new`/shadow method must NOT be.
 *
 * The negative half is why this harness exists rather than one happy-path assertion. Fanning out on name
 * alone would make every same-named subclass method look live, including genuinely dead ones — the one
 * direction of error `dead_code_scan` cannot afford, since a false "live" hides real dead code while a
 * false "dead" is only a candidate a human dismisses.
 *
 * Exercised through extraction AND resolution against a real DB, because the gate reads a signature that
 * extraction writes: neither half proves anything alone.
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GraphStore } from "../../dist/store/graphStore.js";
import { extractGraphData } from "../../dist/extractors/treeSitterExtractor.js";

const repoId = "bcd-test";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbi-bcd-"));
const store = new GraphStore(path.join(tempDir, "test.db"));
store.ensureRepository(repoId, tempDir);

function indexFile(filePath, source) {
  const extracted = extractGraphData({ repoId, filePath, language: "csharp", source });
  store.replaceSymbolsForFile(repoId, filePath, extracted.symbols);
  store.replaceEdgesForFile(repoId, filePath, extracted.edges);
  return extracted;
}

const base = indexFile(
  "src/Base.cs",
  `
public abstract class SentMessageConsumerBase
{
    protected abstract SentMessageInfo GetMessageInfo(string message);
    protected virtual void LogProcessed(string id) { }
    // NOT virtual — a subclass method of this name is a shadow, not an override.
    protected void SealedHelper(string id) { }

    public void Consume(string message)
    {
        var info = GetMessageInfo(message);
        LogProcessed("x");
        SealedHelper("x");
    }
}
`
);
const automation = indexFile(
  "src/Automation.cs",
  `
public class AutomationSentConsumer : SentMessageConsumerBase
{
    protected override SentMessageInfo GetMessageInfo(string message) { return null; }
    protected override void LogProcessed(string id) { }
    protected new void SealedHelper(string id) { }
}
`
);
const campaign = indexFile(
  "src/Campaign.cs",
  `
public class CampaignSentConsumer : SentMessageConsumerBase
{
    protected override SentMessageInfo GetMessageInfo(string message) { return null; }
}
`
);
// Extends nothing. A name-only fan-out would wrongly reach it; it is not in the hierarchy at all.
const unrelated = indexFile(
  "src/Unrelated.cs",
  `
public class UnrelatedThing
{
    protected SentMessageInfo GetMessageInfo(string message) { return null; }
}
`
);

store.rebuildFts();
store.resolveImplementsEdges(repoId);
store.resolveExtendsEdges(repoId);
const ctx = store.buildCallResolutionContext(repoId);
while (store.resolveCallEdgesBatch(repoId, ctx, 5000) > 0) { /* drain */ }
// AFTER call resolution, deliberately: the pass reads final CALLS edges, since the base calls its own
// abstract member in the same file and extraction resolved that edge before the resolver ever saw it.
store.resolveBaseClassDispatch(repoId);

let failures = 0;
const log = [];
function check(label, ok, detail) {
  if (ok) { log.push(`  ok    ${label}`); return; }
  failures += 1;
  log.push(`  FAIL  ${label}`);
  if (detail) log.push(`          ${detail}`);
}

const method = (extracted, name) => extracted.symbols.find((s) => s.kind === "method" && s.name === name);
const callersOf = (symbolId) => store.getCallEdges(repoId, symbolId, "callers", 50);

// --- the inheritance relation itself -------------------------------------------------------------
const extendsEdges = [...automation.edges, ...campaign.edges].filter((e) => e.type === "EXTENDS");
check("EXTENDS is emitted for a non-interface base type", extendsEdges.length === 2, `got ${extendsEdges.length}`);
check(
  "class inheritance is NOT reported as IMPLEMENTS",
  [...automation.edges, ...campaign.edges].every((e) => e.type !== "IMPLEMENTS"),
  "several tools read IMPLEMENTS as an interface contract; folding the two would answer that wrongly"
);

// --- the fan-out ---------------------------------------------------------------------------------
for (const [label, extracted] of [["AutomationSentConsumer", automation], ["CampaignSentConsumer", campaign]]) {
  const override = method(extracted, "GetMessageInfo");
  const dispatched = override ? callersOf(override.symbolId).filter((e) => e.reason === "base-class-dispatch") : [];
  check(
    `${label}.GetMessageInfo (override of abstract) is reachable`,
    dispatched.length > 0,
    override ? `callers: ${JSON.stringify(callersOf(override.symbolId).map((e) => e.reason))}` : "symbol missing"
  );
}

const virtualOverride = method(automation, "LogProcessed");
check(
  "an override of a `virtual` member is reachable too",
  virtualOverride !== undefined && callersOf(virtualOverride.symbolId).some((e) => e.reason === "base-class-dispatch"),
  virtualOverride ? JSON.stringify(callersOf(virtualOverride.symbolId).map((e) => e.reason)) : "symbol missing"
);

// --- the gate: what must NOT be reached ----------------------------------------------------------
const shadow = method(automation, "SealedHelper");
check(
  "a `new`/shadow method of a NON-virtual base member is NOT reached",
  shadow !== undefined && callersOf(shadow.symbolId).every((e) => e.reason !== "base-class-dispatch"),
  shadow
    ? `shadowing is not overriding — got ${JSON.stringify(callersOf(shadow.symbolId).map((e) => e.reason))}`
    : "symbol missing"
);

const outside = method(unrelated, "GetMessageInfo");
check(
  "a same-named method on a class OUTSIDE the hierarchy is NOT reached",
  outside !== undefined && callersOf(outside.symbolId).every((e) => e.reason !== "base-class-dispatch"),
  outside ? `got ${JSON.stringify(callersOf(outside.symbolId).map((e) => e.reason))}` : "symbol missing"
);

// The base's own abstract declaration keeps its direct call: the fan-out ADDS reachability, it does not
// move it. Getting this wrong would trade one false "dead" for another.
const abstractDecl = method(base, "GetMessageInfo");
check(
  "the base's abstract declaration still holds its own direct call",
  abstractDecl !== undefined && callersOf(abstractDecl.symbolId).length > 0,
  abstractDecl ? `callers: ${callersOf(abstractDecl.symbolId).length}` : "symbol missing"
);

console.log(log.join("\n"));
console.log(`\n  ${failures === 0 ? "PASS" : "FAIL"} — base-class dispatch (${failures} failing)`);
store.close();
assert.equal(failures, 0, `${failures} base-class dispatch check(s) failed`);
