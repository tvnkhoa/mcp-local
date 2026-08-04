/**
 * The `repo://{repoId}/{context|schema|routes|risk}` resources.
 *
 * Declared through `createResource` / `registerResource` rather than as a
 * hand-written `list`/`read` pair: what the builders absorb is the descriptor
 * plumbing, the mime type, the JSON serialization and the not-my-URI contract.
 * What stays here is this server's own behaviour, all of it client-visible:
 *
 *   - one **family**, not four resources — so `resources/list` keeps emitting the
 *     four kinds grouped per repository, in that order
 *   - `parseRepoResourceUri` as the router, because the URI carries a
 *     percent-encoded repoId, a case-insensitive kind and a clamped `?limit=`
 *   - two-space pretty printing, which is the payload shape clients already parse
 *   - `onUnmatched` / the unknown-repoId throw, keeping both `McpError` messages
 *     — including the one that names the URI grammar
 *   - `emptyOnCursor`, keeping the answer to a cursored list an empty page
 */

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { ResourceDescriptor, ResourceProvider } from "@mcp/sdk";
import { createResource, registerResource } from "@mcp/sdk";

import type { GraphStore } from "../repositories/graphStore.js";
import { normalizeResourcePayload } from "../middleware/responseFormatter.js";
import { parseRepoResourceUri } from "./repoResourceUri.js";
import { getRepoStaleness, runGitLines } from "../services/git/gitHelpers.js";
import { resolveDetectChangesPolicy, scoreChangeRisk } from "../services/analysis/policyResolver.js";

type ParsedRepoUri = NonNullable<ReturnType<typeof parseRepoResourceUri>>;

/** The four kinds, per repository, in the order `resources/list` has always emitted them. */
const KINDS: readonly { readonly kind: string; readonly description: string }[] = [
  { kind: "context", description: "Repository metadata, latest run, and staleness snapshot" },
  { kind: "schema", description: "Graph storage counts and language distribution" },
  { kind: "routes", description: "C# ASP.NET route map extracted from attributes" },
  { kind: "risk", description: "Compact deterministic detect_changes snapshot" }
];

function listRepoResources(store: GraphStore): ResourceDescriptor[] {
  return store.listRepositories().flatMap((repo) =>
    KINDS.map(({ kind, description }) => ({
      uri: `repo://${repo.repoId}/${kind}`,
      name: `${repo.repoId} ${kind}`,
      description,
      mimeType: "application/json"
    }))
  );
}

function readRepoResource(store: GraphStore, parsed: ParsedRepoUri, maxResultLimit: number): unknown {
  if (!store.getRepository(parsed.repoId)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `resources/read: unknown repoId '${parsed.repoId}'. Run index_repository first.`
    );
  }

  if (parsed.resource === "context") {
    return {
      repo: store.getRepository(parsed.repoId),
      latestRun: store.getLatestRun(parsed.repoId),
      staleness: getRepoStaleness(parsed.repoId, store)
    };
  }
  if (parsed.resource === "schema") {
    return store.getRepoSchemaSnapshot(parsed.repoId);
  }
  if (parsed.resource === "routes") {
    const routes = store.getRouteMap(parsed.repoId, null, null, Math.min(parsed.limit ?? 200, maxResultLimit));
    return { repoId: parsed.repoId, count: routes.length, routes };
  }
  return buildRiskSnapshot(store, parsed.repoId, "strict-review", Math.min(parsed.limit ?? 50, 100));
}

export function buildRepoResources(store: GraphStore, maxResultLimit: number): ResourceProvider {
  const family = createResource({
    name: "repo",
    mimeType: "application/json",
    // Two-space indent, as the hand-written handler emitted. MCP-ISSUE-049: normalize first, so a
    // resource reports paths in the same style the tools do — this is the only serialization point
    // in the server that did not run through the shared normalizer.
    serialize: (payload) => JSON.stringify(normalizeResourcePayload(payload), null, 2),
    list: () => listRepoResources(store),
    match: (uri) => parseRepoResourceUri(uri, maxResultLimit) ?? undefined,
    read: ({ params }) => readRepoResource(store, params, maxResultLimit)
  });

  return registerResource([family], {
    emptyOnCursor: true,
    onUnmatched: () => {
      throw new McpError(
        ErrorCode.InvalidParams,
        "resources/read: unsupported uri. Use repo://{repoId}/{context|schema|routes|risk}"
      );
    }
  });
}

function buildRiskSnapshot(
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
