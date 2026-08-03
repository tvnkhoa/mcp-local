/**
 * MCP Resource handlers
 * Handles ListResources and ReadResource requests
 */

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { GraphStore } from "../store/graphStore.js";
import { parseRepoResourceUri } from "../serverUtils.js";
import { getRepoStaleness, runGitLines } from "../gitHelpers.js";
import { resolveDetectChangesPolicy, scoreChangeRisk } from "../analysis/policyResolver.js";

export function handleListResources(store: GraphStore, cursor?: string) {
  if (cursor) {
    return { resources: [] };
  }

  const resources = store.listRepositories().flatMap((repo) => ([
    {
      uri: `repo://${repo.repoId}/context`,
      name: `${repo.repoId} context`,
      description: "Repository metadata, latest run, and staleness snapshot",
      mimeType: "application/json"
    },
    {
      uri: `repo://${repo.repoId}/schema`,
      name: `${repo.repoId} schema`,
      description: "Graph storage counts and language distribution",
      mimeType: "application/json"
    },
    {
      uri: `repo://${repo.repoId}/routes`,
      name: `${repo.repoId} routes`,
      description: "C# ASP.NET route map extracted from attributes",
      mimeType: "application/json"
    },
    {
      uri: `repo://${repo.repoId}/risk`,
      name: `${repo.repoId} risk`,
      description: "Compact deterministic detect_changes snapshot",
      mimeType: "application/json"
    }
  ]));

  return { resources };
}

export function handleReadResource(
  uri: string,
  store: GraphStore,
  maxResultLimit: number
) {
  const parsed = parseRepoResourceUri(uri, maxResultLimit);
  if (!parsed) {
    throw new McpError(ErrorCode.InvalidParams, "resources/read: unsupported uri. Use repo://{repoId}/{context|schema|routes|risk}");
  }

  const repo = store.getRepository(parsed.repoId);
  if (!repo) {
    throw new McpError(ErrorCode.InvalidParams, `resources/read: unknown repoId '${parsed.repoId}'. Run index_repository first.`);
  }

  let payload: unknown;
  if (parsed.resource === "context") {
    payload = {
      repo: store.getRepository(parsed.repoId),
      latestRun: store.getLatestRun(parsed.repoId),
      staleness: getRepoStaleness(parsed.repoId, store)
    };
  } else if (parsed.resource === "schema") {
    payload = store.getRepoSchemaSnapshot(parsed.repoId);
  } else if (parsed.resource === "routes") {
    const routes = store.getRouteMap(parsed.repoId, null, null, Math.min(parsed.limit ?? 200, maxResultLimit));
    payload = {
      repoId: parsed.repoId,
      count: routes.length,
      routes
    };
  } else {
    const risk = buildRiskSnapshot(store, parsed.repoId, "strict-review", Math.min(parsed.limit ?? 50, 100));
    payload = risk;
  }

  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

export function buildRiskSnapshot(
  store: GraphStore,
  repoId: string,
  policy: "quick-triage" | "strict-review" | "release-gate" | "custom",
  maxResults: number
): {
  repoId: string;
  policy: string;
  changedFileCount: number;
  highRiskCount: number;
  mediumRiskCount: number;
  lowRiskCount: number;
  topRiskChanges: { filePath: string; riskScore: number; riskLevel: "high" | "medium" | "low" }[];
} {
  const repo = store.getRepository(repoId);
  if (!repo) {
    return {
      repoId,
      policy,
      changedFileCount: 0,
      highRiskCount: 0,
      mediumRiskCount: 0,
      lowRiskCount: 0,
      topRiskChanges: []
    };
  }

  const defaults = resolveDetectChangesPolicy(policy);
  const changedFiles = runGitLines(repo.repoPath, ["diff", "--name-only", "HEAD"]).map((x) => x.replace(/\\/g, "/")).slice(0, 100);
  const impacts = changedFiles.map((filePath) => {
    const impact = store.getImpactFiles(repoId, filePath, 20);
    const risk = scoreChangeRisk(impact.impactedFiles.length, impact.reliabilitySummary, 20);
    return { filePath, riskScore: risk.riskScore, riskLevel: risk.riskLevel };
  });

  const allowedLevels = new Set(defaults.riskLevels);
  const filtered = impacts
    .filter((x) => x.riskScore >= defaults.minRiskScore && allowedLevels.has(x.riskLevel))
    .sort((a, b) => b.riskScore - a.riskScore || a.filePath.localeCompare(b.filePath))
    .slice(0, Math.max(1, maxResults));

  return {
    repoId,
    policy,
    changedFileCount: changedFiles.length,
    highRiskCount: filtered.filter((x) => x.riskLevel === "high").length,
    mediumRiskCount: filtered.filter((x) => x.riskLevel === "medium").length,
    lowRiskCount: filtered.filter((x) => x.riskLevel === "low").length,
    topRiskChanges: filtered
  };
}
