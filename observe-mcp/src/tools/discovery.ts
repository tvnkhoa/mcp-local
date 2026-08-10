/**
 * `discover_services` — what is actually in this log index right now.
 *
 * Before this tool the only way to answer "which services exist" was
 * `log_stats(groupBy:"service")`, which returns names and counts. Everything else
 * an operator needs — is it erroring, is it still alive, which code emitted it,
 * does it also produce traces — had to be guessed or remembered. It was
 * remembered wrongly: the skill shipped a pointer to a "43 service catalog" that
 * named a stream which no longer existed.
 *
 * Three things here are not obvious and are the reason the tool is shaped this way:
 *
 *  1. **Two lanes.** A traces stream has its own service inventory. Checked live,
 *     `CommunicationHub.Web` is the largest span producer by an order of magnitude
 *     and does not appear in the logs inventory at all. `lane: "both"` is the
 *     default because a logs-only answer is incomplete.
 *  2. **Contexts must be classified, not ranked.** By raw volume every top source
 *     context is framework plumbing. See `services/namespaces.ts`.
 *  3. **`unknown_service:dotnet` is not one service.** It is the largest bucket in
 *     both environments and is every app that never set OTel `service.name`.
 *     `include:"codeLinks"` is what takes it apart.
 */

import fs from "node:fs";

import { ok } from "@mcp/core";
import type { AnyToolDefinition } from "@mcp/sdk";
import { annotations, defineTool, schema } from "@mcp/sdk";
import { z } from "zod";

import type { ObserveLimits } from "../config/index.js";
import type { ClientManager } from "../services/clientManager.js";
import { describeFields, microsToIso } from "../services/logParser.js";
import { classifyNamespace, frameworkHints, nonFrameworkNamespaceRoots } from "../services/namespaces.js";
import {
  buildContextInventorySql,
  buildSampleSql,
  buildServiceContextMatrixSql,
  buildServiceInventorySql,
  buildTraceServiceInventorySql,
  clampSize,
  resolveWindow
} from "../services/queryBuilder.js";

import { envProp, environmentArg, instantArg, profileArg, profileProp, streamArg, timeArg } from "./common.js";

/** Stream types worth listing for orientation. The dev org has 185 streams, ~150 of them metrics. */
const NAVIGABLE_STREAM_TYPES = new Set(["logs", "traces"]);

/** OpenObserve maintains internal helper streams; they are not datasets anyone queries. */
function isInternalStream(name: string): boolean {
  return name.startsWith("distinct_values_") || name === "trace_list_index";
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value ?? 0) || 0;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : value === undefined || value === null ? null : String(value);
}

// ---------------------------------------------------------------------------
// The committed catalog (docs/service-catalog.json)
// ---------------------------------------------------------------------------

export type ServiceCatalog = {
  capturedAt?: string;
  window?: string;
  environments?: Record<string, unknown>;
  services?: Record<string, unknown>;
};

/**
 * Resolved relative to this module, so it works both from `dist/` and from `tsx
 * src/`. The catalog is a committed artifact, not runtime state — this server
 * writes nothing to disk.
 */
const CATALOG_URL = new URL("../../docs/service-catalog.json", import.meta.url);

let catalogCache: { mtimeMs: number; catalog: ServiceCatalog } | null = null;

/**
 * Read the committed catalog, re-reading when the file changes on disk so a
 * `catalog:refresh` in another terminal is picked up without restarting the
 * server. Absent or unparseable → null; the catalog is optional by design and its
 * absence must never break a live query.
 */
export function loadCatalog(): ServiceCatalog | null {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(CATALOG_URL).mtimeMs;
  } catch {
    return null;
  }
  if (catalogCache && catalogCache.mtimeMs === mtimeMs) {
    return catalogCache.catalog;
  }
  try {
    const catalog = JSON.parse(fs.readFileSync(CATALOG_URL, "utf8")) as ServiceCatalog;
    catalogCache = { mtimeMs, catalog };
    return catalog;
  } catch {
    return null;
  }
}

/**
 * Trim one catalog entry for the low-detail profiles.
 *
 * `appContexts` is the long field — `unknown_service:dotnet` alone carries ~140
 * fully-qualified type names. At nano/compact the useful part is the summary: the
 * namespace roots, where the logs actually land, and the owning project. The count
 * is kept so the caller knows detail exists and can ask for it, rather than
 * concluding the entry is empty.
 */
