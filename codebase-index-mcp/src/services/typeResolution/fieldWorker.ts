/**
 * R3 exact, release I1 — the worker thread that owns every TypeScript / Volar program.
 *
 * The whole field answer runs here: the union program, the Vue program, `findReferences`, the Zod
 * parse pass, the gap scans and the untyped-key scan (`findFieldReferences`). The server thread only
 * posts a {@link FieldWorkerRequest} and receives the serialisable {@link FieldAnswer}, so a cold
 * build (10-20 s on wec.aria) blocks this thread and never the server's event loop.
 *
 * The LanguageService LRU (`languageServiceHost.ts`) lives in this worker's heap, so the memory cap is
 * measured here — {@link setMemoryMeter} points the budget at this isolate's heap, and the client
 * spawns the worker with the same cap as `resourceLimits.maxOldGenerationSizeMb`.
 *
 * `fieldWorkerClient.ts` spawns this file with `new URL("./fieldWorker.js", import.meta.url)`, so the
 * two must stay in the same folder (as `extractionWorkerPool.ts` / `extractionWorker.ts` do).
 *
 * Protocol, per request: `started` (posted before the synchronous work, so the client can say how
 * long a cold build has been running) and then exactly one `answer` or `error`.
 */

import v8 from "node:v8";
import { parentPort } from "node:worker_threads";

import { setMemoryMeter, type TsLsCaps } from "./caps.js";
import { findFieldReferences, type FieldAnswer, type FieldPick } from "./fieldReferences.js";
import { getRepoLanguageService, type RepoProgramInput } from "./languageServiceHost.js";

export type FieldWorkerRequest = {
  id: number;
  program: RepoProgramInput;
  field: string;
  pick: FieldPick;
  caps: TsLsCaps;
};

export type FieldWorkerMessage =
  | { type: "started"; id: number; repoId: string; cold: boolean }
  | { type: "answer"; id: number; answer: FieldAnswer }
  | { type: "error"; id: number; error: string };

const MB = 1024 * 1024;

export function workerHeapMb(): number {
  const h = v8.getHeapStatistics();
  return Math.round((h.used_heap_size + h.external_memory + h.malloced_memory) / MB);
}

if (parentPort) {
  const port = parentPort;
  setMemoryMeter({ label: "type-resolution worker heap", readMb: workerHeapMb });
  port.on("message", (request: FieldWorkerRequest) => {
    try {
      const svc = getRepoLanguageService(request.program);
      port.postMessage({ type: "started", id: request.id, repoId: request.program.repoId, cold: !svc.isBuilt } satisfies FieldWorkerMessage);
      const answer = findFieldReferences(svc, request.field, request.pick, request.caps);
      answer.meta.workerHeapMb = workerHeapMb();
      port.postMessage({ type: "answer", id: request.id, answer } satisfies FieldWorkerMessage);
    } catch (error) {
      port.postMessage({ type: "error", id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies FieldWorkerMessage);
    }
  });
}
