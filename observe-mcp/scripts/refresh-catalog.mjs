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
 *   npm run catalog:verify                   # LIVE: re-test the file's assertions, write nothing
 *   node scripts/refresh-catalog.mjs --window 24h
 *
 * `--check` and `--verify` answer different questions and neither replaces the other.
 * `--check` asks "is this file well-formed and not ancient" with no credentials.
 * `--verify` asks "are its claims still TRUE", which is the failure that actually
 * bites: a capture reported `ageDays: 0` while four of its assertions about one
 * service were already false, because a consuming team had fixed that service's
 * `service.name` three hours after the capture. Age cannot see that; only re-testing
 * the assertions can.
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
const VERIFY = argv.includes("--verify");
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

/**
 * The OTel spec default a .NET SDK reports when nothing set `service.name`.
 *
 * Hardcoded here on purpose, and only for PRESENTATION — this script decides nothing
 * about identity, it just needs to know whether an entry is the shared unnamed bucket
 * so it can word that entry differently. The resolution itself is the server's, via
 * `OBSERVE_UNKNOWN_SERVICE_SENTINEL`, and a deployment that changed the sentinel would
 * simply lose the special wording, not get a wrong catalog.
 */
const SENTINEL_SERVICE_NAMES = new Set(["unknown_service:dotnet", "unknown_service"]);

function isSentinelName(name) {
  return SENTINEL_SERVICE_NAMES.has(name) || name.startsWith("unknown_service:");
}

/** One value from what each environment observed: agreement, or `mixed` if they differ. */
function identitySourceOf(sources) {
  const seen = [...sources];
  if (seen.length === 0) return null;
  if (seen.length === 1) return seen[0];
  return "mixed";
}

/**
 * Which signal an entry is grounded in, strongest first.
 *
 * The precedence is not a preference, it is a difference in evidential value:
 * `namespaceRoots` names the owning CODE, `appContexts` names the emitting class,
 * `frameworkHints` names only the KIND of app (Ocelot → gateway, Elsa/Rebus →
 * workflow engine, Quartz → has scheduled jobs). An entry resting on the last one is
 * not wrong, it is weak — and saying so is the difference between a reader trusting
 * it as a code pointer and treating it as a hint.
 */
function identifiedByOf(entry) {
  if (entry.namespaceRoots.length > 0) return "namespace";
  if (entry.appContexts.size > 0 || entry.unclassifiedContexts.size > 0) return "context";
  if (entry.frameworkHints.size > 0) return "framework";
  return "serviceNameOnly";
}

/** Merge the code-link rows returned for one environment into a per-service map. */
function indexCodeLinks(codeLinks) {
  const byService = new Map();
  for (const link of codeLinks ?? []) {
    byService.set(link.service, link);
  }
  return byService;
}

/** The server's own rule for "is there a connection configured at all". */
function hasObserveConnection(env) {
  return Boolean(env.OBSERVE_BASE_URL) || Object.keys(env).some((k) => k.startsWith("OBSERVE_ENV_"));
}

/**
 * Credentials come from the agent registration when the shell has none.
 *
 * By workspace convention the OBSERVE_* values live in `~/.claude.json` under the
 * registered server, not in any shell profile — so running this script from a normal
 * terminal failed with `config_error: No OpenObserve environments configured`, and
 * the only workaround was to re-export secrets by hand. This script drives *that same
 * registered server*, so inheriting *that same env* is the coherent thing to do.
 *
 * Read-only, via the installer's own helper, and values are never printed — only the
 * agent and entry NAME that supplied them.
 *
 * Several registrations are refused rather than merged. A merge across
 * `observe-mcp-ssdev_au` and `observe-mcp-prod` would silently build one process
 * holding two orgs' credentials, which is the same wrong-account failure
 * `resolveAuthHeader` refuses in `config/index.ts` — arrived at from the other side.
 */
async function inheritedEnv() {
  if (hasObserveConnection(process.env)) {
    return process.env;
  }
  let agents;
  let readServerEntries;
  try {
    ({ detectAgents: agents, readServerEntries } = await import(
      new URL("../../scripts/lib/agents.mjs", import.meta.url).href
    ).then((m) => ({ detectAgents: m.detectAgents, readServerEntries: m.readServerEntries })));
  } catch {
    // Standalone checkout without the workspace scripts — nothing to inherit, and
    // the server's own startup error already says exactly what to set.
    return process.env;
  }

  const found = [];
  for (const agent of agents()) {
    for (const entry of readServerEntries(agent, "observe-mcp")) {
      if (entry.entry?.env && hasObserveConnection(entry.entry.env)) {
        found.push({ agent: agent.name, name: entry.name, env: entry.entry.env });
      }
    }
  }
  if (found.length === 0) {
    return process.env;
  }
  if (found.length > 1) {
    console.error(
      `Found ${found.length} observe-mcp registrations (${found.map((f) => `${f.agent}:${f.name}`).join(", ")}).`
    );
    console.error("Refusing to guess which credentials to use — set OBSERVE_* in the shell to choose explicitly.");
    process.exit(1);
  }
  console.log(`Using credentials from the ${found[0].agent} registration "${found[0].name}" (no OBSERVE_* in the shell).`);
  return { ...process.env, ...found[0].env };
}