export function projectCatalogEntry(entry: unknown, detail: boolean): unknown {
  if (detail || !entry || typeof entry !== "object") {
    return entry;
  }
  const e = entry as Record<string, unknown>;
  const r = (e.recognizeBy ?? {}) as Record<string, unknown>;
  const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  return {
    code: e.code,
    recognizeBy: {
      serviceName: r.serviceName,
      namespaceRoots: r.namespaceRoots,
      logsUnder: r.logsUnder,
      lanes: r.lanes,
      environments: r.environments,
      note: r.note,
      frameworkHints: r.frameworkHints,
      appContextCount: asArray(r.appContexts).length + asArray(r.borrowedContexts).length
    }
  };
}

/**
 * Drop the per-service array from an environment capture, keeping its shape and
 * counts. At nano/compact the live `services` list is what a caller wants for
 * volumes; repeating the captured copy is what made this response 40 KB.
 */
export function summarizeEnvironmentCapture(capture: unknown): unknown {
  if (!capture || typeof capture !== "object") {
    return capture ?? null;
  }
  const c = capture as Record<string, unknown>;
  return {
    logStream: c.logStream,
    traceStream: c.traceStream,
    window: c.window,
    logServiceCount: c.logServiceCount,
    traceOnlyServiceCount: c.traceOnlyServiceCount
  };
}

/** The captured rows for one service, from both lanes of an environment capture. */
export function environmentRowsFor(capture: unknown, service: string): unknown {
  if (!capture || typeof capture !== "object") {
    return null;
  }
  const c = capture as Record<string, unknown>;
  const find = (key: string): unknown =>
    (Array.isArray(c[key]) ? (c[key] as Record<string, unknown>[]) : []).find((row) => row.name === service) ?? null;
  return {
    logStream: c.logStream,
    traceStream: c.traceStream,
    window: c.window,
    logs: find("services"),
    traces: find("traceOnlyServices")
  };
}

/** Age of the capture in whole days, plus a warning once it is old enough to mislead. */
function catalogFreshness(catalog: ServiceCatalog, nowMs: number): Record<string, unknown> {
  const capturedAt = typeof catalog.capturedAt === "string" ? catalog.capturedAt : null;
  const parsed = capturedAt ? Date.parse(capturedAt) : Number.NaN;
  if (!capturedAt || Number.isNaN(parsed)) {
    return { capturedAt: null, ageDays: null, staleWarning: "Catalog has no usable capturedAt; treat it as unverified." };
  }
  const ageDays = Math.floor((nowMs - parsed) / 86_400_000);
  return {
    capturedAt,
    window: catalog.window ?? null,
    ageDays,
    staleWarning:
      ageDays > 30
        ? `Catalog was captured ${ageDays} days ago; re-run \`npm run catalog:refresh\` before relying on it.`
        : null
  };
}

// ---------------------------------------------------------------------------

