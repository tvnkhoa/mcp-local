/**
 * Integration test for the CH-150 dogfooding refinements (logged in the issue registry):
 *
 *   ISSUE-015 — C# records are labeled `record` / `record struct`, not collapsed to `class`.
 *   ISSUE-016 — get_feature_bundle captures non-CRUD verb commands (SetEmailSignatureApplied)
 *               and resolves a plural-only IEndpointGroup endpoint group (EmailSignatures).
 *   ISSUE-017 — link_tests_to_source links a feature's same-entity test via name-affinity
 *               (EmailSignaturesCommandHandlerTests ↔ CreateEmailSignatureCommandHandler),
 *               which has no static CALLS/IMPORTS edge.
 *
 * Boots the real server over stdio against a temp C# vertical-slice fixture so the whole
 * pipeline (extract → graph → bundle/linker) is exercised end-to-end.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function text(res) {
  const t = res?.content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(t);
}

// ── fixture: a minimal C# vertical slice for the EmailSignature feature ──────────────
const FIXTURE = {
  "Domain/Entities/EmailSignature.cs": `
namespace App.Domain.Entities;
public class EmailSignature
{
    public int Id { get; set; }
    public string Body { get; set; }
}
`,
  "Infrastructure/Data/Configurations/EmailSignatureConfiguration.cs": `
namespace App.Infrastructure.Data.Configurations;
public interface IEntityTypeConfiguration<T> {}
public class EmailSignature {}
public class EmailSignatureConfiguration : IEntityTypeConfiguration<EmailSignature>
{
    public void Configure() {}
}
`,
  "Application/EmailSignatures/Commands/CreateEmailSignature/CreateEmailSignature.cs": `
namespace App.Application.EmailSignatures.Commands.CreateEmailSignature;
public interface IRequest<T> {}
public class Result {}
public record CreateEmailSignatureCommand(string Body) : IRequest<Result>;
public class CreateEmailSignatureCommandHandler
{
    public Result Handle(CreateEmailSignatureCommand request) => new Result();
}
public class CreateEmailSignatureCommandValidator {}
`,
  // ISSUE-016(a): a non-CRUD verb command with NO "Command" suffix, in a Commands/ folder.
  "Application/EmailSignatures/Commands/SetEmailSignatureApplied/SetEmailSignatureApplied.cs": `
namespace App.Application.EmailSignatures.Commands.SetEmailSignatureApplied;
public interface IAgentScopedRequest {}
public record SetEmailSignatureApplied(int Id, bool Applied) : IAgentScopedRequest;
public class SetEmailSignatureAppliedHandler
{
    public void Handle(SetEmailSignatureApplied request) {}
}
`,
  "Application/EmailSignatures/Queries/GetEmailSignature/GetEmailSignature.cs": `
namespace App.Application.EmailSignatures.Queries.GetEmailSignature;
public interface IRequest<T> {}
public class EmailSignatureDto {}
public record GetEmailSignatureQuery(int Id) : IRequest<EmailSignatureDto>;
public class GetEmailSignatureQueryHandler
{
    public EmailSignatureDto Handle(GetEmailSignatureQuery request) => new EmailSignatureDto();
}
`,
  // ISSUE-016(b): the endpoint group is the PLURAL entity name with no "Endpoints" suffix.
  "Web/Endpoints/EmailSignatures.cs": `
namespace App.Web.Endpoints;
public interface IEndpointGroup {}
public class EmailSignatures : IEndpointGroup
{
    public void Map() {}
}
`,
  // ISSUE-017: a same-entity test with no static edge to the handlers it exercises.
  "tests/Application.UnitTests/EmailSignatures/EmailSignaturesCommandHandlerTests.cs": `
namespace App.Application.UnitTests.EmailSignatures;
public class EmailSignaturesCommandHandlerTests
{
    public void CreateEmailSignature_persists() {}
    public void SetEmailSignatureApplied_updates() {}
}
`,
  // Unrelated slice — negative control: must NOT receive a name-affinity link to the EmailSignature test.
  "Application/Payments/Commands/CreatePayment/CreatePayment.cs": `
namespace App.Application.Payments.Commands.CreatePayment;
public interface IRequest<T> {}
public class Result {}
public record CreatePaymentCommand(decimal Amount) : IRequest<Result>;
public class CreatePaymentCommandHandler
{
    public Result Handle(CreatePaymentCommand request) => new Result();
}
`
};

function writeFixture(root) {
  for (const [rel, src] of Object.entries(FIXTURE)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, src.trimStart(), "utf8");
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbi-refinements-"));
  writeFixture(root);
  const repoId = "refinements-fixture";

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env, CODEBASE_INDEX_ALLOWED_ROOTS: root, CODEBASE_INDEX_DB_PATH: path.join(root, "index.db") },
    stderr: "pipe"
  });
  const client = new Client({ name: "test-refinements", version: "0.1.0" });
  await client.connect(transport);

  try {
    await client.callTool(
      { name: "index_repository", arguments: { repoId, repoPath: root, mode: "full", maxFiles: 200 } },
      undefined,
      { timeout: 120_000 }
    );

    // ── ISSUE-016 + ISSUE-015: get_feature_bundle on the EmailSignature slice ──────────
    const fb = text(
      await client.callTool({
        name: "get_feature_bundle",
        arguments: { repoId, seedSymbol: "EmailSignature", includeSource: false, profile: "standard" }
      })
    );
    assert.strictEqual(fb.entity?.name ?? fb.entity, "EmailSignature", `entity should resolve to EmailSignature, got ${JSON.stringify(fb.entity)}`);

    const commandNames = (fb.slice?.command ?? []).map((m) => m.name);
    assert(
      commandNames.includes("SetEmailSignatureApplied"),
      `ISSUE-016(a): expected SetEmailSignatureApplied in command role, got ${JSON.stringify(commandNames)}`
    );

    const endpointNames = (fb.slice?.endpoint ?? []).map((m) => m.name);
    assert(
      endpointNames.includes("EmailSignatures"),
      `ISSUE-016(b): expected plural endpoint group EmailSignatures in endpoint role, got ${JSON.stringify(endpointNames)}`
    );
    assert(
      !(fb.unresolvedRoles ?? []).includes("endpoint"),
      `ISSUE-016(b): endpoint role should be resolved, unresolvedRoles=${JSON.stringify(fb.unresolvedRoles)}`
    );

    const allMembers = Object.values(fb.slice ?? {}).flat();
    const recordMembers = allMembers.filter((m) => m.kind === "record");
    assert(
      recordMembers.some((m) => m.name === "CreateEmailSignatureCommand"),
      `ISSUE-015: expected CreateEmailSignatureCommand labeled kind 'record', got kinds ${JSON.stringify(allMembers.map((m) => `${m.name}:${m.kind}`))}`
    );
    console.log("[ok] ISSUE-016 + ISSUE-015 bundle assertions passed", {
      commands: commandNames,
      endpoint: endpointNames,
      records: recordMembers.map((m) => m.name)
    });

    // ── ISSUE-017: name-affinity test linkage (no static edge) ───────────────────────
    const srcRel = "Application/EmailSignatures/Commands/CreateEmailSignature/CreateEmailSignature.cs";
    const linkRes = text(
      await client.callTool({ name: "link_tests_to_source", arguments: { repoId, filePath: srcRel, profile: "compact" } })
    );
    const affinity = (linkRes.links ?? []).find(
      (l) => /EmailSignaturesCommandHandlerTests/.test(l.testFile) && (l.reasons ?? []).includes("name-affinity")
    );
    assert(
      affinity,
      `ISSUE-017: expected a name-affinity link to EmailSignaturesCommandHandlerTests, got ${JSON.stringify(linkRes.links)}`
    );
    assert(affinity.score >= 0.4, `ISSUE-017: affinity link must clear the default minScore (0.4), got ${affinity.score}`);

    // Negative control: the unrelated payment handler must NOT match the EmailSignature test.
    const payRes = text(
      await client.callTool({
        name: "link_tests_to_source",
        arguments: { repoId, filePath: "Application/Payments/Commands/CreatePayment/CreatePayment.cs", profile: "compact" }
      })
    );
    const falseLink = (payRes.links ?? []).find((l) => /EmailSignaturesCommandHandlerTests/.test(l.testFile));
    assert(
      !falseLink,
      `ISSUE-017: payment handler must not name-affinity-link the EmailSignature test, got ${JSON.stringify(falseLink)}`
    );
    console.log("[ok] ISSUE-017 name-affinity assertions passed", {
      affinity: { testFile: affinity.testFile, score: affinity.score, reasons: affinity.reasons }
    });

    console.log("test-issue-refinements: ALL PASS");
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("test-issue-refinements FAILED:", err);
  process.exit(1);
});
