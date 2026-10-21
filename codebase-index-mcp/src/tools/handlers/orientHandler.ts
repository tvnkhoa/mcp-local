import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveResponseProfile } from "../../middleware/responseFormatter.js";
import { classifyIntent } from "../../services/analysis/orient.js";
import { findCitations } from "../../services/docs/annotationScanner.js";
import { loadCitationConfig } from "../../services/docs/citationConfig.js";
import type { HandlerContext } from "./handlerContext.js";

// ── orient (ENH-F) ──────────────────────────────────────────────────────────────
// Deterministic intent router (NO LLM — see src/orient.ts). Classifies a free-text task
// and returns the recommended MCP tool(s), caveats, and resolved seed symbols so the agent
// starts on the right tool instead of defaulting to Grep/Read.

export function handleOrient(
  args: { repoId?: string; intent: string; seed?: string; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);

  const { matches, fallback } = classifyIntent(args.intent);

  // Merge recommendations across matched rules, de-duplicated by tool name (first wins).
  const toolSeen = new Set<string>();
  const recommendedTools: { tool: string; why: string; args?: Record<string, unknown> }[] = [];
  for (const rule of matches) {
    for (const t of rule.recommendedTools) {
      if (toolSeen.has(t.tool)) continue;
      toolSeen.add(t.tool);
      // A copy: the target rewrite below must not edit the shared rule table.
      recommendedTools.push({ ...t, ...(t.args && { args: { ...t.args } }) });
    }
  }
  const caveats = [...new Set(matches.flatMap((r) => r.caveats))];

  // A citation target in the repo's own shorthand (release I2 follow-up): "decision #737" matches no
  // wec.aria pattern, "15 #737" does. Rewritten only when the repo's citations.json says so.
  if (args.repoId) {
    for (const t of recommendedTools) {
      const target = t.args?.["target"];
      if (t.tool !== "query_docs" || t.args?.["mode"] !== "cites" || typeof target !== "string") continue;
      const repoPath = store.getRepository(args.repoId)?.repoPath;
      const rewritten = repoPath ? citationShorthand(repoPath, target, args.intent) : null;
      if (rewritten && rewritten !== target) {
        t.args = { ...t.args, target: rewritten };
        caveats.push(`target '${target}' rewritten to the repo's own shorthand '${rewritten}' (from its citations.json).`);
      }
    }
  }

  // Resolve the seed to concrete symbols when a repo is given.
  let seedSymbols: { symbolId: string; name: string; kind: string; filePath: string; score: number }[] = [];
  if (args.seed && args.repoId) {
    seedSymbols = store
      .getSymbolCandidates(args.repoId, args.seed, 5, "intent")
      .map((c) => ({ symbolId: c.symbolId, name: c.name, kind: c.kind, filePath: c.filePath, score: c.score }));
    if (seedSymbols.length === 0) {
      caveats.push(`seed '${args.seed}' did not resolve to an indexed symbol — verify the name or re-index.`);
    }
  } else if (args.seed && !args.repoId) {
    caveats.push("seed provided without repoId — pass repoId to resolve seedSymbols.");
  }

  const classifiedAs = fallback ? ["fallback"] : matches.map((r) => r.id);

  if (profile === "nano") {
    return ctx.asText(
      {
        intent: args.intent,
        classifiedAs,
        recommendedTools: recommendedTools.map((t) => t.tool),
        seedSymbolCount: seedSymbols.length,
        fallback
      },
      profile
    );
  }

  return ctx.asText(
    {
      intent: args.intent,
      classifiedAs,
      recommendedTools,
      seedSymbols,
      caveats,
      fallback
    },
    profile
  );
}

/**
 * The target as the repo writes it: unchanged when one of its citation patterns already matches;
 * otherwise, for a bare `#N`, each pattern is tried with the leading number of its target file
 * (`docs/15-decision-log.md` → `15 #N`). A pattern whose id or target shares a word with the intent
 * wins ("decision #737" → decision-row, "open question #12" → open-question); with no such word, a
 * rewrite is made only when exactly one pattern accepts it — never a guess between two. Null when the
 * repo has no config or nothing fits.
 */
function citationShorthand(repoPath: string, target: string, intent: string): string | null {
  const config = loadCitationConfig(repoPath).config;
  if (!config) return null;
  if (findCitations([{ line: 0, text: target }], config.citations).length > 0) return target;
  const num = /#(\d+[a-z]?)\b/i.exec(target)?.[1];
  if (!num) return null;
  const ignored = new Set(["cite", "cites", "cited", "citations", "references", "what", "which", "does", "trich"]);
  const words = `${target} ${intent}`.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4 && !ignored.has(w));
  const accepted: { candidate: string; related: boolean }[] = [];
  for (const c of config.citations) {
    const prefix = /(?:^|\/)(\d+)[^/]*$/.exec(c.target)?.[1];
    if (!prefix) continue;
    const candidate = `${prefix} #${num}`;
    if (findCitations([{ line: 0, text: candidate }], [c]).length === 0) continue;
    const haystack = `${c.id} ${c.target}`.toLowerCase();
    accepted.push({ candidate, related: words.some((w) => haystack.includes(w) || haystack.includes(w.replace(/s$/, ""))) });
  }
  const related = accepted.filter((a) => a.related);
  if (related.length > 0) return related[0]!.candidate;
  return accepted.length === 1 ? accepted[0]!.candidate : null;
}
