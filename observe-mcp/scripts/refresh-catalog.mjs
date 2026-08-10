#!/usr/bin/env node
/**
 * Capture a 7-day service catalog into `docs/service-catalog.json`.
 *
 * Why a committed artifact rather than a runtime cache: no server in this
 * workspace writes files at runtime (postgres-mcp's preview store is memory-only
 * by documented decision), while a committed data file refreshed by an npm script
 * is an established convention here — `contracts/*.json` via
 * `scripts/contract-snapshot.mjs` is the template this follows.
 *
 * Why it drives the built server over a real stdio MCP handshake instead of
 * querying OpenObserve directly: the classification logic that turns a source
 * context into a code pointer lives in the server. Reimplementing it here would
 * give two answers to one question. This script is an orchestrator and a file
 * writer; it contains no SQL.
 *
 * The catalog separates two kinds of knowledge, and the separation is the point:
 *   - `recognizeBy` is DERIVED from logs and is rewritten on every refresh.
 *   - `code` is hand/agent-verified and is PRESERVED across refreshes. A
 *     re-capture must never destroy the mapping someone worked out by hand.
 *
 * Needs live credentials, so it belongs with `verify:live` and never runs in CI.
 *
 * Usage:
 *   npm run catalog:refresh                  # capture and write (7d window)
 *   npm run catalog:check                    # offline validation of the committed file
 *   node scripts/refresh-catalog.mjs --window 24h
 *
 * `--window` is bounded by the server's own `OBSERVE_MAX_LOOKBACK_MS`, which
 * defaults to exactly 7 days — so 7d is both the default here and the longest
 * window a default install accepts. A longer one needs that variable raised
 * first, otherwise the capture aborts with "Time window exceeds the maximum
 * lookback". Shorter windows always work and are the useful case: the file
 * records which window it was captured with.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = "dist/index.js";
const CATALOG_FILE = path.join(SERVER_DIR, "docs", "service-catalog.json");

/**
 * Anything older than this is reported as stale. Generous on purpose: the point is
 * to catch a catalog nobody has refreshed in months, not to nag.
 */
const STALE_AFTER_DAYS = 30;

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
/**
 * Validated rather than read positionally: `--window` as the LAST argument made
 * `argv[i + 1]` undefined, which was then dropped from the JSON-RPC arguments, so
 * the server applied its own 1-hour default and this script wrote a one-HOUR
 * capture with `window` absent from the file. `catalog:check` does not validate
 * `window`, so nothing downstream noticed that the "7-day inventory" covered an
 * hour.
 */
const WINDOW = (() => {
  const i = argv.indexOf("--window");
  if (i === -1) {
    return "7d";
  }
  const value = argv[i + 1];
  if (!value || value.startsWith("--")) {
    console.error("--window needs a value, e.g. `--window 24h`. See the usage note at the top of this file.");
    process.exit(1);
  }
  return value;
})();

/** Recursively sort object keys so a re-capture produces a reviewable diff. */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

