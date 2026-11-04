/**
 * MCP-ISSUE-112 review follow-ups 1–2: the test environment for index jobs, in one place.
 *
 * - Importing this module sets CODEBASE_INDEX_MIN_FREE_RAM_MB=0 (unless the caller set it), so a server a harness spawns
 *   with `...process.env` starts index jobs whatever the machine's free RAM. Under the 8 GB production default, a CI
 *   runner or a loaded machine left every job `queued`, and `wait: true` answered "queued" after 100 s to a harness that
 *   then asserted on an empty index.
 * - `waitForIndexJob` polls a job to `ok` / `failed` with a deadline (INDEX_WAIT_DEADLINE_MS, default 10 min); past it, it
 *   throws with the job's state and `waitingFor`, never loops forever.
 */

process.env.CODEBASE_INDEX_MIN_FREE_RAM_MB ??= "0";

export const INDEX_WAIT_DEADLINE_MS = Number(process.env.INDEX_WAIT_DEADLINE_MS ?? 600_000);

/**
 * @param {(runId: string) => Promise<any>} status  answers index_status's parsed body for a runId
 * @param {any} first  the parsed answer of index_repository / register_worktree
 * @returns {Promise<any>} the job's final body (state ok or failed)
 */
export async function waitForIndexJob(status, first, { deadlineMs = INDEX_WAIT_DEADLINE_MS, intervalMs = 1000 } = {}) {
  let body = first;
  const end = Date.now() + deadlineMs;
  while (body && (body.state === "queued" || body.state === "running")) {
    if (Date.now() >= end) {
      throw new Error(`index job ${body.runId} still ${body.state} after ${deadlineMs} ms${body.waitingFor ? ` (${body.waitingFor})` : ""}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    body = await status(body.runId);
  }
  return body;
}

/** `status` for an MCP SDK client: calls index_status and parses its text. */
export function indexStatusVia(client) {
  return async (runId) => {
    const r = await client.callTool({ name: "index_status", arguments: { runId } });
    const text = Array.isArray(r?.content) ? (r.content.find((c) => c.type === "text")?.text ?? "") : "";
    return JSON.parse(text);
  };
}
