/**
 * The endpoint half of `get_cross_repo_impact` (R9, MCP-ISSUE-081).
 *
 * A cross-repo endpoint link is stored as (consumer symbol → provider endpoint contract symbol), and
 * says nothing about HOW the two matched or what the consumer is called in its own product. This
 * module recovers both: the consumer's endpoint token is re-matched against the provider's contract
 * id with the resolver's own matcher, and the route/tool names come from the consumer edge's reason.
 *
 * One lookup reads files: a declared route whose literal does not name its tool (wec.aria's
 * `get_my_vehicles_route`, bound to the tool `get_my_vehicles` in a routing table in ANOTHER file)
 * is looked up in the files that import it — a bounded scan for `<key>: <routeName>` — and the
 * answer is labelled `toolSource: "routing_table"` with the file and line it was read from.
 */

import fs from "node:fs";

import type { GraphStore } from "../../repositories/graphStore.js";
import { parseHttpConsumerReason } from "../../services/extractors/jsHttpConsumers.js";
import { HTTP_CONSUMER_REASON_PREFIX, matchEndpoint, type EndpointMatchKind } from "../../services/graph/endpointMatch.js";
import { assertSafeRepoFilePath } from "../../services/refactor/refactorUtils.js";

export type EndpointLinkDetail = {
  consumerEndpoint: string;
  providerEndpoint: string;
  matchKind: EndpointMatchKind | "unknown";
  strippedPrefix?: string;
  scheme?: string;
  route?: string;
  tool?: string;
  toolSource?: "declared" | "routing_table";
  toolDeclaredAt?: string;
  consumerReason?: string;
};

/** Routing-table files scanned per consumer, and the largest file read. */
const MAX_TABLE_FILES = 20;
const MAX_TABLE_FILE_BYTES = 512 * 1024;

export function describeEndpointLink(
  store: GraphStore,
  row: { fromRepoId: string; fromSymbolId: string; providerSignature: string; consumerName: string | null; consumerFilePath: string | null },
  tableCache: Map<string, { tool: string; at: string } | null>
): EndpointLinkDetail {
  const deps = store.getEndpointDependencies(row.fromRepoId, row.fromSymbolId);
  let chosen: { toId: string; reason: string | null } | undefined;
  let match: ReturnType<typeof matchEndpoint> = null;
  for (const dep of deps) {
    const declared = (dep.reason ?? "").startsWith(HTTP_CONSUMER_REASON_PREFIX);
    const m = matchEndpoint(dep.toId, row.providerSignature, declared);
    if (!m) continue;
    // Prefer the tightest tier when one consumer holds several matching tokens.
    const rank = { exact: 0, wildcard: 1, gateway_prefix: 2 } as const;
    if (!match || rank[m.kind] < rank[match.kind]) {
      match = m;
      chosen = dep;
    }
  }

  const detail: EndpointLinkDetail = {
    consumerEndpoint: chosen?.toId ?? "",
    providerEndpoint: row.providerSignature,
    matchKind: match?.kind ?? "unknown",
    ...(match?.strippedPrefix ? { strippedPrefix: match.strippedPrefix } : {}),
    ...(chosen?.reason ? { consumerReason: chosen.reason } : {})
  };
  const declared = parseHttpConsumerReason(chosen?.reason);
  if (declared) {
    detail.scheme = declared.scheme;
    if (declared.route) detail.route = declared.route;
    if (declared.tool) {
      detail.tool = declared.tool;
      detail.toolSource = "declared";
    } else if (row.consumerFilePath && (declared.route ?? row.consumerName)) {
      const routeName = (declared.route ?? row.consumerName) as string;
      const key = `${row.fromRepoId}\u0000${row.consumerFilePath}\u0000${routeName}`;
      if (!tableCache.has(key)) tableCache.set(key, findRoutingTableBinding(store, row.fromRepoId, row.consumerFilePath, routeName));
      const hit = tableCache.get(key);
      if (hit) {
        detail.tool = hit.tool;
        detail.toolSource = "routing_table";
        detail.toolDeclaredAt = hit.at;
      }
    }
  }
  return detail;
}

/**
 * `<key>: <routeName>` in a file that imports the route's file (or the file itself). Returns the
 * first hit in path order. Reads at most MAX_TABLE_FILES files from the repo root, each bounded.
 */
function findRoutingTableBinding(
  store: GraphStore,
  repoId: string,
  routeFilePath: string,
  routeName: string
): { tool: string; at: string } | null {
  const repo = store.getRepository(repoId);
  if (!repo || !/^[A-Za-z_$][\w$]*$/.test(routeName)) return null;
  const files = [...store.findImportingFiles(repoId, routeFilePath, MAX_TABLE_FILES), routeFilePath];
  const pattern = new RegExp(`(?:^|[\\s{,])(['"]?)([A-Za-z_$][\\w$-]*)\\1\\s*:\\s*${routeName.replace(/\$/g, "\\$")}\\b(?!\\s*[.(])`);
  for (const file of files) {
    try {
      const absolute = assertSafeRepoFilePath(repo.repoPath, file);
      const stat = fs.statSync(absolute);
      if (!stat.isFile() || stat.size > MAX_TABLE_FILE_BYTES) continue;
      const lines = fs.readFileSync(absolute, "utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (/^\s*(\/\/|\*)/.test(line)) continue;
        const hit = pattern.exec(line);
        if (hit?.[2]) return { tool: hit[2], at: `${file.replace(/\\/g, "/")}:${i + 1}` };
      }
    } catch {
      // Unreadable or outside the root: no binding from this file.
    }
  }
  return null;
}
