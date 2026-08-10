import assert from "node:assert/strict";
import { test } from "node:test";

import { createNullLogger } from "@mcp/core";
import { asErrorPayload, createToolRegistry, dispatchToolCall } from "@mcp/sdk";

import type { EnvironmentRegistry, ObserveEnvironment } from "../config/environments.js";
import type { ObserveLimits } from "../config/index.js";
import { ClientManager } from "../services/clientManager.js";
import type { ObserveClient } from "../services/observeClient.js";

import { buildDiscoveryTools, environmentRowsFor, projectCatalogEntry, summarizeEnvironmentCapture } from "./discovery.js";
import { toWireError } from "./index.js";

const ENTRY = {
  code: { repoId: "wec.be", project: "src/services/gateway/CRM.Gateway/CRM.Gateway.csproj" },
  recognizeBy: {
    serviceName: "CRM.Gateway",
    appContexts: ["A.One", "A.Two", "A.Three"],
    borrowedContexts: ["B.One"],
    unclassifiedContexts: ["U.One"],
    namespaceRoots: ["CRM.Gateway"],
    frameworkHints: ["Ocelot"],
    lanes: ["logs", "traces"],
    environments: ["ssdev_au"],
    note: "something worth keeping"
  }
};

test("projectCatalogEntry keeps everything at standard/verbose detail", () => {
  assert.deepEqual(projectCatalogEntry(ENTRY, true), ENTRY);
});

test("projectCatalogEntry drops the long context lists but keeps the summary", () => {
  const trimmed = projectCatalogEntry(ENTRY, false) as Record<string, Record<string, unknown>>;
  // The fields that answer "what is this and where is its code" all survive.
  assert.deepEqual(trimmed.code, ENTRY.code);
  assert.equal(trimmed.recognizeBy.serviceName, "CRM.Gateway");
  assert.deepEqual(trimmed.recognizeBy.namespaceRoots, ["CRM.Gateway"]);
  assert.equal(trimmed.recognizeBy.note, "something worth keeping");
  assert.deepEqual(trimmed.recognizeBy.frameworkHints, ["Ocelot"]);
  // The long ones do not.
  assert.equal(trimmed.recognizeBy.appContexts, undefined);
  assert.equal(trimmed.recognizeBy.borrowedContexts, undefined);
  // But a count remains, so the caller knows detail exists rather than reading the
  // trimmed entry as an empty one.
  assert.equal(trimmed.recognizeBy.appContextCount, 4);
});

test("projectCatalogEntry keeps logsUnder — it is how you find a span-only service's logs", () => {
  const spanOnly = { code: {}, recognizeBy: { serviceName: "X", logsUnder: ["unknown_service:dotnet"] } };
  const trimmed = projectCatalogEntry(spanOnly, false) as Record<string, Record<string, unknown>>;
  assert.deepEqual(trimmed.recognizeBy.logsUnder, ["unknown_service:dotnet"]);
});

test("projectCatalogEntry passes a non-object through untouched", () => {
  assert.equal(projectCatalogEntry(null, false), null);
  assert.equal(projectCatalogEntry(undefined, false), undefined);
});

const CAPTURE = {
  org: "org-1",
  logStream: "logs_x",
  traceStream: "traces_x",
  window: "7d",
  logServiceCount: 2,
  traceOnlyServiceCount: 1,
  services: [
    { name: "CRM.Gateway", logCount: 10, errorCount: 1 },
    { name: "CRM.SMS", logCount: 5, errorCount: 0 }
  ],
  traceOnlyServices: [{ name: "CommunicationHub.Web", spanCount: 99 }]
};

test("summarizeEnvironmentCapture keeps the counts and drops the row arrays", () => {
  const summary = summarizeEnvironmentCapture(CAPTURE) as Record<string, unknown>;
  assert.equal(summary.logServiceCount, 2);
  assert.equal(summary.traceOnlyServiceCount, 1);
  assert.equal(summary.logStream, "logs_x");
  assert.equal(summary.services, undefined);
  assert.equal(summary.traceOnlyServices, undefined);
});

test("environmentRowsFor pulls one service's rows from both lanes", () => {
  const rows = environmentRowsFor(CAPTURE, "CRM.Gateway") as Record<string, unknown>;
  assert.deepEqual(rows.logs, { name: "CRM.Gateway", logCount: 10, errorCount: 1 });
  assert.equal(rows.traces, null);

  const spanOnly = environmentRowsFor(CAPTURE, "CommunicationHub.Web") as Record<string, unknown>;
  assert.equal(spanOnly.logs, null);
  assert.deepEqual(spanOnly.traces, { name: "CommunicationHub.Web", spanCount: 99 });
});

test("environmentRowsFor returns nulls rather than throwing for an absent service", () => {
  const rows = environmentRowsFor(CAPTURE, "nope") as Record<string, unknown>;
  assert.equal(rows.logs, null);
  assert.equal(rows.traces, null);
  assert.equal(environmentRowsFor(null, "x"), null);
});

// ---------------------------------------------------------------------------
// The handler, over a stub client. Nothing here touches the network.
//
// `profile: "standard"` throughout, deliberately: compact drops nullish fields,
// and half of what these tests assert IS a field being null (`stream` on a
// traces-lane call, `truncationNote` when nothing was clipped).
// ---------------------------------------------------------------------------

const CAPS = { message: 2000, exception: 4000 };

