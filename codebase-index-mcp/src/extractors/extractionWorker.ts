import { parentPort } from "node:worker_threads";

import {
  extractGraphData,
  isParseTimeoutError,
  type ExtractInput,
  type ExtractOutput
} from "./treeSitterExtractor.js";

type WorkerExtractRequest = {
  id: string;
  input: ExtractInput;
};

type WorkerExtractResponse =
  | { id: string; status: "ok"; output: ExtractOutput; parseMs: number }
  | { id: string; status: "timeout"; reason: "parse-timeout"; error: string }
  | { id: string; status: "error"; error: string };

if (!parentPort) {
  throw new Error("extractionWorker must run in worker_threads");
}

parentPort.on("message", (message: WorkerExtractRequest) => {
  try {
    const parseStart = Date.now();
    const output = extractGraphData(message.input);
    const parseMs = Date.now() - parseStart;
    const response: WorkerExtractResponse = {
      id: message.id,
      status: "ok",
      output,
      parseMs
    };
    parentPort!.postMessage(response);
  } catch (error) {
    if (isParseTimeoutError(error)) {
      const response: WorkerExtractResponse = {
        id: message.id,
        status: "timeout",
        reason: "parse-timeout",
        error: error.message
      };
      parentPort!.postMessage(response);
      return;
    }

    const response: WorkerExtractResponse = {
      id: message.id,
      status: "error",
      error: error instanceof Error ? error.message : String(error)
    };
    parentPort!.postMessage(response);
  }
});
