import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { resolveResponseProfile } from "../responseFormatter.js";
import { readSymbolSourceSpan } from "../refactorUtils.js";
import { buildIndexMeta } from "./impactHandler.js";
import {
  CONVENTIONS,
  entityNameFromSeed,
  expandPatterns,
  pluralize,
  type ConventionName,
  type ConventionRole
} from "../conventions.js";
import type { HandlerContext } from "./handlerContext.js";

// Type-like kinds a slice member can be (records included for post-ISSUE-015 labeling).
const BUNDLE_TYPE_KINDS = new Set(["class", "struct", "record", "record struct", "interface"]);
// Marker interfaces a minimal-API endpoint group implements (CH uses IEndpointGroup).
const ENDPOINT_MARKER_INTERFACES = ["IEndpointGroup", "IEndpointGroupBase"];
// Suffixes that mark a Commands-folder type as a DTO/projection, not the command request itself.
const NON_COMMAND_SUFFIXES = ["dto", "response", "result", "vm", "viewmodel", "model"];

// ── get_feature_bundle (ENH-B) ──────────────────────────────────────────────────
// "Implement EmailSignature by mirroring the ConversationNote slice" is the most common
// feature task. Instead of the agent reading entity + EF config + commands + queries +
// endpoints separately, this walks the naming convention from a single seed and returns
// the related set (with source) in one call.

type BundleMember = {
  role: ConventionRole;
  symbolId: string;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  source?: string;
  truncated?: boolean;
  endLineEstimated?: boolean;
};

