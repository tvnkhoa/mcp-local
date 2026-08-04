import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { initGraphSchema } from "./schema.js";
import {
  findPackageConsumersImpl,
  findPackageProvidersImpl,
  packageContractExistsImpl,
  countPublisherSelfReferencesImpl
} from "./crossRepoStore.js";
import {
  recordPendingReindexFilesImpl,
  getPendingReindexFilesImpl,
  clearPendingReindexFilesImpl
} from "./refactorStore.js";

/**
 * The two Wave-1/2 predicates whose whole point is invisible in the result shape (MCP-ISSUE-046,
 * MCP-ISSUE-042). Against the real schema on `:memory:`, per the reasoning in graphQueries.test.ts.
 *
 * `find_package_consumers` returned the files that DEFINE a package, which is the inverse of the
 * question asked, and a wrong package name was indistinguishable from a package with no consumers.
 * Both are one-row-versus-another distinctions that a smoke test would pass straight through.
 */

const CONTRACT = "nuget:acme.messaging";

function db() {
  const conn = new Database(":memory:");
  initGraphSchema(conn);
  const now = new Date().toISOString();
  for (const repoId of ["publisher", "consumer"]) {
    conn.prepare("insert into repositories (repo_id, repo_path, updated_at) values (?, ?, ?)").run(repoId, `/tmp/${repoId}`, now);
  }
  // The publisher's .csproj exports the contract: dotnetProjectParser emits a `module` symbol whose
  // signature IS the contract id. That symbol is how the publisher is identifiable.
  conn.prepare(
    `insert into symbols (repo_id, symbol_id, file_path, name, kind, line, signature)
     values (?, ?, ?, ?, ?, ?, ?)`
  ).run("publisher", "pub-export", "src/Acme.Messaging/Acme.Messaging.csproj", "Acme.Messaging", "module", 1, CONTRACT);
  return conn;
}

function addDependsOn(conn: Database.Database, repoId: string, fromId: string, filePath: string) {
  conn.prepare(
    `insert into symbols (repo_id, symbol_id, file_path, name, kind, line, signature)
     values (?, ?, ?, ?, ?, ?, ?)`
  ).run(repoId, fromId, filePath, fromId, "module", 1, null);
  conn.prepare(
    `insert into edges (repo_id, from_id, to_id, type, confidence, reason)
     values (?, ?, ?, ?, ?, ?)`
  ).run(repoId, fromId, CONTRACT, "DEPENDS_ON", 1.0, "namespace package contract bridge");
}

test("find_package_consumers excludes the repo that publishes the contract", () => {
  const conn = db();
  // The publisher's own contract files `using` their siblings, so they emit DEPENDS_ON to themselves.
  addDependsOn(conn, "publisher", "pub-contract-a", "src/Acme.Messaging/Contracts/A.cs");
  addDependsOn(conn, "publisher", "pub-contract-b", "src/Acme.Messaging/Contracts/B.cs");
  addDependsOn(conn, "consumer", "consumer-usage", "src/App/Handler.cs");

  const rows = findPackageConsumersImpl(conn, CONTRACT, null, 100);

  assert.deepEqual(rows.map((r) => r.consumerRepoId), ["consumer"]);
  assert.equal(rows[0]?.consumerFilePath, "src/App/Handler.cs");
  // The exclusion must not be silent.
  assert.equal(countPublisherSelfReferencesImpl(conn, CONTRACT), 2);
});

test("the publisher is still reported, just not as a consumer", () => {
  const conn = db();
  addDependsOn(conn, "consumer", "consumer-usage", "src/App/Handler.cs");

  const providers = findPackageProvidersImpl(conn, CONTRACT, 10);
  assert.deepEqual(providers.map((p) => p.providerRepoId), ["publisher"]);
});

test("an unknown contract id is distinguishable from one with no consumers", () => {
  const conn = db();
  assert.equal(packageContractExistsImpl(conn, CONTRACT), true, "published but unconsumed → exists");
  assert.equal(packageContractExistsImpl(conn, "nuget:acme.typo"), false, "never seen → does not exist");
});

test("pending re-index set round-trips and clears per repo", () => {
  const conn = db();
  recordPendingReindexFilesImpl(conn, "consumer", ["src/App/Handler.cs", "src/App/Other.cs"], "restored by refactor rollback");
  recordPendingReindexFilesImpl(conn, "publisher", ["src/Acme.Messaging/Contracts/A.cs"], "written by refactor apply");

  const pending = getPendingReindexFilesImpl(conn, "consumer");
  assert.deepEqual(pending.map((p) => p.filePath), ["src/App/Handler.cs", "src/App/Other.cs"]);
  assert.equal(pending[0]?.reason, "restored by refactor rollback");

  // Re-recording the same file must not duplicate it — the set is keyed by (repo, file).
  recordPendingReindexFilesImpl(conn, "consumer", ["src/App/Handler.cs"], "written by refactor apply");
  assert.equal(getPendingReindexFilesImpl(conn, "consumer").length, 2);
  assert.equal(getPendingReindexFilesImpl(conn, "consumer")[0]?.reason, "written by refactor apply");

  // Clearing is scoped to the repo whose index run finished.
  clearPendingReindexFilesImpl(conn, "consumer");
  assert.equal(getPendingReindexFilesImpl(conn, "consumer").length, 0);
  assert.equal(getPendingReindexFilesImpl(conn, "publisher").length, 1);
});
