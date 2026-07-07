import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// End-to-end smoke test. Requires a build (dist/index.js) and real Bitbucket
// credentials in the environment:
//   BITBUCKET_ACCESS_TOKEN, BITBUCKET_WORKSPACE (+ optional BITBUCKET_DEFAULT_REPO)
// Run: npm run build && node scripts/smoke-test.mjs
//
// This test is READ-ONLY plus a create_pull_request DRY RUN — it never creates a
// real PR, so it is safe to run against any workspace.

function textOf(result) {
  const content = Array.isArray(result.content) ? result.content : [];
  return content.find((x) => x.type === "text")?.text ?? "<no text content>";
}

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: process.env,
    stderr: "pipe"
  });
  transport.onerror = (error) => console.error("[transport-error]", error);

  const client = new Client({ name: "bitbucket-mcp-smoke-test", version: "0.1.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("TOOLS:", tools.tools.map((t) => t.name));

  // 1. Connectivity + auth check.
  const health = await client.callTool({ name: "health_check", arguments: { profile: "standard" } });
  console.log("\nHEALTH_CHECK:\n" + textOf(health));

  // 2. List repositories in the workspace.
  const repos = await client.callTool({
    name: "list_repositories",
    arguments: { pagelen: 5, sort: "-updated_on", profile: "standard" }
  });
  console.log("\nLIST_REPOSITORIES:\n" + textOf(repos));

  // Pick a repo: the default repo if configured, else the first listed.
  let repoSlug = process.env.BITBUCKET_DEFAULT_REPO;
  if (!repoSlug) {
    try {
      const parsed = JSON.parse(textOf(repos));
      repoSlug = parsed?.repositories?.find((r) => r.slug)?.slug;
    } catch {
      /* ignore */
    }
  }

  if (repoSlug) {
    // 3. Branches — the pool you'd pick a PR source/destination from.
    const branches = await client.callTool({
      name: "list_branches",
      arguments: { repoSlug, pagelen: 10, profile: "standard" }
    });
    console.log(`\nLIST_BRANCHES (${repoSlug}):\n` + textOf(branches));

    // 4. Open pull requests.
    const prs = await client.callTool({
      name: "list_pull_requests",
      arguments: { repoSlug, state: "OPEN", pagelen: 5, profile: "standard" }
    });
    console.log(`\nLIST_PULL_REQUESTS (${repoSlug}):\n` + textOf(prs));

    // 5. create_pull_request DRY RUN — verifies payload build without writing.
    const dry = await client.callTool({
      name: "create_pull_request",
      arguments: {
        repoSlug,
        title: "[smoke-test] dry run — not created",
        sourceBranch: "smoke-test-source",
        destinationBranch: "main",
        dryRun: true,
        profile: "standard"
      }
    });
    console.log(`\nCREATE_PULL_REQUEST (dryRun):\n` + textOf(dry));
  } else {
    console.log("\nNo repo available (empty workspace and no BITBUCKET_DEFAULT_REPO) — skipped repo-scoped calls.");
  }

  await client.close();
}

main().catch((error) => {
  console.error("SMOKE_TEST_FAILED:", error);
  process.exit(1);
});
