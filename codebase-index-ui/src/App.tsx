import { useEffect, useMemo, useState } from "react";
import ReactFlow, { Background, Controls, type Edge, type Node } from "reactflow";
import "reactflow/dist/style.css";

import { cancelIndex, getGraphView, getHealth, getImpact, getIndexProgress, startIndex } from "./api";
import type { IndexProgress, SymbolRecord } from "./types";

const defaultBaseUrl = "http://127.0.0.1:4310";
const STORAGE_KEY = "codebase-index-ui-state";

type PersistedState = {
  baseUrl: string;
  apiKey: string;
  repoId: string;
  repoPath: string;
  filePath: string;
  symbolId: string;
  view: "module-flow" | "dependency" | "call-chain";
  direction: "callers" | "callees";
  depth: number;
  indexMode: "full" | "incremental";
  maxFiles: number;
  batchSize: number;
  nodes: Node[];
  edges: Edge[];
};

function loadState(): Partial<PersistedState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveState(state: Partial<PersistedState>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore storage errors
  }
}

export function App() {
  const saved = useMemo(() => loadState(), []);

  const [view, setView] = useState<"module-flow" | "dependency" | "call-chain">(saved.view ?? "module-flow");
  const [baseUrl, setBaseUrl] = useState(saved.baseUrl ?? defaultBaseUrl);
  const [apiKey, setApiKey] = useState(saved.apiKey ?? "");
  const [repoId, setRepoId] = useState(saved.repoId ?? "smoke-test-repo");
  const [filePath, setFilePath] = useState(saved.filePath ?? "src/index.ts");
  const [symbolId, setSymbolId] = useState(saved.symbolId ?? "");
  const [direction, setDirection] = useState<"callers" | "callees">(saved.direction ?? "callees");
  const [depth, setDepth] = useState(saved.depth ?? 2);
  const [status, setStatus] = useState("Idle");
  const [isLoading, setIsLoading] = useState(false);
  const [repoPath, setRepoPath] = useState(saved.repoPath ?? "");
  const [indexMode, setIndexMode] = useState<"full" | "incremental">(saved.indexMode ?? "incremental");
  const [maxFiles, setMaxFiles] = useState(saved.maxFiles ?? 5000);
  const [batchSize, setBatchSize] = useState(saved.batchSize ?? 200);
  const [indexProgress, setIndexProgress] = useState<IndexProgress | null>(null);
  const [isIndexing, setIsIndexing] = useState(false);
  const [nodes, setNodes] = useState<Node[]>(saved.nodes ?? []);
  const [edges, setEdges] = useState<Edge[]>(saved.edges ?? []);
  const [impactSymbols, setImpactSymbols] = useState<Array<{ symbolId: string; name: string }>>([]);

  useEffect(() => {
    saveState({
      baseUrl,
      apiKey,
      repoId,
      repoPath,
      filePath,
      symbolId,
      view,
      direction,
      depth,
      indexMode,
      maxFiles,
      batchSize,
      nodes,
      edges
    });
  }, [baseUrl, apiKey, repoId, repoPath, filePath, symbolId, view, direction, depth, indexMode, maxFiles, batchSize, nodes, edges]);

  const auth = useMemo(() => ({ baseUrl, apiKey: apiKey.trim() || undefined }), [baseUrl, apiKey]);

  const onHealthCheck = async () => {
    setIsLoading(true);
    setStatus("Checking health...");
    try {
      const payload = await getHealth(auth);
      setStatus(`Health OK | DB: ${payload.dbPath}`);
    } catch (error) {
      setStatus(`Health failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setIsLoading(false);
    }
  };

  const onLoadGraph = async () => {
    setIsLoading(true);
    setStatus(`Loading ${view}...`);
    try {
      const payload = await getGraphView(auth, {
        repoId,
        view,
        filePath: view === "module-flow" ? filePath : undefined,
        symbolId: view !== "module-flow" ? symbolId : undefined,
        direction: view === "call-chain" ? direction : undefined,
        depth: view !== "module-flow" ? depth : undefined,
        limit: 200
      });

      const byId = new Map(payload.nodes.map((x) => [x.symbolId, x]));
      const ids = Array.from(new Set(payload.edges.flatMap((x) => [x.fromId, x.toId])));

      const nextNodes: Node[] = ids.map((id) => {
        const symbol = byId.get(id) as SymbolRecord | undefined;
        return {
          id,
          position: { x: 0, y: 0 },
          data: {
            label: symbol ? `${symbol.name} (${symbol.kind})` : id
          }
        };
      });

      const nextEdges: Edge[] = payload.edges.map((edge, index) => ({
        id: `${edge.fromId}-${edge.toId}-${edge.type}-${String(index)}`,
        source: edge.fromId,
        target: edge.toId,
        label: edge.type
      }));

      const arrangedNodes = arrangeNodes(nextNodes, nextEdges);
      setNodes(arrangedNodes);
      setEdges(nextEdges);
      setStatus(`Loaded ${view}: ${String(nextNodes.length)} nodes / ${String(nextEdges.length)} edges`);
    } catch (error) {
      setStatus(`Load failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setIsLoading(false);
    }
  };

  const onLoadImpact = async () => {
    setIsLoading(true);
    setStatus("Loading impact surface...");
    try {
      const payload = await getImpact(auth, repoId, filePath, 100);
      setImpactSymbols(payload.symbols);
      setStatus(`Loaded impact surface: ${String(payload.symbols.length)} symbols`);
    } catch (error) {
      setStatus(`Impact failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setIsLoading(false);
    }
  };

  const onStartIndex = async () => {
    if (!repoPath.trim()) {
      setStatus("Repo Path is required before indexing");
      return;
    }

    setIsLoading(true);
    setStatus("Starting index run...");
    setIsIndexing(true);

    // Connect WebSocket for real-time progress
    const wsUrl = `${baseUrl.replace(/^http/, "ws")}?repoId=${encodeURIComponent(repoId)}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setStatus("WebSocket connected, starting index...");
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "progress" && message.data) {
          const progress = message.data as IndexProgress;
          setIndexProgress(progress);

          if (progress.status === "ok" || progress.status === "failed" || progress.status === "cancelled") {
            setIsIndexing(false);
            setIsLoading(false);
            setStatus(
              progress.status === "cancelled"
                ? `Index cancelled: scanned ${String(progress.filesScanned)} files, indexed ${String(progress.filesIndexed)}`
                : progress.status === "ok"
                ? `Index done: scanned ${String(progress.filesScanned)} files, indexed ${String(progress.filesIndexed)}, failures ${String(progress.parseFailures)}`
                : `Index failed: ${progress.errorMessage || "Unknown error"}`
            );
            ws.close();
            // Auto-refresh graph after successful index
            if (progress.status === "ok") {
              setTimeout(() => onLoadGraph(), 500);
            }
          }
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.onerror = () => {
      setStatus("WebSocket error, falling back to polling...");
      ws.close();
      // Fallback to polling if WebSocket fails
      startPolling();
    };

    ws.onclose = () => {
      // Connection closed
    };

    function startPolling() {
      const poll = setInterval(async () => {
        try {
          const payload = await getIndexProgress(auth, repoId);
          setIndexProgress(payload.progress);
          
          if (payload.progress && (payload.progress.status === "ok" || payload.progress.status === "failed" || payload.progress.status === "cancelled")) {
            clearInterval(poll);
            setIsIndexing(false);
            setIsLoading(false);
            setStatus(
              payload.progress.status === "cancelled"
                ? `Index cancelled: scanned ${String(payload.progress.filesScanned)} files, indexed ${String(payload.progress.filesIndexed)}`
                : payload.progress.status === "ok"
                ? `Index done: scanned ${String(payload.progress.filesScanned)} files, indexed ${String(payload.progress.filesIndexed)}, failures ${String(payload.progress.parseFailures)}`
                : `Index failed: ${payload.progress.errorMessage || "Unknown error"}`
            );
          }
        } catch {
          // keep polling quietly while run is active
        }
      }, 500);

      return poll;
    }

    startIndex(auth, {
      repoId,
      repoPath: repoPath.trim(),
      mode: indexMode,
      maxFiles,
      batchSize
    }).catch((error) => {
      ws.close();
      setIsIndexing(false);
      setIsLoading(false);
      setStatus(`Index failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    });
  };

  const onCancelIndex = async () => {
    setStatus("Sending cancel request...");
    try {
      await cancelIndex(auth, repoId);
      setStatus("Cancel request sent. Waiting current batch to stop...");
    } catch (error) {
      setStatus(`Cancel failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  };

  const onPickImpactSymbol = (pickedSymbolId: string) => {
    setSymbolId(pickedSymbolId);
    setView("dependency");
    setStatus(`Selected symbol ${pickedSymbolId} for dependency view`);
  };

  return (
    <div className="app">
      <header>
        <h1>Codebase Index UI (v1)</h1>
        <p>Local graph visualization for module flow, dependency, call-chain, and impact surface.</p>
      </header>

      <section className="controls">
        <label>
          API Base URL
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        <label>
          API Key (optional)
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </label>
        <label>
          Repo ID
          <input value={repoId} onChange={(e) => setRepoId(e.target.value)} />
        </label>
        <label>
          Repo Path (for indexing)
          <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="d:/path/to/repo" />
        </label>
        <label>
          Index Mode
          <select value={indexMode} onChange={(e) => setIndexMode(e.target.value as "full" | "incremental")}>
            <option value="incremental">incremental</option>
            <option value="full">full</option>
          </select>
        </label>
        <label>
          Max Files
          <input type="number" min={1} max={20000} value={maxFiles} onChange={(e) => setMaxFiles(Number(e.target.value) || 1)} />
        </label>
        <label>
          Batch Size
          <input type="number" min={1} max={2000} value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value) || 1)} />
        </label>
        <label>
          File Path
          <input value={filePath} onChange={(e) => setFilePath(e.target.value)} />
        </label>
        <label>
          View
          <select value={view} onChange={(e) => setView(e.target.value as "module-flow" | "dependency" | "call-chain")}>
            <option value="module-flow">module-flow</option>
            <option value="dependency">dependency</option>
            <option value="call-chain">call-chain</option>
          </select>
        </label>
        <label>
          Symbol ID (for dependency/call-chain)
          <input value={symbolId} onChange={(e) => setSymbolId(e.target.value)} />
        </label>
        <label>
          Direction (call-chain)
          <select value={direction} onChange={(e) => setDirection(e.target.value as "callers" | "callees")}>
            <option value="callees">callees</option>
            <option value="callers">callers</option>
          </select>
        </label>
        <label>
          Depth
          <input type="number" min={1} max={5} value={depth} onChange={(e) => setDepth(Number(e.target.value) || 1)} />
        </label>
        <div className="actions">
          <button onClick={onHealthCheck} disabled={isLoading}>Health</button>
          <button onClick={onStartIndex} disabled={isLoading}>Start index</button>
          <button onClick={onCancelIndex} disabled={!isIndexing}>Cancel index</button>
          <button onClick={onLoadGraph} disabled={isLoading}>Load graph</button>
          <button onClick={onLoadImpact} disabled={isLoading}>Load impact</button>
        </div>
        <div className="progressPanel">
          <div className="progressHeader">
            <span>Index progress</span>
            <span>
              {indexProgress ? `${String(indexProgress.filesScanned)}/${String(indexProgress.totalFiles)} files` : "No active run"}
            </span>
          </div>
          <div className="progressTrack">
            <div
              className="progressFill"
              style={{
                width: `${String(
                  Math.max(
                    0,
                    Math.min(
                      100,
                      indexProgress && indexProgress.totalFiles > 0
                        ? Math.round((indexProgress.filesScanned / indexProgress.totalFiles) * 100)
                        : 0
                    )
                  )
                )}%`
              }}
            />
          </div>
          {indexProgress ? (
            <>
              <p className="progressMeta">
                {indexProgress.status.toUpperCase()} • batch {String(indexProgress.completedBatches)}/{String(indexProgress.totalBatches)} • indexed {String(indexProgress.filesIndexed)} • skipped {String(indexProgress.filesSkipped)} • parseFailures {String(indexProgress.parseFailures)}
                {indexProgress.etaSeconds !== undefined && indexProgress.status === "running" ? (
                  <> • ETA: {formatETA(indexProgress.etaSeconds)}</>
                ) : null}
              </p>
              {indexProgress.byLanguage && Object.keys(indexProgress.byLanguage).length > 0 ? (
                <div className="languageBreakdown">
                  {Object.entries(indexProgress.byLanguage)
                    .sort((a, b) => b[1].scanned - a[1].scanned)
                    .slice(0, 5)
                    .map(([lang, stats]) => (
                      <span key={lang} className="langStat">
                        {lang}: {String(stats.indexed)}/{String(stats.scanned)}
                      </span>
                    ))}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
        <p className="status">{status}</p>
      </section>

      <section className="canvas">
        <ReactFlow nodes={nodes} edges={edges} fitView>
          <Background />
          <Controls />
        </ReactFlow>
      </section>

      <section className="impact">
        <h3>Impact Surface ({String(impactSymbols.length)})</h3>
        <ul>
          {impactSymbols.map((symbol) => (
            <li key={symbol.symbolId}>
              <button className="linkButton" onClick={() => onPickImpactSymbol(symbol.symbolId)}>
                Use
              </button>{" "}
              <code>{symbol.symbolId}</code> — {symbol.name}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function formatETA(seconds: number): string {
  if (seconds < 60) {
    return `${String(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${String(minutes)}m ${String(remainingSeconds)}s`;
}

function arrangeNodes(nodes: Node[], edges: Edge[]): Node[] {
  if (nodes.length === 0) {
    return nodes;
  }

  const incomingCount = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) {
    incomingCount.set(node.id, 0);
    outgoing.set(node.id, []);
  }

  for (const edge of edges) {
    if (incomingCount.has(edge.target)) {
      incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
    }
    if (outgoing.has(edge.source)) {
      outgoing.get(edge.source)?.push(edge.target);
    }
  }

  const roots = nodes.map((x) => x.id).filter((id) => (incomingCount.get(id) ?? 0) === 0);
  const queue = roots.length > 0 ? [...roots] : [nodes[0].id];
  const levelById = new Map<string, number>();

  for (const id of queue) {
    levelById.set(id, 0);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const baseLevel = levelById.get(current) ?? 0;
    const next = outgoing.get(current) ?? [];
    for (const to of next) {
      const existing = levelById.get(to);
      const candidate = baseLevel + 1;
      if (existing === undefined || candidate < existing) {
        levelById.set(to, candidate);
        queue.push(to);
      }
    }
  }

  const rows = new Map<number, string[]>();
  for (const node of nodes) {
    const level = levelById.get(node.id) ?? 0;
    const list = rows.get(level) ?? [];
    list.push(node.id);
    rows.set(level, list);
  }

  const indexById = new Map<string, { row: number; col: number }>();
  for (const [row, ids] of rows.entries()) {
    ids.forEach((id, col) => indexById.set(id, { row, col }));
  }

  return nodes.map((node) => {
    const slot = indexById.get(node.id) ?? { row: 0, col: 0 };
    return {
      ...node,
      position: {
        x: slot.col * 290,
        y: slot.row * 140
      }
    };
  });
}
