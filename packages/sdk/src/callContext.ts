/**
 * Per-call context for the `wrapCall` hook.
 *
 * The dispatch pipeline is deliberately protocol-free, which means it cannot see
 * the two things a request carries beyond its arguments: the host's progress
 * token, and the channel to send notifications back on. A server that needs
 * either — or that needs to run something *around* every call rather than inside
 * one tool — gets it here.
 *
 * `reportProgress` is handed over already bound rather than exposing the raw
 * notification sender, because the wire shape (`notifications/progress`, the
 * token echo, the monotonic `progress` requirement) is exactly the protocol
 * detail this package exists to keep out of servers.
 */

import type { ToolCallResult } from "./responses.js";

export interface CallContext {
  readonly toolName: string;
  /** Raw arguments, before validation — a wrapper runs before the tool resolves. */
  readonly args: Record<string, unknown>;
  /**
   * Present only when the host asked for progress. Absent means nobody is
   * listening, which is worth branching on: building a progress sink that goes
   * nowhere is waste, and a server may want to skip the work entirely.
   */
  readonly progressToken?: string | number;
  /**
   * The protocol session the call arrived on — set on the http transport only, where one process
   * serves many clients. State a client must not see another client's (a refactor preview it may
   * apply, say) is keyed by this. Absent on stdio, where the process has exactly one client.
   */
  readonly clientSessionId?: string;
  /**
   * MCP-ISSUE-108: the client *process* the call came from — its pid and start time (plus, over http, the
   * bearer) — which, unlike {@link clientSessionId}, survives a server restart: a client that silently
   * re-initializes after one gets a new session id but keeps its identity. On stdio it names the server's
   * parent process. Resolves to undefined when it cannot be resolved; key on {@link clientSessionId} then
   * (fail closed).
   *
   * A function, not a value: the lookup starts at initialize but can take seconds (netstat, then PowerShell),
   * so only a call that needs ownership awaits it; every other call goes ahead without waiting.
   */
  readonly resolveClientIdentity?: () => Promise<string | undefined>;
  /**
   * Fire-and-forget progress update. A no-op when {@link progressToken} is
   * absent, and never throws — progress must not be able to fail a tool call.
   */
  readonly reportProgress: (progress: number, total: number | undefined, message: string) => void;
}

/**
 * Runs around every `tools/call`. Must call `next()` to dispatch, and must
 * return what `next()` returns unless it is deliberately substituting a result.
 *
 * This exists because two needs turn out to be the same need — a scope that
 * spans the whole call:
 *
 *   - **Ambient per-request state.** A server threading request context through
 *     `AsyncLocalStorage` establishes the scope here, so code far below the
 *     handler (a batch indexer, a telemetry emitter at serialization time) can
 *     reach it without every function signature growing a parameter.
 *   - **Work before or after dispatch.** Guards are per-tool by design; a policy
 *     that applies to every call regardless of which tool it is has no other
 *     place to live.
 *
 * A wrapper that throws is caught and reported as a fatal tool result rather
 * than escaping as a protocol error — the same contract dispatch itself keeps.
 */
export type CallWrapper = (
  context: CallContext,
  next: () => Promise<ToolCallResult>
) => Promise<ToolCallResult>;
