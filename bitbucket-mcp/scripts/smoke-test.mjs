import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// End-to-end smoke test. Requires a build (dist/index.js) and real Bitbucket
// credentials in the environment:
//   BITBUCKET_ACCESS_TOKEN, BITBUCKET_WORKSPACE (+ optional BITBUCKET_DEFAULT_REPO)
// Run: npm run build && node scripts/smoke-test.mjs
//
// This test is READ-ONLY plus a create_pull_request DRY RUN — it never creates a
// real PR, so it is safe to run against any workspace. The pipeline steps only
// read; nothing here triggers, stops or re-runs a build.
//
// The pipeline filter cases below are a REGRESSION guard, not an exploration.
// Probing the live API on 2026-08-21 established that this endpoint ignores
// `q`/BBQL completely and filters only via `target.branch` and a repeatable
// `status`, whose vocabulary differs from the response's (`PASSED`, not
// `SUCCESSFUL`). An unsupported status answers 200 with an empty page, so a
// broken filter cannot be detected from the status code — only by checking that
// a filtered page actually excludes what it should. That is what these assert.
//
// Reading pipelines needs the `pipeline` scope on the token. A 403 on the
// pipeline calls while everything above passes means exactly that, and is a
// token problem rather than a code failure.

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

    // 6. Pipelines — the read-only CI walk.
    const pipelines = await client.callTool({
      name: "list_pipelines",
      arguments: { repoSlug, pagelen: 5, profile: "standard" }
    });
    console.log(`\nLIST_PIPELINES (${repoSlug}):\n` + textOf(pipelines));

    let firstRun;
    let runs = [];
    try {
      runs = JSON.parse(textOf(pipelines))?.pipelines ?? [];
      firstRun = runs[0];
    } catch {
      /* ignore */
    }

    // 6a. `sort` must actually order the page. This endpoint ignores `q` with no
    // error, so "a parameter was accepted" proves nothing — and everything below
    // treats pipelines[0] as the newest run.
    const numbers = runs.map((run) => run.buildNumber).filter((n) => typeof n === "number");
    const descending = numbers.every((n, i) => i === 0 || numbers[i - 1] > n);
    if (numbers.length > 1 && !descending) {
      console.log(`\nLIST_PIPELINES sort: BROKEN — not newest-first: ${numbers.join(" ")}`);
      process.exitCode = 1;
    } else {
      console.log(`\nLIST_PIPELINES sort: OK — newest-first (${numbers.join(" ") || "n/a"})`);
    }

    // 6b. Each filter, checked by what it EXCLUDES. A broken filter here answers
    // 200 with an unfiltered (or empty) page, never a 4xx, so the status code
    // proves nothing — only the predicate does.
    let mainBranch;
    try {
      const repo = await client.callTool({
        name: "get_repository",
        arguments: { repoSlug, profile: "standard" }
      });
      mainBranch = JSON.parse(textOf(repo))?.repository?.mainBranch;
    } catch {
      /* ignore */
    }
    const filterCases = [
      // label, args, and what every returned run must satisfy.
      [
        "branch (target.branch)",
        mainBranch ? { branch: mainBranch } : null,
        (run) => run.refName === mainBranch
      ],
      [
        "status FAILED",
        { status: ["FAILED"] },
        (run) => run.result === "FAILED"
      ],
      [
        "status PASSED (= SUCCESSFUL result)",
        { status: ["PASSED"] },
        (run) => run.result === "SUCCESSFUL"
      ],
      [
        "status FAILED+STOPPED (OR)",
        { status: ["FAILED", "STOPPED"] },
        (run) => run.result === "FAILED" || run.result === "STOPPED"
      ],
      [
        "branch that cannot exist",
        { branch: "smoke-test-no-such-branch" },
        () => false // nothing may come back at all
      ]
    ];
    for (const [label, extra, predicate] of filterCases) {
      if (!extra) {
        console.log(`\nLIST_PIPELINES filter ${label}: skipped (no main branch)`);
        continue;
      }
      const filtered = await client.callTool({
        name: "list_pipelines",
        arguments: { repoSlug, pagelen: 20, profile: "standard", ...extra }
      });
      let runs;
      try {
        runs = JSON.parse(textOf(filtered))?.pipelines ?? [];
      } catch {
        runs = [];
      }
      const leaked = runs.filter((run) => !predicate(run));
      const verdict = leaked.length === 0 ? "OK" : `BROKEN — filter did not apply`;
      console.log(
        `\nLIST_PIPELINES filter ${label}: ${verdict} ` +
          `(${runs.length} run(s)${
            leaked.length > 0
              ? `, leaked: ${leaked.map((r) => `${r.buildNumber}:${r.result}`).join(" ")}`
              : ""
          })`
      );
      if (leaked.length > 0) {
        // Not thrown: the point is to report every filter's verdict in one run.
        process.exitCode = 1;
      }
    }

    if (firstRun?.uuid) {
      // 7. One run, addressed both ways: braced and bare.
      const bare = String(firstRun.uuid).replace(/^\{|\}$/g, "");
      for (const ref of [firstRun.uuid, bare]) {
        const run = await client.callTool({
          name: "get_pipeline",
          arguments: { repoSlug, pipelineUuid: ref, profile: "standard" }
        });
        console.log(`\nGET_PIPELINE (${ref}):\n` + textOf(run));
      }

      // 8. Steps, then the tail of the last step's log. Addressed by BUILD
      // NUMBER here (the log call below uses the uuid), because all three
      // run-scoped tools advertise both forms and only get_pipeline was ever
      // exercised with a build number.
      const stepsRef =
        typeof firstRun.buildNumber === "number" ? String(firstRun.buildNumber) : firstRun.uuid;
      const stepsResult = await client.callTool({
        name: "list_pipeline_steps",
        arguments: { repoSlug, pipelineUuid: stepsRef, profile: "standard" }
      });
      console.log(`\nLIST_PIPELINE_STEPS:\n` + textOf(stepsResult));

      let steps = [];
      try {
        steps = JSON.parse(textOf(stepsResult))?.steps ?? [];
      } catch {
        /* ignore */
      }
      const lastStep = steps[steps.length - 1];
      if (lastStep?.uuid) {
        const log = await client.callTool({
          name: "get_pipeline_step_log",
          arguments: {
            repoSlug,
            pipelineUuid: firstRun.uuid,
            stepUuid: lastStep.uuid,
            maxBytes: 4096,
            profile: "standard"
          }
        });
        // Check by eye: returnedBytes <= 4096, and the log is the END of the
        // step (its finishing lines), not the beginning.
        console.log(
          `\nGET_PIPELINE_STEP_LOG (${lastStep.name ?? lastStep.uuid}):\n` + textOf(log)
        );

        // 8b. The same log with a tail far larger than it can be. Upstream still
        // answers 206, but at offset 0 — the whole log. Reading that as a cut
        // (which a bare status check does) deleted the real first line and lied
        // in `truncated`. This asserts it does not.
        const whole = await client.callTool({
          name: "get_pipeline_step_log",
          arguments: {
            repoSlug,
            pipelineUuid: firstRun.uuid,
            stepUuid: lastStep.uuid,
            maxBytes: 1048576,
            profile: "standard"
          }
        });
        let wholeBody;
        try {
          wholeBody = JSON.parse(textOf(whole));
        } catch {
          wholeBody = null;
        }
        if (wholeBody?.truncated === true) {
          console.log(
            "\nGET_PIPELINE_STEP_LOG (max tail): BROKEN — a whole log reported as truncated"
          );
          process.exitCode = 1;
        } else {
          console.log(
            `\nGET_PIPELINE_STEP_LOG (max tail): OK — truncated=false, ` +
              `${wholeBody?.returnedBytes ?? "?"} bytes, first line kept: ` +
              JSON.stringify((wholeBody?.log ?? "").split("\n", 1)[0].slice(0, 60))
          );
        }
      } else {
        console.log("\nNo pipeline step with a uuid — skipped the step log.");
      }
    } else {
      console.log("\nNo pipeline runs in this repo — skipped the run-scoped pipeline calls.");
    }
  } else {
    console.log("\nNo repo available (empty workspace and no BITBUCKET_DEFAULT_REPO) — skipped repo-scoped calls.");
  }

  await client.close();
}

main().catch((error) => {
  console.error("SMOKE_TEST_FAILED:", error);
  process.exit(1);
});
