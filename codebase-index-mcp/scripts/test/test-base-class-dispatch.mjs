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

import { GraphStore } from "../../dist/repositories/graphStore.js";
import { extractGraphData } from "../../dist/services/extractors/treeSitterExtractor.js";

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

// --- MCP-ISSUE-137: overrides bound by owner TYPE, not by the subclass's file ------------------------
// `RepoBase.Save` calls its own virtual `AddAsync`. `Shared.cs` holds a RepoBase subclass with no override
// beside `AudienceRepo`, which overrides a same-named member of an UNRELATED base; `Pair.cs` holds two
// RepoBase subclasses that both override it. Keyed by file, the fan-out took the first `AddAsync` in each
// file: AudienceRepo's method reached through NoOverrideRepo, and one of the pair missed.
const repoBase = indexFile(
  "src/RepoBase.cs",
  `
public abstract class RepoBase
{
    public virtual void AddAsync(int x) { }
    public virtual void Put(int x) { }
    public virtual void Put(int x, int y) { }
    public void Save(int x) { AddAsync(x); Put(x); }
}
public abstract class OtherBase
{
    public virtual void AddAsync(int x) { }
}
`
);
const shared = indexFile(
  "src/Shared.cs",
  `
public class AudienceRepo : OtherBase
{
    public override void AddAsync(int x) { }
}
public class NoOverrideRepo : RepoBase
{
}
`
);
const pair = indexFile(
  "src/Pair.cs",
  `
public class FirstRepo : RepoBase
{
    public override void AddAsync(int x) { }
}
public class SecondRepo : RepoBase
{
    public override void AddAsync(int x) { }
}
`
);
// A partial subclass: the base list in one part, the override in the other part's file.
indexFile("src/PartialRepo.cs", `public partial class PartialRepo : RepoBase { }`);
const partialOverride = indexFile(
  "src/PartialRepo.Add.cs",
  `
public partial class PartialRepo
{
    public override void AddAsync(int x) { }
}
`
);
// Row 13 review: a namesake partial in a SIBLING folder is not another part of this type. `NsA/Handler` (no
// override) extends RepoBase; `NsB/Handler` extends OtherBase and overrides AddAsync.
indexFile("src/NsA/Handler.cs", `public partial class Handler : RepoBase { }`);
const nsbHandler = indexFile(
  "src/NsB/Handler.cs",
  `
public partial class Handler : OtherBase
{
    public override void AddAsync(int x) { }
}
`
);
// Row 13 review: an override of the OTHER overload. `Save` calls `Put(int)`; PutRepo overrides only `Put(int, int)`.
const putRepo = indexFile(
  "src/PutRepo.cs",
  `
public class PutRepo : RepoBase
{
    public override void Put(int x, int y) { }
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

// --- MCP-ISSUE-137 --------------------------------------------------------------------------------
const saveCaller = method(repoBase, "Save");
const ownedBy = (extracted, ownerName, name) => {
  const owner = extracted.symbols.find((s) => s.kind === "class" && s.name === ownerName);
  return extracted.symbols.find((s) => s.kind === "method" && s.name === name && s.parentSymbolId === owner?.symbolId);
};
const dispatchedFromSave = (sym) =>
  sym !== undefined && callersOf(sym.symbolId).some((e) => e.reason === "base-class-dispatch" && e.fromId === saveCaller?.symbolId);
for (const owner of ["FirstRepo", "SecondRepo"]) {
  const o = ownedBy(pair, owner, "AddAsync");
  check(`MCP-ISSUE-137: ${owner}.AddAsync, one of two overrides in one file, is reached`, dispatchedFromSave(o), o ? JSON.stringify(callersOf(o.symbolId)) : "symbol missing");
}
const audience = ownedBy(shared, "AudienceRepo", "AddAsync");
check(
  "MCP-ISSUE-137: AudienceRepo.AddAsync (another base's override, same file as RepoBase subclasses) is NOT reached",
  audience !== undefined && !dispatchedFromSave(audience),
  audience ? JSON.stringify(callersOf(audience.symbolId)) : "symbol missing"
);
const partialAdd = method(partialOverride, "AddAsync");
check(
  "MCP-ISSUE-137: a partial subclass's override in its other part's file is reached",
  dispatchedFromSave(partialAdd),
  partialAdd ? JSON.stringify(callersOf(partialAdd.symbolId)) : "symbol missing"
);
const nsbAdd = method(nsbHandler, "AddAsync");
check(
  "row 13 review: a namesake partial's override in a sibling folder (NsB/Handler : OtherBase) is NOT reached",
  nsbAdd !== undefined && !dispatchedFromSave(nsbAdd),
  nsbAdd ? JSON.stringify(callersOf(nsbAdd.symbolId)) : "symbol missing"
);
const putPair = method(putRepo, "Put");
const putTargets = store.getCallEdges(repoId, saveCaller?.symbolId, "callees", 50).filter((e) => e.toName === "Put" || /Put/.test(e.toId));
check(
  "row 13 review: an override of Put(int, int) is NOT reached from a call on Put(int)",
  putPair !== undefined && !dispatchedFromSave(putPair),
  putPair ? `callers ${JSON.stringify(callersOf(putPair.symbolId))}; Save callees ${JSON.stringify(putTargets)}` : "symbol missing"
);

console.log(log.join("\n"));
console.log(`\n  ${failures === 0 ? "PASS" : "FAIL"} — base-class dispatch (${failures} failing)`);
store.close();
assert.equal(failures, 0, `${failures} base-class dispatch check(s) failed`);