const LIMITS: ObserveLimits = {
  defaultSize: 100,
  maxSize: 1000,
  defaultLookbackMs: 3_600_000,
  maxLookbackMs: 604_800_000,
  timeoutMs: 30_000,
  maxRetries: 0,
  logColumns: [],
  fieldCaps: { nano: CAPS, compact: CAPS, standard: CAPS, verbose: CAPS },
  appNamespacePrefixes: ["CRM.", "CommunicationHub."],
  frameworkNamespacePrefixes: ["Microsoft.", "System."]
} as unknown as ObserveLimits;

const TEST_ENV: ObserveEnvironment = {
  name: "test",
  baseUrl: "http://discovery-test.invalid",
  org: "test-org",
  logStream: "test_logs",
  traceStream: "test_traces",
  traceStreamConfigured: true,
  authHeader: "Basic dGVzdA==",
  source: "flat",
  sourceDetail: "test"
};

/** A manager whose client answers the logs lane and the traces lane separately. */
function clientsReturning(
  logRows: Record<string, unknown>[],
  traceRows: Record<string, unknown>[]
): ClientManager {
  const client = {
    search: async (req: { type?: string }) => ({
      hits: req.type === "traces" ? traceRows : logRows,
      took: 1
    }),
    listStreams: async () => []
  } as unknown as ObserveClient;
  const registry: EnvironmentRegistry = {
    environments: new Map([[TEST_ENV.name, TEST_ENV]]),
    defaultEnvironment: TEST_ENV.name
  };
  return new ClientManager(LIMITS, registry, () => client);
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
async function discover(args: Record<string, unknown>, clients: ClientManager): Promise<any> {
  const registry = createToolRegistry(buildDiscoveryTools(LIMITS, clients));
  const result = await dispatchToolCall(registry, "discover_services", args, {
    logger: createNullLogger("test"),
    formatError: (error) => asErrorPayload(toWireError(error), "verbose")
  });
  return JSON.parse(result.content[0]?.text ?? "null");
}

test('lane:"traces" reports the span inventory as services, not serviceCount 0', async () => {
  // The logs lane is never queried, so there is no logs inventory to subtract.
  // Reporting every span producer as "trace-only" left serviceCount at 0, which
  // reads as "nothing emits traces" — the opposite of the truth.
  const payload = await discover(
    { lane: "traces", profile: "standard" },
    clientsReturning([], [{ service_name: "CommunicationHub.Web", span_count: 99 }])
  );

  assert.equal(payload.serviceCount, 1);
  assert.equal(payload.services[0].name, "CommunicationHub.Web");
  assert.deepEqual(payload.services[0].lanes, ["traces"]);
  assert.equal(payload.services[0].spanCount, 99);
  // Nothing is classified trace-only, because that split needs both lanes.
  assert.equal(payload.traceOnlyServiceCount, 0);
  assert.ok(/lane:"both"/.test(payload.laneNote));
  // And the logs stream is not named, because it was not queried.
  assert.equal(payload.stream, null);
  assert.equal(payload.traceStream, "test_traces");
});

test('lane:"traces" still names the logs stream when an include section queried it', async () => {
  const payload = await discover(
    { lane: "traces", include: ["fields"], profile: "standard" },
    clientsReturning([{ level: "info" }], [{ service_name: "X", span_count: 1 }])
  );
  assert.equal(payload.stream, "test_logs");
});

test("a full page of services is reported as truncated, not passed off as complete", async () => {
  const rows = [1, 2, 3].map((i) => ({ service_name: `svc${i}`, log_count: i }));
  const payload = await discover({ lane: "logs", limit: 3, profile: "standard" }, clientsReturning(rows, []));

  assert.equal(payload.serviceCount, 3);
  assert.equal(payload.servicesTruncated, true);
  assert.ok(/higher `limit`/.test(payload.truncationNote));
  assert.equal(payload.limit, 3);
});

test("a partial page is not reported as truncated", async () => {
  const rows = [1, 2].map((i) => ({ service_name: `svc${i}`, log_count: i }));
  const payload = await discover({ lane: "logs", limit: 5, profile: "standard" }, clientsReturning(rows, []));

  assert.equal(payload.servicesTruncated, false);
  assert.equal(payload.truncationNote, null);
});

test("limit may exceed the old hard-coded 200, up to the configured max size", async () => {
  const payload = await discover({ lane: "logs", limit: 500, profile: "standard" }, clientsReturning([], []));
  assert.equal(payload.limit, 500);

  // Past maxSize it is a validation error, not a silent clamp.
  const rejected = await discover({ lane: "logs", limit: 5000 }, clientsReturning([], []));
  assert.equal(rejected.code, "validation_error");
});

test('source:"catalog" names the arguments it could not apply', async () => {
  // Silently dropping them is what made `include:["streams"]` return a response
  // with no `streams` key and no hint that the argument went nowhere.
  const payload = await discover(
    { source: "catalog", include: ["streams"], time: "24h", profile: "standard" },
    clientsReturning([], [])
  );

  // Guard: the assertion below is about the catalog branch, which needs the
  // committed artifact. `catalog:check` is what keeps it present.
  assert.equal(payload.error, undefined, "expected docs/service-catalog.json to be present");
  assert.deepEqual(payload.ignoredArguments, ["time", "include"]);
  assert.ok(/not applied/.test(payload.ignoredArgumentsNote));
});

test('source:"catalog" says nothing about ignored arguments when none were passed', async () => {
  const payload = await discover({ source: "catalog", profile: "standard" }, clientsReturning([], []));
  assert.equal(payload.ignoredArguments, undefined);
  assert.equal(payload.ignoredArgumentsNote, undefined);
});
