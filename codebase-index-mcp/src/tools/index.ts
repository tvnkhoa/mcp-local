/**
 * codebase-index-mcp's tool table (S-32).
 *
 * S-32 grew this one batch at a time while `descriptors/` shrank by the same batch. Both the
 * descriptor barrel and `legacyDispatch.ts` are gone — S-33 removed the last of it.
 *
 * All 43 tools are here: read/metadata (8), search (9), graph/impact (12),
 * indexing/watch (4), refactor (10). This list IS the server's tool surface: a name absent
 * from it is an unknown tool, answered by dispatch's not-found path.
 */

import type { AnyToolDefinition } from "@mcp/sdk";
import { defineGuard, registerTool } from "@mcp/sdk";
import { err, notFound, ok } from "@mcp/core";

import { buildReadMetadataTools } from "./readMetadata.js";
import { buildRefactorTools } from "./refactor.js";
import { buildSearchTools } from "./search.js";
import { buildGraphImpactTools } from "./graphImpact.js";
import { buildIndexingWatchTools } from "./indexingWatch.js";
import type { CodebaseIndexDeps } from "./common.js";

export type { CodebaseIndexDeps } from "./common.js";

/**
 * `registerTool` flattens the five groups and rejects a duplicate name at the point
 * of assembly — with 43 tools across five files, two groups declaring the same name
 * is the mistake worth catching by construction.
 */
export function buildTools(deps: CodebaseIndexDeps): readonly AnyToolDefinition[] {
  return withRepoIdGuard(
    deps,
    registerTool([
      buildReadMetadataTools(deps),
      buildSearchTools(deps),
      buildGraphImpactTools(deps),
      buildIndexingWatchTools(deps),
      buildRefactorTools(deps)
    ])
  );
}

/**
 * Tools where an unknown `repoId` is a legitimate input rather than a mistake.
 *
 * `index_repository` is the tool that REGISTERS a repo, so its repoId cannot exist beforehand.
 * `health_check` is designed to answer for an unregistered repo — that is how an agent learns it
 * needs to index. `watch_repo` may start before the first run finishes.
 */
const REPO_ID_MAY_BE_UNKNOWN = new Set(["index_repository", "health_check", "watch_repo"]);

/**
 * MCP-ISSUE-060 — an unknown `repoId` is answered once, here, instead of by twenty handlers.
 *
 * Measured before this existed: `get_call_chain` with a bogus repoId returned `{"edges":[]}` with
 * `coverage.confidence:"high"`; `find_impact_files` reported `graphHealth.note:"graph data complete"`
 * and `medianConfidence: 1`; `query_graph` — the tool an agent reaches for to VERIFY the others —
 * returned a clean `{"rowCount":1,"rows":[{"c":0}]}`. Asserting confidence on a structurally
 * impossible question is worse than silence: silence invites another attempt, "high" ends the search.
 *
 * Seven handlers had grown their own copy of the check and roughly twenty had not, which is the drift
 * a per-handler convention always produces — the tools that skipped it are not the ones anyone chose
 * to skip. Attaching it here means a tool added later inherits it without anyone remembering to.
 *
 * A GUARD rather than a `wrapCall` hook, deliberately. Guards run after zod validation
 * (`dispatch.ts`: resolve → profile → validate → guards → handle), so a malformed request still
 * answers `VALIDATION_ERROR` rather than being pre-empted by a semantic complaint about one field.
 * An earlier attempt placed this in `wrapCall`, before validation, and `test:server-envelopes`
 * caught the inverted precedence.
 *
 * Applied only to tools that actually advertise `repoId`, and only when the caller supplied one:
 * several tools legitimately search across every indexed repo when it is omitted.
 */
function withRepoIdGuard(
  deps: CodebaseIndexDeps,
  tools: readonly AnyToolDefinition[]
): readonly AnyToolDefinition[] {
  const guard = defineGuard("repo_indexed", (context) => {
    const input = context.input as { repoId?: unknown };
    const repoId = input.repoId;
    if (typeof repoId !== "string" || repoId.length === 0) return ok(undefined);
    if (deps.buildContext().store.getRepository(repoId)) return ok(undefined);
    return err(
      notFound(
        `${context.toolName}: unknown repoId '${repoId}'. Run list_repositories to see the indexed repos, or index_repository first.`,
        { guard: "repo_indexed", repoId }
      )
    );
  });

  return tools.map((tool) => {
    if (REPO_ID_MAY_BE_UNKNOWN.has(tool.name)) return tool;
    const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    if (!("repoId" in props)) return tool;
    return { ...tool, guards: [...tool.guards, guard] };
  });
}
