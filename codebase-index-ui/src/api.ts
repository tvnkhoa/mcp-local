import type {
  GraphViewResponse,
  HealthResponse,
  ImpactResponse,
  IndexProgressResponse,
  IndexRunResponse,
  ModuleFlowResponse,
  NodeResolveResponse
} from "./types";

type RequestOptions = {
  baseUrl: string;
  apiKey?: string;
};

function headers(apiKey?: string): Record<string, string> {
  return apiKey ? { "x-api-key": apiKey } : {};
}

export async function getHealth({ baseUrl, apiKey }: RequestOptions): Promise<HealthResponse> {
  const response = await fetch(`${baseUrl}/health`, { headers: headers(apiKey) });
  if (!response.ok) {
    throw new Error(`Health request failed: ${response.status}`);
  }
  return (await response.json()) as HealthResponse;
}

export async function getModuleFlow(
  { baseUrl, apiKey }: RequestOptions,
  repoId: string,
  filePath: string,
  limit = 100
): Promise<ModuleFlowResponse> {
  const query = new URLSearchParams({ repoId, filePath, limit: String(limit) });
  const response = await fetch(`${baseUrl}/graph/module-flow?${query.toString()}`, {
    headers: headers(apiKey)
  });
  if (!response.ok) {
    throw new Error(`Module flow request failed: ${response.status}`);
  }
  return (await response.json()) as ModuleFlowResponse;
}

export async function resolveNodes(
  { baseUrl, apiKey }: RequestOptions,
  repoId: string,
  symbolIds: string[]
): Promise<NodeResolveResponse> {
  const response = await fetch(`${baseUrl}/graph/resolve-nodes`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers(apiKey)
    },
    body: JSON.stringify({ repoId, symbolIds })
  });

  if (!response.ok) {
    throw new Error(`Resolve nodes request failed: ${response.status}`);
  }

  return (await response.json()) as NodeResolveResponse;
}

export async function getGraphView(
  { baseUrl, apiKey }: RequestOptions,
  params: {
    repoId: string;
    view: "module-flow" | "dependency" | "call-chain";
    filePath?: string;
    symbolId?: string;
    direction?: "callers" | "callees";
    depth?: number;
    limit?: number;
  }
): Promise<GraphViewResponse> {
  const query = new URLSearchParams({
    repoId: params.repoId,
    view: params.view,
    limit: String(params.limit ?? 200)
  });

  if (params.filePath) {
    query.set("filePath", params.filePath);
  }
  if (params.symbolId) {
    query.set("symbolId", params.symbolId);
  }
  if (params.direction) {
    query.set("direction", params.direction);
  }
  if (typeof params.depth === "number") {
    query.set("depth", String(params.depth));
  }

  const response = await fetch(`${baseUrl}/graph/view?${query.toString()}`, {
    headers: headers(apiKey)
  });

  if (!response.ok) {
    throw new Error(`Graph view request failed: ${response.status}`);
  }

  return (await response.json()) as GraphViewResponse;
}

export async function getImpact(
  { baseUrl, apiKey }: RequestOptions,
  repoId: string,
  filePath: string,
  limit = 100
): Promise<ImpactResponse> {
  const query = new URLSearchParams({ repoId, filePath, limit: String(limit) });
  const response = await fetch(`${baseUrl}/graph/impact?${query.toString()}`, {
    headers: headers(apiKey)
  });
  if (!response.ok) {
    throw new Error(`Impact request failed: ${response.status}`);
  }
  return (await response.json()) as ImpactResponse;
}

export async function startIndex(
  { baseUrl, apiKey }: RequestOptions,
  params: {
    repoId: string;
    repoPath: string;
    mode: "full" | "incremental";
    maxFiles: number;
    batchSize: number;
  }
): Promise<IndexRunResponse> {
  const response = await fetch(`${baseUrl}/index`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers(apiKey)
    },
    body: JSON.stringify(params)
  });

  if (!response.ok) {
    throw new Error(`Index request failed: ${response.status}`);
  }

  return (await response.json()) as IndexRunResponse;
}

export async function getIndexProgress(
  { baseUrl, apiKey }: RequestOptions,
  repoId: string
): Promise<IndexProgressResponse> {
  const query = new URLSearchParams({ repoId });
  const response = await fetch(`${baseUrl}/index/progress?${query.toString()}`, {
    headers: headers(apiKey)
  });

  if (!response.ok) {
    throw new Error(`Index progress request failed: ${response.status}`);
  }

  return (await response.json()) as IndexProgressResponse;
}

export async function cancelIndex(
  { baseUrl, apiKey }: RequestOptions,
  repoId: string
): Promise<{ status: string; repoId: string }> {
  const response = await fetch(`${baseUrl}/index/cancel`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers(apiKey)
    },
    body: JSON.stringify({ repoId })
  });

  if (!response.ok) {
    throw new Error(`Cancel index request failed: ${response.status}`);
  }

  return (await response.json()) as { status: string; repoId: string };
}
