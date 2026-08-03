import { performance } from "node:perf_hooks";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeTempDbPath } from "./test/_fixtures.mjs";

function readTextContent(result) {
  return Array.isArray(result?.content)
    ? (result.content.find((x) => x.type === "text")?.text ?? "")
    : "";
}

function bytesOf(text) {
  return Buffer.byteLength(text, "utf8");
}

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function booleanFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const repoPath = process.cwd();
  const repoId = process.env.BENCH_REPO_ID ?? "benchmark-repo";
  const minCompactSavingsPercent = numberFromEnv("BENCH_MIN_COMPACT_SAVINGS_PERCENT", 40);
  const requireCompactLowerPerScenario = booleanFromEnv("BENCH_REQUIRE_COMPACT_LOWER_PER_SCENARIO", true);
  const minResolvedCallEdgePct = numberFromEnv("BENCH_MIN_RESOLVED_CALL_EDGE_PCT", 60);

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...process.env,
      CODEBASE_INDEX_ALLOWED_ROOTS: [process.env.CODEBASE_INDEX_ALLOWED_ROOTS, repoPath]
        .filter(Boolean)
        .join(","),
      // Always a throwaway DB — same defect as the smoke test had: inheriting an ambient
      // CODEBASE_INDEX_DB_PATH would write a `benchmark-repo` row into the real central index.
      // Override by naming this script's own variable, never by inheritance.
      CODEBASE_INDEX_DB_PATH: process.env.CODEBASE_INDEX_BENCH_DB_PATH ?? makeTempDbPath("cbi-bench-"),
      CODEBASE_INDEX_TELEMETRY_ENABLED: process.env.CODEBASE_INDEX_TELEMETRY_ENABLED ?? "true",
      CODEBASE_INDEX_TELEMETRY_SAMPLE_RATE: process.env.CODEBASE_INDEX_TELEMETRY_SAMPLE_RATE ?? "1"
    },
    stderr: "pipe"
  });

  const client = new Client({
    name: "codebase-index-mcp-benchmark",
    version: "0.1.0"
  });

  await client.connect(transport);

  await client.callTool({
    name: "index_repository",
    arguments: {
      repoId,
      repoPath,
      mode: "full",
      maxFiles: 500
    }
  }, undefined, { timeout: 180_000 });

  const probe = await client.callTool({
    name: "search_symbols",
    arguments: {
      repoId,
      query: "runIndexAndResolve",
      limit: 1,
      profile: "standard"
    }
  });
  const probeText = readTextContent(probe);
  const probeJson = JSON.parse(probeText);
  const probeSymbolId = probeJson.symbols?.[0]?.symbolId ?? null;

  /**
   * The file the file-scoped scenarios measure. FIXED, not derived from the probe above.
   *
   * It used to be `probeJson.symbols[0].filePath`, which made the snapshot gate compare a
   * ratio against whatever file search ranked first that day. S-31 moved code out of
   * `src/index.ts`, the top hit became `src/indexing/indexRunner.ts`, and the gate reported a
   * savings regression for a scenario whose savings had actually improved (0.0511 → 0.0439 on
   * the same file) — it was reading two different files as one series. The ratio is
   * content-independent, so a file that changes size is fine; a file that changes IDENTITY is
   * not. Pinning it also makes the gate fail loudly if the path ever disappears, instead of
   * silently retargeting.
   */
  const contextFilePath = process.env.BENCH_CONTEXT_FILE ?? "src/repositories/graphStore.ts";
  const folderPath = contextFilePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/") || "src";

  // The comment above claims pinning the path "makes the gate fail loudly if the path ever disappears".
  // It did not. S-41 moved this file from `src/` into `src/store/`, the three path-dependent scenarios
  // (file-context, file-summary, folder-summary) began querying a file that does not exist, and the tool
  // answered with a near-empty payload instead of an error. `file-context` verbose fell from ~1274 bytes to
  // 264, its compact/verbose ratio moved 0.1232 -> 0.5947, and CI failed on every commit from S-41 onward —
  // for a reason that had nothing to do with token efficiency. `file-summary` and `folder-summary` were
  // measuring empty responses too; their ratios simply stayed inside the 0.05 tolerance, so nothing said so.
  //
  // So the check the comment promised now exists. A benchmark whose fixture has vanished must refuse to
  // produce a number, because a plausible number is worse than no number: it looks like a token regression
  // and sends the next reader after the wrong thing.
  //
  // The standard-structure refactor moved the file a second time — `src/store/` -> `src/repositories/` —
  // and this is the guard doing its job: it failed the run rather than silently measuring nothing.
  if (!fs.existsSync(path.join(repoPath, contextFilePath))) {
    throw new Error(
      `benchmark fixture missing: ${contextFilePath} does not exist under ${repoPath}. ` +
        `Point BENCH_CONTEXT_FILE at a real file, or update the default if the file moved. ` +
        `Benchmarking a non-existent path yields an empty payload and a meaningless ratio.`
    );
  }

  const scenarios = [
    {
      name: "symbol-candidates",
      makeArgs: (profile) => ({ name: "get_symbol_candidates", arguments: { repoId, name: "GraphStore", limit: 10, profile } })
    },
    {
      name: "context-by-name",
      makeArgs: (profile) => ({ name: "get_context_by_name", arguments: { repoId, name: "runIndexAndResolve", limit: 20, profile } })
    },
    {
      name: "change-context-by-name",
      makeArgs: (profile) => ({
        name: "get_change_context_by_name",
        arguments: { repoId, name: "runIndexAndResolve", callerDepth: 2, calleeDepth: 1, limit: 20, profile }
      })
    },
    {
      name: "search-symbols",
      makeArgs: (profile) => ({ name: "search_symbols", arguments: { repoId, query: "GraphStore", limit: 20, profile } })
    },
    {
      name: "file-context",
      makeArgs: (profile) => ({
        name: "get_file_context",
        arguments: { repoId, filePath: contextFilePath, limit: 200, profile }
      })
    },
    {
      name: "route-map",
      makeArgs: (profile) => ({ name: "route_map", arguments: { repoId, limit: 50, profile } })
    },
    {
      name: "query-graph",
      makeArgs: (profile) => ({
        name: "query_graph",
        arguments: {
          repoId,
          sql: "select kind, count(*) as cnt from symbols where repo_id = :repoId group by kind order by cnt desc",
          limit: 20,
          timeoutMs: 5000,
          profile
        }
      })
    },
    {
      name: "dead-code-scan",
      makeArgs: (profile) => ({ name: "dead_code_scan", arguments: { repoId, limit: 50, profile } })
    },
    {
      name: "detect-circular-dependencies",
      makeArgs: (profile) => ({
        name: "detect_circular_dependencies",
        arguments: { repoId, mode: "module", maxDepth: 4, maxCycles: 20, profile }
      })
    },
    {
      name: "cross-repo-impact",
      makeArgs: (profile) => ({
        name: "get_cross_repo_impact",
        arguments: { repoId, name: "GraphStore", direction: "outbound", limit: 20, profile }
      })
    },
    {
      name: "symbol-blame",
      makeArgs: (profile) => ({
        name: "get_symbol_blame",
        arguments: { repoId, name: "GraphStore", profile }
      })
    },
    {
      name: "link-tests-to-source",
      makeArgs: (profile) => ({
        name: "link_tests_to_source",
        arguments: { repoId, limit: 20, maxCandidates: 3, minScore: 0.4, profile }
      })
    },
    {
      name: "file-summary",
      makeArgs: (profile) => ({ name: "get_file_summary", arguments: { repoId, filePath: contextFilePath, profile } })
    },
    {
      name: "folder-summary",
      makeArgs: (profile) => ({ name: "get_folder_summary", arguments: { repoId, folderPath, maxFiles: 50, profile } })
    },
    {
      name: "symbol-context-pack",
      makeArgs: (profile) => ({ name: "get_symbol_context_pack", arguments: { repoId, name: "GraphStore", limit: 20, profile } })
    },
    ...(probeSymbolId
      ? [{
          name: "symbol-detail",
          makeArgs: (profile) => ({ name: "get_symbol_detail", arguments: { repoId, symbolId: probeSymbolId, limit: 50, profile } })
        }]
      : [])
  ];

  async function runProfile(profile) {
    const started = performance.now();
    const details = [];
    let totalBytes = 0;

    for (const scenario of scenarios) {
      const result = await client.callTool(scenario.makeArgs(profile));
      const text = readTextContent(result);
      const responseBytes = bytesOf(text);
      totalBytes += responseBytes;
      details.push({ scenario: scenario.name, responseBytes });
    }

    const elapsedMs = Math.round(performance.now() - started);
    return {
      profile,
      callCount: scenarios.length,
      elapsedMs,
      totalResponseBytes: totalBytes,
      details
    };
  }

  const standard = await runProfile("standard");
  const nano = await runProfile("nano");
  const compact = await runProfile("compact");
  const verbose = await runProfile("verbose");

  // Savings baseline = verbose (full fields + pretty-print). `standard` is now minified,
  // so verbose is the only "fullest" output to measure reduction against.
  const baselineBytes = Math.max(verbose.totalResponseBytes, 1);
  const nanoSavingsPercent = Number(
    ((1 - nano.totalResponseBytes / baselineBytes) * 100).toFixed(2)
  );

  // Graph accuracy gate: of the calls the extractor COULD have linked, how many did it link?
  //
  // The denominator is restricted to in-repo-resolvable calls: an edge counts only if it is
  // already resolved, or its unresolved token names a symbol that actually exists in this repo.
  // A call into a dependency — `z.string()`, `client.callTool()`, `process.exit()` — has no
  // symbol to point at and says nothing about extractor quality, so it is excluded.
  //
  // It used to count every CALLS edge in the repo, which made the number a function of how
  // much library-calling code the repo happened to contain. Two consequences, both observed:
  // adding ONE test script in S-31 moved it 61.61% -> 55.35% and failed a gate about the
  // extractor on a commit that touched no extractor code; and the top "unresolved" tokens were
  // `exit`, `fileURLToPath`, `callTool`, `resume` — every one of them a dependency call that
  // was never resolvable. Narrowing to src/ did not fix it either: src/ is full of zod builder
  // chains (`string`, `optional`, `strict`, `refine`), which are the same thing.
  const RESOLVABLE =
    "(e.to_id not like 'callee:%' or exists (select 1 from symbols s where s.repo_id = e.repo_id and s.name = substr(e.to_id, 8)))";
  let resolvedCallEdgePct = null;
  let unresolvedCalls = null;
  let totalCalls = null;
  let topUnresolvedCallTokens = [];
  let graphAccuracyGatePassed = true;
  try {
    const accuracyResult = await client.callTool({
      name: "query_graph",
      arguments: {
        repoId,
        sql: `select round(sum(case when e.to_id not like 'callee:%' then 1.0 else 0.0 end) * 100.0 / max(count(*), 1), 2) as resolved_pct, round(avg(e.confidence), 3) as avg_conf, count(*) as total, sum(case when e.to_id like 'callee:%' then 1 else 0 end) as unresolved_calls from edges e where e.repo_id = :repoId and e.type = 'CALLS' and ${RESOLVABLE}`,
        limit: 1,
        profile: "compact"
      }
    });
    const accuracyJson = JSON.parse(readTextContent(accuracyResult) || "{}");
    resolvedCallEdgePct = accuracyJson.rows?.[0]?.resolved_pct ?? null;
    unresolvedCalls = accuracyJson.rows?.[0]?.unresolved_calls ?? null;
    totalCalls = accuracyJson.rows?.[0]?.total ?? null;
    if (resolvedCallEdgePct !== null && resolvedCallEdgePct < minResolvedCallEdgePct) {
      graphAccuracyGatePassed = false;
    }

    const unresolvedTopResult = await client.callTool({
      name: "query_graph",
      arguments: {
        repoId,
        // Only resolvable misses are listed: these are the actionable ones, the tokens that
        // name a real symbol in this repo yet were still left as `callee:<token>`.
        sql: `select substr(e.to_id, 8) as callee_token, count(*) as cnt from edges e where e.repo_id = :repoId and e.type = 'CALLS' and e.to_id like 'callee:%' and ${RESOLVABLE} group by substr(e.to_id, 8) order by cnt desc limit 10`,
        limit: 10,
        profile: "compact"
      }
    });
    const unresolvedTopJson = JSON.parse(readTextContent(unresolvedTopResult) || "{}");
    topUnresolvedCallTokens = Array.isArray(unresolvedTopJson.rows) ? unresolvedTopJson.rows : [];
  } catch {
    // non-fatal: accuracy gate is best-effort
  }

  const compactSavingsPercent = Number(
    ((1 - compact.totalResponseBytes / baselineBytes) * 100).toFixed(2)
  );

  const perScenarioComparison = scenarios.map((scenario) => {
    const base = verbose.details.find((x) => x.scenario === scenario.name)?.responseBytes ?? 0;
    const cmp = compact.details.find((x) => x.scenario === scenario.name)?.responseBytes ?? 0;
    return {
      scenario: scenario.name,
      verboseBytes: base,
      compactBytes: cmp,
      compactIsLowerOrEqual: cmp <= base
    };
  });

  const failedScenarios = perScenarioComparison.filter((x) => !x.compactIsLowerOrEqual).map((x) => x.scenario);

  // ── Savings-ratio snapshot regression ────────────────────────────────────────
  // Tracks compactBytes/verboseBytes per scenario. Absolute byte counts drift with indexed
  // repo content (e.g. editing src/index.ts changes file-context size), which would make an
  // absolute-bytes gate fail on unrelated commits. The savings RATIO is content-independent
  // (both compact and verbose scale with content), so it is the stable regression signal:
  // a regression means compact got relatively bigger, i.e. lost savings.
  const snapshotPath = path.join(__dirname, "__snapshots__", "token-baseline.json");
  const ratioTolerance = numberFromEnv("BENCH_SNAPSHOT_RATIO_TOLERANCE", 0.05);
  const verboseByScenario = Object.fromEntries(verbose.details.map((d) => [d.scenario, d.responseBytes]));
  const currentSnapshot = Object.fromEntries(
    compact.details.map((d) => {
      const v = verboseByScenario[d.scenario] ?? 0;
      return [d.scenario, Number((v > 0 ? d.responseBytes / v : 1).toFixed(4))];
    })
  );
  let snapshotRegressions = [];
  let snapshotStatus = "compared";
  if (booleanFromEnv("BENCH_UPDATE_SNAPSHOT", false) || !fs.existsSync(snapshotPath)) {
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, JSON.stringify(currentSnapshot, null, 2) + "\n");
    snapshotStatus = "written";
  } else {
    const baseline = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    snapshotRegressions = Object.entries(currentSnapshot)
      .filter(([name, ratio]) => {
        const prev = baseline[name];
        return typeof prev === "number" && ratio > prev + ratioTolerance;
      })
      .map(([name, ratio]) => ({ scenario: name, baselineRatio: baseline[name], currentRatio: ratio }));
  }
  const snapshotGatePassed = snapshotRegressions.length === 0;

  const gatePassed =
    compactSavingsPercent >= minCompactSavingsPercent &&
    (!requireCompactLowerPerScenario || failedScenarios.length === 0);

  const report = {
    repoId,
    scenarioCount: scenarios.length,
    contextFilePath,
    standard,
    nano,
    compact,
    verbose,
    nanoSavingsPercent,
    compactSavingsPercent,
    graphAccuracy: {
      resolvedCallEdgePct,
      unresolvedCalls,
      totalCalls,
      topUnresolvedCallTokens,
      minResolvedCallEdgePct,
      passed: graphAccuracyGatePassed
    },
    qualityGate: {
      minCompactSavingsPercent,
      savingsBaseline: "verbose",
      requireCompactLowerPerScenario,
      perScenarioComparison,
      failedScenarios,
      passed: gatePassed
    },
    snapshotRegression: {
      snapshotPath: path.relative(repoPath, snapshotPath),
      status: snapshotStatus,
      metric: "compactBytes/verboseBytes ratio",
      ratioTolerance,
      regressions: snapshotRegressions,
      passed: snapshotGatePassed
    }
  };

  console.log(JSON.stringify(report, null, 2));

  await client.close();

  if (!gatePassed) {
    process.exitCode = 2;
  }
  if (!graphAccuracyGatePassed) {
    process.exitCode = 3;
  }
  if (!snapshotGatePassed) {
    process.exitCode = 4;
  }
}

main().catch((error) => {
  console.error("BENCHMARK_FAILED:", error);
  process.exit(1);
});