/**
 * Start the built server over stdio and hand back a connected MCP client.
 *
 * Shared by `refresh` and `--verify` so both fail the same way: the server's stderr
 * is captured, because a startup failure — a missing credential, an unparseable
 * OBSERVE_ENV_* spec — otherwise surfaces only as the SDK's "MCP error -32000:
 * Connection closed", which names neither the cause nor the fix.
 */
async function openServer(clientName) {
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
    // The shell first, the agent registration as the fallback — see `inheritedEnv`.
    env: await inheritedEnv(),
    stderr: "pipe"
  });
  const client = new Client({ name: clientName, version: "1.0.0" });

  let serverStderr = "";
  transport.stderr?.on("data", (chunk) => {
    serverStderr += String(chunk);
  });

  try {
    await client.connect(transport);
  } catch (error) {
    const detail = serverStderr.trim();
    throw new Error(`Could not start ${ENTRY}: ${error.message}${detail ? `\n\nServer stderr:\n${detail}` : ""}`);
  }
  return client;
}

async function refresh() {
  const client = await openServer("catalog-refresh");

  const previous = readCatalog();
  const previousServices = previous?.services ?? {};

  const environments = {};
  /** service name -> { recognizeBy fields being accumulated across environments } */
  const merged = new Map();
  let secondPassCalls = 0;

  try {
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
        // `identitySource` is captured per ENVIRONMENT, unlike the rest of the
        // identity block: a service is routinely fixed in dev before prod, so one
        // merged value across environments would assert something false about one of
        // them. This is the field `--verify` re-tests.
        identityResolved: discovered.identity?.resolved ?? null,
        services: services.map((s) => ({
          name: s.name,
          logCount: s.logCount,
          errorCount: s.errorCount,
          warnCount: s.warnCount,
          lanes: s.lanes ?? ["logs"],
          identitySource: s.identitySource ?? null,
          lastSeen: s.lastSeen ?? null
        })),
        traceOnlyServiceCount: traceOnly.length,
        traceOnlyServices: traceOnly.map((s) => ({ name: s.name, spanCount: s.spanCount }))
      };

      // Identity is environment-independent, so accumulate it across environments.
      const accumulate = (name, lanes, identitySource) => {
        if (!name) return;
        const entry = merged.get(name) ?? {
          serviceName: name,
          appContexts: new Set(),
          unclassifiedContexts: new Set(),
          namespaceRoots: [],
          frameworkHints: new Set(),
          lanes: new Set(),
          identitySources: new Set(),
          environments: new Set()
        };
        entry.environments.add(envName);
        for (const lane of lanes) entry.lanes.add(lane);
        if (identitySource) entry.identitySources.add(identitySource);
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

      for (const s of services) accumulate(s.name, s.lanes ?? ["logs"], s.identitySource);
      // The traces lane has no app-name column, so a span producer is always named by
      // its OTLP resource — `resource` is a fact here, not an assumption.
      for (const s of traceOnly) accumulate(s.name, ["traces"], "resource");
    }
  } finally {
    await client.close().catch(() => {});
  }

  // --- cross-lane attribution (the FALLBACK) ---------------------------------
  // Some services name themselves on their SPANS but not on their LOG rows, so
  // their logs land under `unknown_service:dotnet` while their span rows carry a
  // real service name. Observed live: `Bmw.Teleservices.V3.Api` has no log
  // contexts of its own, yet `Bmw.Teleservices.V3.Api.Services.*` appears in the
  // logs under `unknown_service:dotnet`.
  //
  // This is a NAME-PREFIX guess, and it is now the second choice, not the first.
  // The server resolves those rows directly via the app-name field, so a service
  // whose logs carry one arrives here with its own `appContexts` already populated
  // and the `continue` below skips it. What is left is the case the enricher cannot
  // cover: a span producer whose log rows carry neither a real `service_name` nor an
  // app name — only a namespace that happens to start with the service's name.
  //
  // Keeping it matters because the guess is wrong whenever an app's assembly name is
  // not a prefix of every namespace it logs from. A Clean-Architecture host
  // (`X.Web` logging from `X.Web.*`, `X.Application.*`, `X.Infrastructure.*`) matched
  // one root and orphaned three — which is why it must never outrank a measurement.
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
      // How the name was established, measured rather than inferred: `resource` =
      // the OTLP resource carried it, `enricher` = it came from the app-name field
      // because the emitter never set service.name, `mixed` = both paths at once,
      // which is the ordinary state for a .NET app here and marks a service that
      // loses rows to any query using service_name alone.
      identitySource: identitySourceOf(entry.identitySources),
      // Which signal this entry is actually grounded in, strongest first. A caller
      // can then tell "points at first-party code" from "we only know what libraries
      // it uses", which the flat set of fields never said.
      identifiedBy: identifiedByOf(entry),
      environments: [...entry.environments].sort()
    };
    // Several application namespace roots under ONE service name means one of two
    // very different things, and saying the wrong one misdirects the reader:
    //  - on the shared sentinel entry it is several apps that never set service.name;
    //  - on a real service it is just a layered app (Web/Application/Infrastructure),
    //    which is normal and needs no warning at all.
    // Before identity resolution these were indistinguishable, so every multi-root
    // entry got the alarming note. Now only the unnamed bucket earns it.
    if (entry.namespaceRoots.length > 1 && isSentinelName(name)) {
      recognizeBy.note =
        "Not one service: these are the apps that never set OTel service.name AND carry no application-name field, so nothing can name them. Attribute rows by namespaceRoots.";
    }
    if (entry.logsUnder) {
      recognizeBy.logsUnder = entry.logsUnder;
      recognizeBy.borrowedContexts = entry.borrowedContexts;
      recognizeBy.note = `Point-in-time observation, re-test with \`npm run catalog:verify\`: at capture this service had no log rows under its own name. Its logs were attributed by namespace prefix under service_name ${entry.logsUnder
        .map((s) => `"${s}"`)
        .join(" / ")}; search there and filter by sourceContext starting "${name}.".`;
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
    note:
      "`recognizeBy` is derived from logs and is rewritten on every refresh. `code` is hand-verified and preserved — edit it freely. " +
      "`identifiedBy` ranks the evidence: namespace (names the owning code) > context (names the emitting class) > framework (names only the kind of app) > serviceNameOnly. " +
      "`identitySource` says how the service was NAMED: resource (the OTLP resource carried it), enricher (recovered from the application-name field because the emitter never set service.name), mixed (both paths at once — the ordinary state for a .NET app here, and the marker of a service that loses rows to any query using service_name alone). " +
      "`logsUnder` and `note` are point-in-time observations, not durable facts: re-test them with `npm run catalog:verify`.",
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

  const byEvidence = {};
  for (const n of currentNames) {
    const key = services[n].recognizeBy.identifiedBy ?? "serviceNameOnly";
    byEvidence[key] = (byEvidence[key] ?? 0) + 1;
  }
  const enricherNamed = [...currentNames].filter((n) =>
    ["enricher", "mixed"].includes(services[n].recognizeBy.identitySource)
  );

  console.log(`\nWrote ${path.relative(SERVER_DIR, CATALOG_FILE)} — ${currentNames.size} services, ${WINDOW} window.`);
  console.log(`  ${identified.length}/${currentNames.size} have a usable recognition signal.`);
  console.log(
    `  identifiedBy: ${Object.entries(byEvidence)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`
  );
  // Not a warning — these are services the resolution RECOVERED. Naming them is how
  // you see the emitter-side backlog shrink between captures.
  if (enricherNamed.length > 0) {
    console.log(`  named via the application-name field (emitter never set service.name): ${enricherNamed.join(", ")}`);
  }
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

// ---------------------------------------------------------------------------
// --verify: re-test the committed file's ASSERTIONS against live data
// ---------------------------------------------------------------------------

/**
 * The cheap half of a refresh, and the half that actually rots.
 *
 * A full capture is one query per environment plus a per-service second pass; this is
 * ONE `discover_services` call per environment, because every assertion in the file is
 * about which lane a service appears in and under what name — all of which one
 * inventory answers for every entry at once.
 *
 * Contradictions, not staleness:
 *  - `logsUnder` says "no log rows under its own name". If the service is now in the
 *    logs inventory under its own name, the instruction sends a reader to the wrong
 *    bucket. This is the exact failure that motivated the check.
 *  - `lanes: ["traces"]` says "emits no log rows at all". Same test, opposite claim.
 *  - `identitySource` drift is REPORTED, never failed. Two reasons. It is compared
 *    against the per-ENVIRONMENT capture, not `recognizeBy.identitySource`, which is
 *    merged across environments — a service fixed in dev but not prod merges to
 *    `mixed`, and testing that against one environment's live value contradicts
 *    itself by construction (the first run of this check did exactly that for
 *    `CommunicationHub.Web`). And even correctly compared it is a weak signal: a
 *    window is a sample, so a service whose Serilog-sink rows are sparse can read
 *    `resource` in one window and `mixed` in the next with nothing having changed.
 *    Failing on that would make the check cry wolf, and a gate people learn to
 *    ignore is worse than no gate.
 *
 * A service that has simply gone quiet is NOT a contradiction either — absence over
 * one window proves nothing, and treating it as an error would make this fail on
 * every idle dev environment. Only a claim proved FALSE counts.
 */
async function verify() {
  const catalog = readCatalog();
  if (!catalog) {
    console.error(`MISSING ${path.relative(SERVER_DIR, CATALOG_FILE)} — run \`npm run catalog:refresh\`.`);
    process.exit(1);
  }

  const client = await openServer("catalog-verify");
  const contradictions = [];
  /** identitySource changes: informational, never a failure — see the note above. */
  const drifted = [];
  let checked = 0;

  try {
    const envList = await callTool(client, "list_environments", { profile: "standard" });
    const envNames = (envList.environments ?? []).map((e) => e.name);
    const window = typeof catalog.window === "string" && catalog.window.trim() !== "" ? catalog.window : "7d";
    console.log(`Re-testing ${Object.keys(catalog.services ?? {}).length} entries over ${window} in: ${envNames.join(", ")}`);

    for (const envName of envNames) {
      const live = await callTool(client, "discover_services", {
        environment: envName,
        time: window,
        limit: 200,
        lane: "both",
        profile: "standard"
      });

      const logNames = new Map((live.services ?? []).map((s) => [s.name, s]));
      const traceNames = new Set((live.traceOnlyServices ?? []).map((s) => s.name));
      const seenLive = logNames.size > 0 || traceNames.size > 0;
      if (!seenLive) {
        console.log(`  ${envName}: no services in the window — skipped (nothing to contradict).`);
        continue;
      }

      // The per-environment half of the capture. `recognizeBy` is merged across
      // environments and cannot answer "what did THIS environment look like".
      const capturedHere = new Map(
        ((catalog.environments ?? {})[envName]?.services ?? []).map((s) => [s.name, s])
      );

      for (const [name, entry] of Object.entries(catalog.services ?? {})) {
        const recognizeBy = entry?.recognizeBy ?? {};
        // Only test entries the capture actually observed in THIS environment.
        if (!(recognizeBy.environments ?? []).includes(envName)) continue;
        checked += 1;
        const liveRow = logNames.get(name);

        if ((recognizeBy.logsUnder ?? []).length > 0 && liveRow) {
          contradictions.push(
            `${envName}: "${name}" claims logsUnder ${JSON.stringify(recognizeBy.logsUnder)}, but it now has ` +
              `${liveRow.logCount} log rows under its own name. The note sends readers to the wrong bucket.`
          );
        }
        if ((recognizeBy.lanes ?? []).join() === "traces" && liveRow) {
          contradictions.push(
            `${envName}: "${name}" claims lanes ["traces"] (no log rows), but it now emits ${liveRow.logCount} log rows.`
          );
        }
        // Compared against what THIS environment recorded, and only ever reported.
        const capturedSource = capturedHere.get(name)?.identitySource ?? null;
        if (liveRow?.identitySource && capturedSource && liveRow.identitySource !== capturedSource) {
          drifted.push(
            `${envName}: "${name}" identitySource ${capturedSource} → ${liveRow.identitySource}` +
              (liveRow.identitySource === "resource"
                ? " (the emitter now sets service.name — a fix landed)"
                : liveRow.identitySource === "enricher"
                  ? " (all rows now need the app-name field to be named)"
                  : " (rows arriving down BOTH OTLP paths — the ordinary state)")
          );
        }
      }
    }
  } finally {
    await client.close().catch(() => {});
  }

  for (const d of drifted) console.log(`  IDENTITY-DRIFT ${d}`);
  if (contradictions.length === 0) {
    console.log(`\nOK     ${checked} entry-environment assertions still hold.`);
    if (drifted.length > 0) {
      console.log(`       ${drifted.length} identitySource change(s) reported above — informational, refresh when convenient.`);
    }
    return;
  }
  console.error(`\nCONTRADICTED ${contradictions.length} of ${checked} assertions in ${path.relative(SERVER_DIR, CATALOG_FILE)}`);
  for (const c of contradictions) console.error(`  - ${c}`);
  console.error("\n→ run `npm run catalog:refresh` to re-derive the file.");
  process.exit(1);
}

if (CHECK) {
  runCheck();
} else if (VERIFY) {
  await verify();
} else {
  await refresh();
}