export function handleGetFeatureBundle(
  args: {
    repoId: string;
    seedSymbol?: string;
    seedFile?: string;
    convention: ConventionName;
    maxFiles: number;
    maxBytesPerFile: number;
    includeSource: boolean;
    profile: string;
  },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  const convention = CONVENTIONS[args.convention];

  const repo = store.getRepository(args.repoId);
  if (!repo) {
    throw new McpError(ErrorCode.InvalidParams, `get_feature_bundle: unknown repoId '${args.repoId}'. Run index_repository first.`);
  }

  // 1. Resolve the entity name from the seed.
  let entity: string | null = null;
  if (args.seedSymbol) {
    const cand = store.getSymbolCandidates(args.repoId, args.seedSymbol, 5)[0];
    entity = entityNameFromSeed(cand?.name ?? args.seedSymbol, convention);
  } else if (args.seedFile) {
    const summary = store.getFileSummary(args.repoId, args.seedFile);
    const dominant =
      summary.exports.find((s) => BUNDLE_TYPE_KINDS.has(s.kind)) ??
      summary.exports[0];
    if (dominant) entity = entityNameFromSeed(dominant.name, convention);
  }
  if (!entity) {
    throw new McpError(ErrorCode.InvalidParams, "get_feature_bundle: could not resolve an entity name. Provide seedSymbol (e.g. 'ConversationNote') or seedFile.");
  }

  // 2. Resolve each role's name patterns to indexed symbols (exact name match preferred).
  const seen = new Set<string>();
  const members: BundleMember[] = [];
  const rolesMatched = new Set<ConventionRole>();
  let sourceIncluded = 0;

  type Candidate = { symbolId: string; name: string; kind: string; filePath: string; line: number };
  const addMember = (role: ConventionRole, c: Candidate): boolean => {
    if (seen.has(c.symbolId)) return false;
    seen.add(c.symbolId);
    rolesMatched.add(role);

    const member: BundleMember = {
      role,
      symbolId: c.symbolId,
      name: c.name,
      kind: c.kind,
      filePath: c.filePath,
      line: c.line
    };

    if (args.includeSource && members.length < args.maxFiles) {
      const detail = store.getSymbolDetail(args.repoId, c.symbolId, 1).symbol;
      const endLine = detail?.endLine ?? null;
      const fallbackNextStartLine = endLine && endLine >= c.line ? null : store.getNextSymbolStartLine(args.repoId, c.filePath, c.line);
      const span = readSymbolSourceSpan(repo.repoPath, c.filePath, c.line, endLine, {
        contextLines: 0,
        maxLines: 4000,
        fallbackNextStartLine
      });
      if (span) {
        let src = span.source;
        if (Buffer.byteLength(src, "utf8") > args.maxBytesPerFile) {
          // Truncate by BYTES (not UTF-16 code units) so the cap is honored for multibyte
          // source; toString may drop a trailing partial char, which is fine for a preview.
          src = Buffer.from(src, "utf8").subarray(0, args.maxBytesPerFile).toString("utf8");
          member.truncated = true;
        }
        member.source = src;
        member.endLineEstimated = span.endLineEstimated;
        sourceIncluded += 1;
      }
    }
    members.push(member);
    return true;
  };

  // 2a. Exact name-pattern resolution per role (CRUD verbs, {E}Configuration, Get/List queries…).
  for (const rule of convention.rules) {
    for (const pattern of expandPatterns(rule, entity)) {
      for (const c of store.getSymbolCandidates(args.repoId, pattern, 3)) {
        // Only accept an exact (case-insensitive) name hit — patterns are precise.
        if (c.name.toLowerCase() !== pattern.toLowerCase()) continue;
        addMember(rule.role, c);
      }
    }
  }

  // 2b. ISSUE-016(a): folder-walk the Commands tree for non-CRUD verb commands the fixed
  // prefix patterns miss (Set/Apply/Toggle/Archive…, e.g. SetEmailSignatureApplied). Classify
  // by suffix so the request/handler/validator land in the right role; `seen` skips the
  // Create/Update/Delete already matched in 2a.
  const entityLc = entity.toLowerCase();
  for (const c of store.getSymbolCandidates(args.repoId, entity, 40, "name", { filePath: "Commands" })) {
    if (!BUNDLE_TYPE_KINDS.has(c.kind)) continue;
    const normPath = c.filePath.replace(/\\/g, "/").toLowerCase();
    if (!normPath.includes("/commands/")) continue;
    const nameLc = c.name.toLowerCase();
    if (!nameLc.includes(entityLc)) continue;
    if (nameLc.endsWith("handler")) addMember("commandHandler", c);
    else if (nameLc.endsWith("validator")) addMember("commandValidator", c);
    else if (!NON_COMMAND_SUFFIXES.some((suf) => nameLc.endsWith(suf))) addMember("command", c);
  }

  // 2c. ISSUE-016(b): the endpoint group is often the *plural* entity with no suffix
  // (class EmailSignatures : IEndpointGroup), which the {E}Endpoints patterns miss. If the
  // endpoint role is still unresolved, match it among IEndpointGroup implementers by name.
  if (!rolesMatched.has("endpoint")) {
    const pluralLc = pluralize(entity).toLowerCase();
    for (const marker of ENDPOINT_MARKER_INTERFACES) {
      for (const impl of store.findImplementations(args.repoId, marker, 50)) {
        const nameLc = impl.name.toLowerCase();
        if (nameLc === entityLc || nameLc === pluralLc || nameLc.includes(entityLc)) {
          addMember("endpoint", impl);
        }
      }
      if (rolesMatched.has("endpoint")) break;
    }
  }

  const unresolvedRoles: ConventionRole[] = convention.rules.map((r) => r.role).filter((role) => !rolesMatched.has(role));

  // DbSet registration site: the *DbContext that references the entity (best-effort).
  const dbContext = store
    .getSymbolCandidates(args.repoId, "DbContext", 5)
    .find((c) => c.kind === "class" && c.name.endsWith("DbContext"));
  const dbSet = dbContext ? { filePath: dbContext.filePath, contextName: dbContext.name } : null;

  const filesResolved = new Set(members.map((m) => m.filePath)).size;
  // Bundle-specific confidence: a name-pattern walk is high-confidence only when the core
  // roles (entity + at least one command/query) resolved; missing roles lower it.
  const coreResolved = members.some((m) => m.role === "entity") && members.some((m) => m.role === "command" || m.role === "query");
  const coverage = {
    confidence: members.length === 0 ? "low" : !coreResolved || unresolvedRoles.length > 3 ? "medium" : "high",
    knownGaps:
      unresolvedRoles.length > 0
        ? [`roles not found by name convention: ${unresolvedRoles.join(", ")} — they may live in differently-named files.`]
        : [],
    suggestFallback:
      members.length === 0
        ? `no slice members matched '${entity}' — verify the entity name or use get_folder_summary on the feature folder.`
        : null
  } as const;
  const stats = {
    entity,
    membersResolved: members.length,
    filesResolved,
    sourceIncluded,
    rolesEmpty: unresolvedRoles
  };

  // Group members by role for the response.
  const byRole: Partial<Record<ConventionRole, BundleMember[]>> = {};
  for (const m of members) (byRole[m.role] ??= []).push(m);

  const entityMember = byRole.entity?.[0];
  const note = "convention walk is heuristic (name-pattern based); unresolvedRoles may exist in differently-named files.";

  if (profile === "nano") {
    return ctx.asText(
      {
        repoId: args.repoId,
        convention: args.convention,
        entity,
        roleCounts: Object.fromEntries(convention.rules.map((r) => [r.role, (byRole[r.role] ?? []).length])),
        filesResolved,
        unresolvedRoles,
        coverage: coverage.confidence
      },
      profile
    );
  }

  // compact/standard/verbose: include members (source omitted under nano only).
  const slice = Object.fromEntries(
    convention.rules.map((r) => [
      r.role,
      (byRole[r.role] ?? []).map((m) => ({
        symbolId: m.symbolId,
        name: m.name,
        kind: m.kind,
        filePath: m.filePath,
        line: m.line,
        ...(m.source !== undefined ? { source: m.source } : {}),
        ...(m.truncated ? { truncated: true } : {}),
        ...(m.endLineEstimated ? { endLineEstimated: true } : {})
      }))
    ])
  );

  return ctx.asText(
    {
      repoId: args.repoId,
      convention: args.convention,
      entity: entityMember ? { name: entity, symbolId: entityMember.symbolId, filePath: entityMember.filePath } : { name: entity },
      slice,
      dbSet,
      stats,
      unresolvedRoles,
      coverage,
      indexMeta: buildIndexMeta(store, args.repoId),
      note
    },
    profile
  );
}
