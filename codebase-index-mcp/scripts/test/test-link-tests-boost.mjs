/**
 * ENH-029-D regression: a change under the EF/persistence layer must admit + boost the
 * integration (round-trip) test, even when its name shares no tokens with the changed file —
 * whereas the same-named unit test alone would otherwise dominate name-affinity linkage.
 */
import Database from "better-sqlite3";
import { linkTestsToSource } from "../../dist/staticAnalyzer.js";

let passed = 0;
let failed = 0;
function assert(cond, label, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

const db = new Database(":memory:");
db.exec(`create table files (repo_id text not null, path text not null);
         create table edges (repo_id text, from_id text, to_id text, type text);
         create table symbols (repo_id text, symbol_id text, file_path text);`);

const repoId = "r";
const files = [
  "src/Infrastructure/Data/Configurations/HandledByConfiguration.cs", // changed persistence file
  "src/Domain/Conversation.cs",
  "tests/Unit/HandledByConfigurationTests.cs",                        // same-named unit test
  "tests/Integration/InboundMessageConsumerIntegrationTests.cs"       // round-trip integration test
];
const ins = db.prepare("insert into files (repo_id, path) values (?, ?)");
for (const f of files) ins.run(repoId, f);

// 1) Persistence change → integration test is admitted and boosted.
const infraLinks = linkTestsToSource(db, repoId, "src/Infrastructure/Data/Configurations/HandledByConfiguration.cs", 20, 20, 0.4);
const infraIntegration = infraLinks.find((l) => l.testFile.includes("IntegrationTests"));
assert(infraIntegration != null, "infra change surfaces the integration test", JSON.stringify(infraLinks));
assert(
  infraIntegration?.reasons?.includes("infrastructure_integration_priority"),
  "integration test link carries infrastructure_integration_priority reason",
  JSON.stringify(infraIntegration)
);

// 2) Non-persistence change → integration test is NOT admitted by the infra rule.
const domainLinks = linkTestsToSource(db, repoId, "src/Domain/Conversation.cs", 20, 20, 0.4);
assert(
  !domainLinks.some((l) => l.reasons?.includes("infrastructure_integration_priority")),
  "non-infra change does not trigger the infra boost",
  JSON.stringify(domainLinks)
);

db.close();
console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