export function buildDiscoveryTools(limits: ObserveLimits, clients: ClientManager): readonly AnyToolDefinition[] {
  const includeArg = z.array(z.enum(["contexts", "fields", "streams", "codeLinks"])).max(4).optional();

  const discoverServices = defineTool({
    name: "discover_services",
    description:
      "Discover which services are emitting into an environment: per-service log volume, error/warning counts, first/last seen, and (with include:\"codeLinks\") the application namespaces that identify the owning code. Covers both the logs and traces lanes. Use this instead of assuming a fixed service list.",
    input: z
      .object({
        environment: environmentArg,
        stream: streamArg,
        time: timeArg,
        start: instantArg,
        end: instantArg,
        // Capped by the server's own max page size, not by a private 200: an org
        // with more emitting services than the page size needs a way to see them,
        // and a hard 200 made the inventory silently incomplete with no recourse.
        limit: z.number().int().positive().max(limits.maxSize).optional(),
        service: z.string().min(1).max(256).optional(),
        lane: z.enum(["logs", "traces", "both"]).optional(),
        include: includeArg,
        sample: z.number().int().positive().max(50).optional(),
        source: z.enum(["live", "catalog"]).optional(),
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object({
      environment: envProp,
      stream: schema.string("Override the environment's logs stream"),
      time: schema.string("Relative window ending now, e.g. 24h, 7d (default 1h)"),
      start: schema.string("Absolute start (ISO 8601 or epoch ms)"),
      end: schema.string("Absolute end (ISO 8601 or epoch ms)"),
      limit: schema.number("Max services per lane (default 200); servicesTruncated says when it bit"),
      service: schema.string("Restrict contexts/fields to one service_name"),
      lane: schema.enumOf(["logs", "traces", "both"]),
      include: schema.array(schema.enumOf(["contexts", "fields", "streams", "codeLinks"]), "Optional extra sections"),
      sample: schema.number("Rows to sample when include contains \"fields\" (default 25, max 50)"),
      source: schema.enumOf(["live", "catalog"]),
      profile: profileProp
    }),
    annotations: annotations.readRemote(),
    handler: async (input) => {
      const env = clients.getEnvironment(input.environment);
      const catalog = loadCatalog();

      // `source:"catalog"` answers from the committed artifact and touches no
      // network. It is opt-in, and live stays the default: the catalog is a dated
      // reference, and letting it silently answer for the index is exactly the
      // failure mode this tool exists to fix.
      if (input.source === "catalog") {
        if (!catalog) {
          return ok({
            environment: env.name,
            source: "catalog",
            error: "No committed catalog found at docs/service-catalog.json. Run `npm run catalog:refresh`, or call again without source:\"catalog\".",
            services: {}
          });
        }

        // Arguments that only mean something for a live query are named back rather
        // than dropped — same reasoning as the unknown-service branch below. Asking
        // the catalog for `include:["streams"]` otherwise returns a response with no
        // `streams` key and no hint that the argument went nowhere.
        const ignoredArguments = (
          [
            ["stream", input.stream],
            ["time", input.time],
            ["start", input.start],
            ["end", input.end],
            ["limit", input.limit],
            ["lane", input.lane],
            ["include", input.include],
            ["sample", input.sample]
          ] as const
        )
          .filter(([, value]) => value !== undefined)
          .map(([name]) => name);

        /**
         * Named back on every catalog response, so a caller who scoped a query and
         * got an unscoped answer can see why. Omitted entirely when nothing was
         * ignored rather than emitted as an empty array — the common call passes
         * none of these.
         */
        const ignoredNote =
          ignoredArguments.length > 0
            ? {
                ignoredArguments,
                ignoredArgumentsNote: `source:"catalog" answers from the committed capture, so ${ignoredArguments.join(
                  ", "
                )} ${ignoredArguments.length === 1 ? "was" : "were"} not applied. Drop source:"catalog" to query live with ${
                  ignoredArguments.length === 1 ? "it" : "them"
                }.`
              }
            : {};

        const all = catalog.services ?? {};
        const wanted = input.service;
        // An unknown name is reported, not answered with all 42 entries: silently
        // ignoring a supplied argument hides a typo behind a plausible response.
        // `Object.hasOwn`, not `all[wanted] === undefined`: the catalog is a parsed
        // JSON object, so a bare index also finds inherited keys and `service:
        // "constructor"` would sail past this check and then serialize to nothing.
        if (wanted !== undefined && !Object.hasOwn(all, wanted)) {
          return ok({
            environment: env.name,
            source: "catalog",
            catalog: catalogFreshness(catalog, Date.now()),
            error: `Service "${wanted}" is not in the committed catalog. Call without \`service\` to list what is, or without source:"catalog" to query live.`,
            knownServiceCount: Object.keys(all).length,
            ...ignoredNote,
            services: {}
          });
        }

        // Full detail only where it was asked for. `appContexts` is long, and at
        // nano/compact the whole map came to ~40 KB — the offline path should be
        // the cheap one.
        const detail = input.profile === "standard" || input.profile === "verbose";
        const selected = wanted !== undefined ? { [wanted]: all[wanted] } : all;
        const services = Object.fromEntries(
          Object.entries(selected).map(([name, entry]) => [name, projectCatalogEntry(entry, detail)])
        );
        const capture = (catalog.environments ?? {})[env.name] ?? null;

        return ok({
          environment: env.name,
          source: "catalog",
          catalog: catalogFreshness(catalog, Date.now()),
          serviceCount: Object.keys(services).length,
          ...ignoredNote,
          environmentCapture:
            wanted !== undefined
              ? environmentRowsFor(capture, wanted)
              : detail
                ? capture
                : summarizeEnvironmentCapture(capture),
          services
        });
      }

      const client = clients.getClient(input.environment);
      const stream = input.stream ?? env.logStream;
      const window = resolveWindow(input, limits, Date.now());
      // 200 rather than the shared `defaultSize`: an inventory is one row per
      // service, so it wants a wide page. Clamped so a lowered OBSERVE_MAX_SIZE
      // still bounds the default, not just an explicit argument.
      const limit = Math.min(input.limit ?? 200, limits.maxSize);
      const include = new Set(input.include ?? []);
      const lane = input.lane ?? "both";

      // --- the logs lane -----------------------------------------------------
      const logRows =
        lane === "traces"
          ? []
          : (
              await client.search({
                sql: buildServiceInventorySql(stream, limit),
                startUs: window.startUs,
                endUs: window.endUs,
                size: limit,
                type: "logs"
              })
            ).hits;

      const services = logRows.map((row) => ({
        name: stringOf(row.service_name),
        logCount: numberOf(row.log_count),
        errorCount: numberOf(row.error_count),
        warnCount: numberOf(row.warn_count),
        contextCount: numberOf(row.context_count),
        firstSeen: microsToIso(row.first_seen),
        lastSeen: microsToIso(row.last_seen)
      }));

      // --- the traces lane ---------------------------------------------------
      // Not redundant with the logs lane: a service can produce spans and no logs.
      let traceServices: Array<{ name: string | null; spanCount: number; firstSeen: string | null; lastSeen: string | null }> = [];
      let traceLaneWarning: string | null = null;
      if (lane !== "logs") {
        try {
          const traceRes = await client.search({
            sql: buildTraceServiceInventorySql(env.traceStream, limit),
            startUs: window.startUs,
            endUs: window.endUs,
            size: limit,
            type: "traces"
          });
          traceServices = traceRes.hits.map((row) => ({
            name: stringOf(row.service_name),
            spanCount: numberOf(row.span_count),
            firstSeen: microsToIso(row.first_seen),
            lastSeen: microsToIso(row.last_seen)
          }));
        } catch (error) {
          // A missing or misconfigured traces stream must not fail the whole
          // discovery — the logs answer is still useful, so report and continue.
          traceLaneWarning = `Traces lane unavailable for stream "${env.traceStream}": ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }

      const logNames = new Set(services.map((s) => s.name));
      const traceNames = new Set(traceServices.map((s) => s.name));
      const withLanes = services.map((s) => ({
        ...s,
        lanes: traceNames.has(s.name) ? ["logs", "traces"] : ["logs"]
      }));

      // With `lane:"traces"` the logs lane was never queried, so there is no logs
      // inventory to subtract: every span producer would be classified "trace-only"
      // — which is unproven, nothing established they are absent from the logs — and
      // `serviceCount` would report 0, which reads as "no services emit traces". The
      // traces inventory IS the answer to that request, so report it as `services`
      // and say that the trace-only split needs both lanes.
      const tracesLaneOnly = lane === "traces";
      const inventory = tracesLaneOnly ? traceServices.map((s) => ({ ...s, lanes: ["traces"] })) : withLanes;
      const traceOnlyServices = tracesLaneOnly ? [] : traceServices.filter((s) => !logNames.has(s.name));

      // The include sections all read the LOGS stream regardless of `lane`, so the
      // stream is named when it was actually touched and null when it was not —
      // rather than always naming a stream that a traces-lane call never queried.
      const logsStreamQueried =
        !tracesLaneOnly || include.has("contexts") || include.has("codeLinks") || include.has("fields");

      // Both lanes page at `limit`, so a full page means "there may be more" for
      // each independently. Reported rather than left implicit: this is the tool
      // whose stated purpose is that there is no fixed service list, and a silently
      // clipped inventory is indistinguishable from a complete one.
      const servicesTruncated = tracesLaneOnly ? traceServices.length >= limit : services.length >= limit;
      const traceServicesTruncated = !tracesLaneOnly && traceServices.length >= limit;

      const payload: Record<string, unknown> = {
        environment: env.name,
        source: "live",
        stream: logsStreamQueried ? stream : null,
        traceStream: lane === "logs" ? null : env.traceStream,
        window: { start: microsToIso(window.startUs), end: microsToIso(window.endUs) },
        lane,
        laneNote: tracesLaneOnly
          ? "lane:\"traces\" queried only the traces stream, so `services` is the span-producing inventory and the logs/trace-only split is not available. Use lane:\"both\" for that."
          : null,
        limit,
        serviceCount: inventory.length,
        services: inventory,
        servicesTruncated,
        traceOnlyServiceCount: traceOnlyServices.length,
        traceOnlyServices,
        traceServicesTruncated,
        truncationNote:
          servicesTruncated || traceServicesTruncated
            ? `The service inventory filled the ${limit}-row page, so quieter services may be missing. Re-run with a higher \`limit\` (max ${limits.maxSize}).`
            : null,
        traceLaneWarning,
        catalog: catalog ? catalogFreshness(catalog, Date.now()) : null
      };

      // --- include: contexts -------------------------------------------------
      if (include.has("contexts")) {
        const size = clampSize(limits.maxSize, limits);
        const res = await client.search({
          sql: buildContextInventorySql(stream, size, input.service),
          startUs: window.startUs,
          endUs: window.endUs,
          size,
          type: "logs"
        });
        const contexts = res.hits.map((row) => {
          const name = stringOf(row.instrumentation_library_name) ?? "";
          return { name, count: numberOf(row.count), classification: classifyNamespace(name, limits) };
        });
        payload.contexts = contexts;
        payload.contextTruncated = contexts.length >= size;
      }

      // --- include: codeLinks ------------------------------------------------
      // The service → code mapping. With `service` given this is exact; without
      // it, the global matrix is bounded by maxSize and high-volume services eat
      // the budget, so the truncation is reported rather than hidden. The catalog
      // refresh script iterates services one at a time for full coverage.
      if (include.has("codeLinks")) {
        const size = clampSize(limits.maxSize, limits);
        const sql = input.service
          ? buildContextInventorySql(stream, size, input.service)
          : buildServiceContextMatrixSql(stream, size);
        const res = await client.search({
          sql,
          startUs: window.startUs,
          endUs: window.endUs,
          size,
          type: "logs"
        });

        const perService = new Map<string, Array<{ name: string; count: number }>>();
        for (const row of res.hits) {
          const svc = input.service ?? stringOf(row.service_name) ?? "";
          const ctx = stringOf(row.instrumentation_library_name) ?? "";
          if (!ctx) {
            continue;
          }
          const list = perService.get(svc) ?? [];
          list.push({ name: ctx, count: numberOf(row.count) });
          perService.set(svc, list);
        }

        payload.codeLinks = [...perService.entries()].map(([name, contexts]) => ({
          service: name,
          appContexts: contexts.filter((c) => classifyNamespace(c.name, limits) === "app").map((c) => c.name),
          unclassifiedContexts: contexts
            .filter((c) => classifyNamespace(c.name, limits) === "unclassified")
            .map((c) => c.name),
          namespaceRoots: nonFrameworkNamespaceRoots(contexts, limits),
          frameworkHints: frameworkHints(contexts, limits)
        }));
        payload.codeLinksTruncated = !input.service && res.hits.length >= size;
        if (payload.codeLinksTruncated) {
          payload.codeLinksNote =
            "The service x context matrix hit the row cap, so low-volume services may have no contexts here. Re-run with `service` set to fill those in.";
        }
      }

      // --- include: fields ---------------------------------------------------
      if (include.has("fields")) {
        // 25, not describe_stream's 5: a 5-row sample misses any field absent
        // from those rows, which for a service-scoped sample is most of them.
        const sample = input.sample ?? 25;
        const res = await client.search({
          sql: buildSampleSql(stream, sample, input.service),
          startUs: window.startUs,
          endUs: window.endUs,
          size: sample,
          type: "logs"
        });
        const fields = describeFields(res.hits);
        payload.sampled = res.hits.length;
        payload.fieldCount = fields.length;
        payload.fields = fields;
      }

      // --- include: streams --------------------------------------------------
      if (include.has("streams")) {
        const all = await client.listStreams();
        payload.streams = all
          .filter((s) => NAVIGABLE_STREAM_TYPES.has(s.stream_type ?? "") && !isInternalStream(s.name))
          .map((s) => ({ name: s.name, type: s.stream_type ?? null }));
        payload.streamsNote = "Log and trace datasets only; metrics and OpenObserve-internal streams are omitted.";
      }

      return ok(payload);
    }
  });

  return [discoverServices];
}