function readCatalog() {
  if (!fs.existsSync(CATALOG_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
  } catch (error) {
    console.error(`Existing catalog is not valid JSON (${error.message}).`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// --check: offline validation only
// ---------------------------------------------------------------------------

/**
 * Deliberately does NOT verify against live data. Without credentials it could
 * only pretend to, and a `--check` that passes because it had nothing to compare
 * against is exactly how a stale service list survives for months. Live drift is
 * caught by re-running the refresh, which reports it.
 */
function runCheck() {
  const catalog = readCatalog();
  if (!catalog) {
    console.error(`MISSING ${path.relative(SERVER_DIR, CATALOG_FILE)} — run \`npm run catalog:refresh\`.`);
    process.exit(1);
  }

  const problems = [];
  if (typeof catalog.capturedAt !== "string" || Number.isNaN(Date.parse(catalog.capturedAt))) {
    problems.push("capturedAt is missing or not a parseable timestamp");
  }
  // A capture that does not say what range it covers cannot be read: 42 services
  // over an hour and 42 over a week mean different things, and `discover_services`
  // reports this straight through as `catalog.window`.
  if (typeof catalog.window !== "string" || catalog.window.trim() === "") {
    problems.push("window is missing — the file does not record the time range it covers");
  }
  if (!catalog.environments || typeof catalog.environments !== "object") {
    problems.push("environments is missing");
  }
  if (!catalog.services || typeof catalog.services !== "object") {
    problems.push("services is missing");
  }

  for (const [name, env] of Object.entries(catalog.environments ?? {})) {
    // The self-describing count is what proves the file was not hand-edited.
    if (Array.isArray(env.services) && env.logServiceCount !== env.services.length) {
      problems.push(`environments.${name}: logServiceCount ${env.logServiceCount} != services.length ${env.services.length}`);
    }
  }
  for (const [name, entry] of Object.entries(catalog.services ?? {})) {
    if (!entry || typeof entry.recognizeBy !== "object") {
      problems.push(`services["${name}"] has no recognizeBy block`);
    }
  }

  if (problems.length > 0) {
    console.error(`INVALID ${path.relative(SERVER_DIR, CATALOG_FILE)}`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const ageDays = Math.floor((Date.now() - Date.parse(catalog.capturedAt)) / 86_400_000);
  const serviceCount = Object.keys(catalog.services ?? {}).length;
  const mapped = Object.values(catalog.services ?? {}).filter((s) => s.code && Object.keys(s.code).length > 0).length;
  console.log(
    `OK     service-catalog.json  ${serviceCount} services, ${mapped} with a code mapping, captured ${ageDays}d ago (window ${catalog.window ?? "?"})`
  );
  if (ageDays > STALE_AFTER_DAYS) {
    console.error(`STALE  captured ${ageDays} days ago (> ${STALE_AFTER_DAYS}) — run \`npm run catalog:refresh\`.`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result?.content?.[0]?.text ?? "null";
  const payload = JSON.parse(text);
  if (result?.isError) {
    throw new Error(`${name} failed: ${payload?.message ?? text}`);
  }
  return payload;
}

/** Merge the code-link rows returned for one environment into a per-service map. */
function indexCodeLinks(codeLinks) {
  const byService = new Map();
  for (const link of codeLinks ?? []) {
    byService.set(link.service, link);
  }
  return byService;
}

async function refresh() {
  const entryPath = path.join(SERVER_DIR, ENTRY);
  if (!fs.existsSync(entryPath)) {
    console.error(`${ENTRY} not found — run \`npm run build\` first.`);
    process.exit(1);
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    cwd: SERVER_DIR,
    // The developer's real credentials, on purpose: this reaches live OpenObserve.
    env: { ...process.env },
    stderr: "pipe"
  });
  const client = new Client({ name: "catalog-refresh", version: "1.0.0" });

  /**
   * Capture the server's stderr. Without this a startup failure — a missing
   * credential, an unparseable OBSERVE_ENV_* spec — surfaces only as the SDK's
   * "MCP error -32000: Connection closed", which names neither the cause nor the
   * fix. The server writes a diagnostic there; it just has to be read.
   */
  let serverStderr = "";
  transport.stderr?.on("data", (chunk) => {
    serverStderr += String(chunk);
  });

  const previous = readCatalog();
  const previousServices = previous?.services ?? {};

  const environments = {};
  /** service name -> { recognizeBy fields being accumulated across environments } */
  const merged = new Map();
  let secondPassCalls = 0;

  try {
    try {
      await client.connect(transport);
    } catch (error) {
      const detail = serverStderr.trim();
      throw new Error(
        `Could not start ${ENTRY}: ${error.message}${detail ? `\n\nServer stderr:\n${detail}` : ""}`
      );
    }

    const envList = await callTool(client, "list_environments", { profile: "standard" });
    const envNames = (envList.environments ?? []).map((e) => e.name);
    if (envNames.length === 0) {
      throw new Error("The server reported no environments.");
    }
    console.log(`Capturing a ${WINDOW} window for: ${envNames.join(", ")}`);

    for (const envName of envNames) {
      const discovered = await callTool(client, "discover_services", {
        environment: envName,
        time: WINDOW,
        limit: 200,
        lane: "both",
        include: ["codeLinks"],
        profile: "standard"
      });

      const services = discovered.services ?? [];
      const traceOnly = discovered.traceOnlyServices ?? [];
      let codeLinks = indexCodeLinks(discovered.codeLinks);

      // The global service x context matrix is bounded by the server's max page
      // size, and it is ordered by volume — so a high-traffic service can consume
      // the whole budget and leave a quiet one with no contexts at all. Fill those
      // in individually rather than shipping a catalog with silent holes.
      const needsSecondPass = services
        .map((s) => s.name)
        .filter((name) => {
          const link = codeLinks.get(name);
          return !link || ((link.namespaceRoots ?? []).length === 0 && (link.frameworkHints ?? []).length === 0);
        });

      if (needsSecondPass.length > 0) {
        console.log(`  ${envName}: filling code links for ${needsSecondPass.length} service(s) individually`);
        for (const name of needsSecondPass) {
          const one = await callTool(client, "discover_services", {
            environment: envName,
            service: name,
            time: WINDOW,
            lane: "logs",
            include: ["codeLinks"],
            profile: "standard"
          });
          secondPassCalls += 1;
          for (const link of one.codeLinks ?? []) {
            codeLinks.set(name, { ...link, service: name });
          }
        }
      }

      // The org identifier is deliberately NOT captured. It is infrastructure
      // identity rather than an observation about the index, it is what
      // `config/environments.ts` refuses to default for exactly the reason a
      // committed copy would reintroduce — a stale identifier that outlives the
      // deployment it was copied from — and `list_environments` reports the live
      // value on demand. Nothing in the catalog's purpose needs it.
      environments[envName] = {
        logStream: discovered.stream ?? null,
        traceStream: discovered.traceStream ?? null,
        window: WINDOW,
        logServiceCount: services.length,
        services: services.map((s) => ({
          name: s.name,
          logCount: s.logCount,
          errorCount: s.errorCount,
          warnCount: s.warnCount,
          lanes: s.lanes ?? ["logs"],
          lastSeen: s.lastSeen ?? null
        })),
        traceOnlyServiceCount: traceOnly.length,
        traceOnlyServices: traceOnly.map((s) => ({ name: s.name, spanCount: s.spanCount }))
      };

      // Identity is environment-independent, so accumulate it across environments.
      const accumulate = (name, lanes) => {
        if (!name) return;
        const entry = merged.get(name) ?? {
          serviceName: name,
          appContexts: new Set(),
          unclassifiedContexts: new Set(),
          namespaceRoots: [],
          frameworkHints: new Set(),
          lanes: new Set(),
          environments: new Set()
        };
        entry.environments.add(envName);
        for (const lane of lanes) entry.lanes.add(lane);
        const link = codeLinks.get(name);
        if (link) {
          for (const c of link.appContexts ?? []) entry.appContexts.add(c);
          for (const c of link.unclassifiedContexts ?? []) entry.unclassifiedContexts.add(c);
          for (const h of link.frameworkHints ?? []) entry.frameworkHints.add(h);
          // Keep the first (most frequent) ordering rather than sorting: which
          // namespace dominates a service is information.
          for (const root of link.namespaceRoots ?? []) {
            if (!entry.namespaceRoots.includes(root)) entry.namespaceRoots.push(root);
          }
        }
        merged.set(name, entry);
      };

      for (const s of services) accumulate(s.name, s.lanes ?? ["logs"]);
      for (const s of traceOnly) accumulate(s.name, ["traces"]);
    }
  } finally {
    await client.close().catch(() => {});
  }

  // --- cross-lane attribution ------------------------------------------------
  // Some services name themselves on their SPANS but not on their LOG rows, so
  // their logs land under `unknown_service:dotnet` while their span rows carry a
  // real service name. Observed live: `Bmw.Teleservices.V3.Api` has no log
  // contexts of its own, yet `Bmw.Teleservices.V3.Api.Services.*` appears in the
  // logs under `unknown_service:dotnet`.
  //
  // That link is derivable — match the service's own name against the contexts
  // recorded for every other service — and it is the difference between a service
  // being unidentifiable and pointing straight at its code. Recorded as
  // `logsUnder` so the reader knows to search a DIFFERENT service_name to find
  // this service's logs.
  const contextOwners = new Map();
  for (const [owner, entry] of merged) {
    for (const ctx of entry.appContexts) {
      const list = contextOwners.get(ctx) ?? [];
      list.push(owner);
      contextOwners.set(ctx, list);
    }
  }
  for (const [name, entry] of merged) {
    if (entry.appContexts.size > 0) continue;
    const borrowed = new Map();
    for (const [ctx, owners] of contextOwners) {
      if (!ctx.startsWith(`${name}.`)) continue;
      for (const owner of owners) {
        if (owner === name) continue;
        const list = borrowed.get(owner) ?? [];
        list.push(ctx);
        borrowed.set(owner, list);
      }
    }
    if (borrowed.size === 0) continue;
    entry.logsUnder = [...borrowed.keys()].sort();
    entry.borrowedContexts = [...new Set([...borrowed.values()].flat())].sort();
  }

  // --- assemble, preserving the hand-verified half --------------------------
  const services = {};
  for (const [name, entry] of [...merged.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const recognizeBy = {
      serviceName: entry.serviceName,
      appContexts: [...entry.appContexts].sort(),
      unclassifiedContexts: [...entry.unclassifiedContexts].sort(),
      namespaceRoots: entry.namespaceRoots,
      frameworkHints: [...entry.frameworkHints],
      lanes: [...entry.lanes].sort(),
      environments: [...entry.environments].sort()
    };
    // A service name that carries several application namespace roots is not one
    // service — it is several apps that never set OTel service.name. Say so in the
    // artifact, because it changes how the logs must be read.
    if (entry.namespaceRoots.length > 1) {
      recognizeBy.note =
        "Multiple application namespace roots emit under this service name — attribute rows by namespaceRoots, not by service alone.";
    }
    if (entry.logsUnder) {
      recognizeBy.logsUnder = entry.logsUnder;
      recognizeBy.borrowedContexts = entry.borrowedContexts;
      recognizeBy.note = `This service names itself on spans but not on log rows: search logs under service_name ${entry.logsUnder
        .map((s) => `"${s}"`)
        .join(" / ")} and filter by sourceContext starting "${name}.".`;
    } else if (entry.appContexts.size === 0 && [...entry.lanes].join() === "traces") {
      // Produces spans and no log rows at all, under this name or any other. Not a
      // hole in the capture — there is nothing in the logs to find, so say that
      // rather than leaving the entry blank and inviting a re-run.
      recognizeBy.note =
        "Appears only in the traces lane and emits no log rows — use get_trace_spans / span attributes, not search_logs, to investigate it.";
    } else if (
      entry.appContexts.size === 0 &&
      entry.unclassifiedContexts.size === 0 &&
      entry.frameworkHints.size > 0
    ) {
      // Not a gap in the capture: the service really does emit only framework
      // logs. Saying so stops someone re-running discovery to look for code that
      // was never logged.
      recognizeBy.note =
        "Emits only framework/library log contexts — no first-party namespace appears in its logs. Identify it by service_name alone.";
    }
    services[name] = {
      recognizeBy,
      // PRESERVED, never derived. This is the whole reason the two blocks are separate.
      code: previousServices[name]?.code ?? {}
    };
  }

  const catalog = sortDeep({
    capturedAt: new Date().toISOString(),
    window: WINDOW,
    generator: "npm run catalog:refresh",
    note: "`recognizeBy` is derived from logs and is rewritten on every refresh. `code` is hand-verified and preserved — edit it freely.",
    environments,
    services
  });

  fs.mkdirSync(path.dirname(CATALOG_FILE), { recursive: true });
  fs.writeFileSync(CATALOG_FILE, `${JSON.stringify(catalog, null, 2)}\n`);

  // --- reconciliation: the operational payoff ------------------------------
  const previousNames = new Set(Object.keys(previousServices));
  const currentNames = new Set(Object.keys(services));
  const added = [...currentNames].filter((n) => !previousNames.has(n));
  const removed = [...previousNames].filter((n) => !currentNames.has(n));
  const unmapped = [...currentNames].filter((n) => Object.keys(services[n].code ?? {}).length === 0);

  const identified = [...currentNames].filter(
    (n) =>
      (services[n].recognizeBy.namespaceRoots ?? []).length > 0 ||
      (services[n].recognizeBy.logsUnder ?? []).length > 0 ||
      typeof services[n].recognizeBy.note === "string"
  );

  console.log(`\nWrote ${path.relative(SERVER_DIR, CATALOG_FILE)} — ${currentNames.size} services, ${WINDOW} window.`);
  console.log(`  ${identified.length}/${currentNames.size} have a usable recognition signal.`);
  if (secondPassCalls > 0) console.log(`  ${secondPassCalls} service(s) needed an individual code-link query.`);
  if (previous) {
    console.log(`  new since last capture:  ${added.length > 0 ? added.join(", ") : "(none)"}`);
    console.log(`  gone since last capture: ${removed.length > 0 ? removed.join(", ") : "(none)"}`);
  } else {
    console.log("  (no previous catalog to compare against)");
  }
  if (unmapped.length > 0) {
    console.log(`  still missing a \`code\` mapping (${unmapped.length}): ${unmapped.join(", ")}`);
    console.log("  → fill in `code.repoId` / `code.project` for these; a refresh preserves whatever you write.");
  }
}

if (CHECK) {
  runCheck();
} else {
  await refresh();
}
