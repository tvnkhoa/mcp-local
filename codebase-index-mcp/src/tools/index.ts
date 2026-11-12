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
import { resolveSymbolRepoId } from "./handlers/searchHandler.js";

export type { CodebaseIndexDeps } from "./common.js";

/**
 * `registerTool` flattens the five groups and rejects a duplicate name at the point
 * of assembly — with 43 tools across five files, two groups declaring the same name
 * is the mistake worth catching by construction.
 */
export function buildTools(deps: CodebaseIndexDeps): readonly AnyToolDefinition[] {
  return withSymbolRepoResolution(
    deps,
    withFreshnessGate(
    deps,
    withRepoIdGuard(
    deps,
    registerTool([
      buildReadMetadataTools(deps),
      buildSearchTools(deps),
      buildGraphImpactTools(deps),
      buildIndexingWatchTools(deps),
      buildRefactorTools(deps)
    ])
    )
    )
  );
}

/** IX-C: tools whose `repoId` may be omitted when `symbolId` is given (resolved from the id). */
const REPO_ID_FROM_SYMBOL_ID = new Set(["get_symbol_source"]);

/**
 * IX-C — `get_symbol_source(symbolId)` without `repoId`. The id is resolved to the one repo holding it
 * (`resolveSymbolRepoId`: none → not found, several → ambiguity error) in the OUTERMOST handler wrapper,
 * so the freshness gate below sees the resolved repoId and refreshes that repo as for an explicit one.
 * The repo guard runs before any handler and leaves an absent repoId alone; the resolved one is
 * registered by construction (it comes from the repositories table).
 */
function withSymbolRepoResolution(deps: CodebaseIndexDeps, tools: readonly AnyToolDefinition[]): readonly AnyToolDefinition[] {
  return tools.map((tool) => {
    if (!REPO_ID_FROM_SYMBOL_ID.has(tool.name)) return tool;
    const inner = tool.handler;
    return {
      ...tool,
      handler: async (input: unknown, ctx: unknown) => {
        const i = input as { repoId?: unknown; symbolId?: unknown };
        const missing = typeof i.repoId !== "string" || i.repoId.length === 0;
        const resolved =
          missing && typeof i.symbolId === "string" && i.symbolId.length > 0
            ? { ...i, repoId: resolveSymbolRepoId(deps.buildContext().store, i.symbolId) }
            : input;
        return (inner as (i: unknown, c: unknown) => unknown)(resolved, ctx);
      }
    } as AnyToolDefinition;
  });
}

/**
 * R1 — read tools answer from a current index. Wraps the HANDLER (it runs after validation and the
 * repo guard, so an unknown repo or a malformed call never triggers a re-index) of every read-only
 * tool that takes a `repoId`; `index_repository`, `health_check` and `watch_repo` manage the index
 * themselves and are left alone. See `middleware/freshness.ts`.
 */
function withFreshnessGate(deps: CodebaseIndexDeps, tools: readonly AnyToolDefinition[]): readonly AnyToolDefinition[] {
  // IX-B: the query's `filePathPrefix` (one or several) narrows the gate's verdict to the paths it reads.
  const ensureFresh = deps.ensureFresh;
  if (!ensureFresh) return tools;
  return tools.map((tool) => {
    if (REPO_ID_MAY_BE_UNKNOWN.has(tool.name)) return tool;
    if (tool.annotations?.readOnly !== true) return tool;
    const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    if (!("repoId" in props)) return tool;
    const inner = tool.handler;
    return {
      ...tool,
      handler: async (input: unknown, ctx: unknown) => {
        const { repoId, filePathPrefix } = input as { repoId?: unknown; filePathPrefix?: unknown };
        if (typeof repoId === "string" && repoId.length > 0) {
          // Leader review (a): only a tool whose answer reads nothing outside the prefix may take a prefix-scoped verdict.
          const prefixes = PREFIX_SCOPED_TOOLS.has(tool.name) ? queryPrefixes(filePathPrefix) : undefined;
          await (prefixes ? ensureFresh(repoId, { filePathPrefixes: prefixes }) : ensureFresh(repoId));
        }
        return (inner as (i: unknown, c: unknown) => unknown)(input, ctx);
      }
    } as AnyToolDefinition;
  });
}

/**
 * IX-B: a validated `filePathPrefix` as the gate takes it — a string or an array of strings (search_regex). Absent, empty
 * or holding an empty prefix (the whole repo): undefined, so the gate answers for the whole repo.
 */
export function queryPrefixes(value: unknown): string[] | undefined {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  if (list.length === 0 || !list.every((p): p is string => typeof p === "string" && p.length > 0)) return undefined;
  return list;
}

/**
 * Tools where an unknown `repoId` is a legitimate input rather than a mistake.
 *
 * `index_repository` is the tool that REGISTERS a repo, so its repoId cannot exist beforehand.
 * `health_check` is designed to answer for an unregistered repo — that is how an agent learns it
 * needs to index. `watch_repo` may start before the first run finishes. `register_worktree` (MCP-ISSUE-114)
 * registers its repoId too. Keep in step with the same set in middleware/inputGuards.ts.
 */
/**
 * IX-B / leader review (a): the read tools whose answer depends ONLY on files under their `filePathPrefix`, so a gate
 * verdict scoped to that prefix is sound. Every other tool — dead_code_scan, detect_circular_dependencies,
 * find_entry_points, route_map, impact / call-chain / trace / context-pack — reads the whole graph: a change outside the
 * prefix (a new caller in src/x.ts) can alter its answer about lib/, so it always gets the whole-repo verdict.
 */
export const PREFIX_SCOPED_TOOLS: ReadonlySet<string> = new Set(["search_regex", "search_symbols", "search_literals", "query_docs"]);

const REPO_ID_MAY_BE_UNKNOWN = new Set(["index_repository", "health_check", "watch_repo", "register_worktree"]);

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
      // No tool-name prefix: `mapError` is the single place that adds it (see prefixOnce there).
      notFound(
        `unknown repoId '${repoId}'. Run list_repositories to see the indexed repos, or index_repository first.`,
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
