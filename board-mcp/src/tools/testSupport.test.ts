/**
 * Shared test support (named *.test.ts so the build excludes it; it declares no tests itself).
 *
 * `stubRepo()` writes a fake `checks/board/board.mjs` into a temp directory. The stub echoes its
 * argv as one `ARGV <json>` line, so a test sees exactly what crossed execFile — and it acts out
 * each exit shape the wrapper has to classify, keyed off the arguments it is given.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createNullLogger } from "@mcp/core";
import { asErrorPayload, createToolRegistry, dispatchToolCall } from "@mcp/sdk";

import { boardRepoRootFromEnv, type BoardConfig } from "../config/index.js";
import { buildTools, toWireError } from "./index.js";

const STUB = `
const argv = process.argv.slice(2)
const has = (s) => argv.includes(s)
if (has('screen--refuse')) { console.error('board: screen--refuse is held by someone-else — release it there, or --force release as the owner'); process.exit(1) }
if (has('screen--crash')) { throw new Error('boom: not a refusal') }
if (has('screen--slow')) { setTimeout(() => {}, 60000) }
else if (argv[0] === 'check') { console.log('  ✗ a finding'); console.log('1 unit(s) read, 1 finding(s)'); process.exit(1) }
else if (argv[0] === 'next') { console.log(JSON.stringify({ queue: [{ id: 'horizontal--w01', state: 'LANDED' }] })) }
else { console.log('ARGV ' + JSON.stringify(argv)) }
`;

export function stubRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "board-mcp-stub-"));
  mkdirSync(path.join(root, "checks", "board", "units"), { recursive: true });
  writeFileSync(path.join(root, "checks", "board", "board.mjs"), STUB);
  writeFileSync(path.join(root, "checks", "board", "units", "screen--review-intent.json"), `${JSON.stringify({ id: "screen--review-intent", kind: "screen", phases: { P0: { state: "active" } } }, null, 2)}\n`);
  return root;
}

export const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e";

export function configFor(root: string, overrides: Partial<BoardConfig> = {}): BoardConfig {
  return { repoRoot: root, writeEnabled: true, callTimeoutMs: 20_000, ...overrides };
}

const logger = createNullLogger("test");

/** Dispatch a call exactly as `index.ts` wires it. */
export async function call(config: BoardConfig, name: string, args: Record<string, unknown>) {
  const registry = createToolRegistry(buildTools(config));
  const result = await dispatchToolCall(registry, name, args, {
    logger,
    formatError: (error) => asErrorPayload(toWireError(error), "verbose")
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { isError: result.isError === true, payload: JSON.parse(result.content[0]?.text ?? "null") as any };
}

/** The argv the stub received, from its `ARGV <json>` line. */
export function argvOf(text: string): string[] {
  const line = text.split("\n").find((l) => l.startsWith("ARGV "));
  if (line === undefined) throw new Error(`no ARGV line in ${JSON.stringify(text)}`);
  return JSON.parse(line.slice(5)) as string[];
}

export const DEFAULT_WEC_ARIA = "D:/1.SourceCode/crm/wec.aria";

/** A real board.mjs to read (never to write to): BOARD_REPO_ROOT, else the default wec.aria checkout. */
export function realBoardRoot(): string | null {
  for (const root of [boardRepoRootFromEnv(), DEFAULT_WEC_ARIA]) {
    if (root !== null && path.isAbsolute(root) && existsSync(path.join(root, "checks", "board", "board.mjs"))) return root;
  }
  return null;
}
