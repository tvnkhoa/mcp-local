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
      mode: "incremental",
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
  const compact = await runProfile("compact");
  const verbose = await runProfile("verbose");

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
    compact,
    verbose,
    compactSavingsPercent,
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
}

main().catch((error) => {
  console.error("BENCHMARK_FAILED:", error);
  process.exit(1);
});
