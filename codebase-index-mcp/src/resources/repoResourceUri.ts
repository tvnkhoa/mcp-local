/**
 * Parse a `repo://<repoId>/<resource>` URI into its parts.
 *
 * Split out of the former root-level `serverUtils.ts`. This half is resource
 * routing, so it lives beside the provider that calls it.
 */

export function parseRepoResourceUri(
  uri: string,
  maxResultLimit: number
): { repoId: string; resource: "context" | "schema" | "routes" | "risk"; limit?: number } | null {
  const match = uri.match(/^repo:\/\/([^/]+)\/(context|schema|routes|risk)(?:\?(.*))?$/i);
  if (!match) {
    return null;
  }

  const repoId = decodeURIComponent(match[1]);
  const resource = match[2].toLowerCase() as "context" | "schema" | "routes" | "risk";
  const query = match[3] ?? "";
  const params = new URLSearchParams(query);
  const rawLimit = params.get("limit");

  return {
    repoId,
    resource,
    limit: rawLimit ? clamp(Number(rawLimit), 1, maxResultLimit) : undefined
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
