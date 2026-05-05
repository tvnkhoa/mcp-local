import { performance } from "node:perf_hooks";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
      CODEBASE_INDEX_ALLOWED_ROOTS: process.env.CODEBASE_INDEX_ALLOWED_ROOTS ?? repoPath,
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
  const contextFilePath = probeJson.symbols?.[0]?.filePath ?? "src/index.ts";

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
    }
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

  const nanoSavingsPercent = Number(
    ((1 - nano.totalResponseBytes / Math.max(standard.totalResponseBytes, 1)) * 100).toFixed(2)
  );

  // Graph accuracy gate: measure resolved CALLS edge percentage via query_graph
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
        sql: "select round(sum(case when confidence >= 0.75 then 1.0 else 0.0 end) * 100.0 / max(count(*), 1), 2) as resolved_pct, round(avg(confidence), 3) as avg_conf, count(*) as total, sum(case when to_id like 'callee:%' then 1 else 0 end) as unresolved_calls from edges where repo_id = :repoId and type = 'CALLS'",
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
        sql: "select substr(to_id, 8) as callee_token, count(*) as cnt from edges where repo_id = :repoId and type = 'CALLS' and to_id like 'callee:%' group by substr(to_id, 8) order by cnt desc limit 10",
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
    ((1 - compact.totalResponseBytes / Math.max(standard.totalResponseBytes, 1)) * 100).toFixed(2)
  );

  const perScenarioComparison = scenarios.map((scenario) => {
    const std = standard.details.find((x) => x.scenario === scenario.name)?.responseBytes ?? 0;
    const cmp = compact.details.find((x) => x.scenario === scenario.name)?.responseBytes ?? 0;
    return {
      scenario: scenario.name,
      standardBytes: std,
      compactBytes: cmp,
      compactIsLowerOrEqual: cmp <= std
    };
  });

  const failedScenarios = perScenarioComparison.filter((x) => !x.compactIsLowerOrEqual).map((x) => x.scenario);
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
      requireCompactLowerPerScenario,
      perScenarioComparison,
      failedScenarios,
      passed: gatePassed
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
}

main().catch((error) => {
  console.error("BENCHMARK_FAILED:", error);
  process.exit(1);
});
