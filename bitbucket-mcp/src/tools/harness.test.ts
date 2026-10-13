/**
 * Shared test harness: a config, a client whose every method rejects, a
 * recording client, and dispatch through the same error wiring as index.ts.
 * Named *.test.ts so the build excludes it; it declares no tests of its own.
 */

import { createNullLogger } from "@mcp/core";
import { asErrorPayload, createToolRegistry, dispatchToolCall } from "@mcp/sdk";

import type { BitbucketClient } from "../services/bitbucketClient.js";
import type { BitbucketConfig } from "../config/index.js";
import { buildTools, toWireError } from "./index.js";

const logger = createNullLogger("test");

export const CONFIG: BitbucketConfig = {
  baseUrl: "https://contract-snapshot.invalid",
  workspace: "snapshot-ws",
  defaultRepo: null,
  authHeader: "Bearer dummy",
  writeEnabled: false,
  mergeEnabled: false,
  commitEnabled: false,
  branchEnabled: false,
  commitBranches: [],
  commitSharedBranches: [],
  timeoutMs: 1000,
  maxRetries: 0,
  defaultPagelen: 25,
  maxPagelen: 100
} as unknown as BitbucketConfig;

/** Every client method a tool may call. A new client method must be added here. */
export const CLIENT_METHODS = [
  "getRepository", "listRepositories", "listBranches", "getBranch", "getTag",
  "listPullRequests", "getPullRequest", "getPullRequestDiff", "createPullRequest",
  "listPullRequestComments", "addPullRequestComment", "mergePullRequest",
  "listCommits", "getCommit", "getDiffstat", "getMergeBase", "getDiffBounded", "listCommitStatuses",
  "getSrcMeta", "listSrcDir", "getSrcBounded", "listFileHistory", "searchCode", "createCommit", "createBranch", "deleteBranch",
  "listPipelines", "getPipeline", "listPipelineSteps", "getPipelineStepLog"
] as const;

const reject = async (): Promise<never> => {
  throw new Error("network not available in tests");
};

/** Every method rejects: no test here should reach the network. */
export const STUB_CLIENT = {
  ...Object.fromEntries(CLIENT_METHODS.map((m) => [m, reject])),
  createPullRequestPath: (repoSlug: string) => `/repositories/snapshot-ws/${repoSlug}/pullrequests`,
  pullRequestCommentsPath: (repoSlug: string, id: number) =>
    `/repositories/snapshot-ws/${repoSlug}/pullrequests/${String(id)}/comments`,
  mergePullRequestPath: (repoSlug: string, id: number) =>
    `/repositories/snapshot-ws/${repoSlug}/pullrequests/${String(id)}/merge`,
  branchesPath: (repoSlug: string) => `/repositories/snapshot-ws/${repoSlug}/refs/branches`
} as unknown as BitbucketClient;

export type Call = { method: string; args: unknown[] };

/**
 * A client that records calls and answers from `answers`: a value, or a
 * function of the call's arguments (for answers that depend on the page asked).
 */
export function recording(answers: Record<string, unknown>): { client: BitbucketClient; calls: Call[] } {
  const calls: Call[] = [];
  const overrides = Object.fromEntries(
    Object.entries(answers).map(([method, answer]) => [
      method,
      async (...args: unknown[]) => {
        calls.push({ method, args });
        const value = typeof answer === "function" ? (answer as (...a: unknown[]) => unknown)(...args) : answer;
        if (value instanceof Error) {
          throw value;
        }
        return value;
      }
    ])
  );
  return { client: { ...STUB_CLIENT, ...overrides } as unknown as BitbucketClient, calls };
}

export function call(
  name: string,
  args: Record<string, unknown>,
  config: BitbucketConfig = CONFIG,
  client: BitbucketClient = STUB_CLIENT
): Promise<{ isError?: boolean; content: readonly { text: string }[] }> {
  const registry = createToolRegistry(buildTools(config, client));
  return dispatchToolCall(registry, name, args, {
    logger,
    // Identical to the wiring in index.ts — the envelope is what is under test.
    formatError: (error) => asErrorPayload(toWireError(error), "verbose")
  });
}

/** `payload` is the parsed JSON, untyped as in the original suite: assertions narrow it. */
export async function bodyOf(
  name: string,
  args: Record<string, unknown>,
  config?: BitbucketConfig,
  client?: BitbucketClient
) {
  const result = await call(name, args, config, client);
  return { isError: result.isError, payload: JSON.parse(result.content[0]?.text ?? "null") };
}
