import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyNamespace, frameworkHints, namespaceRoot, nonFrameworkNamespaceRoots } from "./namespaces.js";

const PREFIXES = {
  appNamespacePrefixes: ["CRM.", "SS.", "CommunicationHub.", "WecSocialAds."],
  frameworkNamespacePrefixes: ["Microsoft.", "System.", "Ocelot", "Rebus"]
};

test("framework plumbing is classified as framework, application code as app", () => {
  // These four are the actual highest-volume contexts in the live streams. Ranked
  // by count they crowd out everything that identifies code, which is why the
  // classification exists at all.
  assert.equal(classifyNamespace("Microsoft.AspNetCore.Hosting.Diagnostics", PREFIXES), "framework");
  assert.equal(classifyNamespace("Microsoft.EntityFrameworkCore.Database.Command", PREFIXES), "framework");
  assert.equal(classifyNamespace("CRM.Report.Application.Common.Behaviours.ResponseCachingBehaviour", PREFIXES), "app");
  assert.equal(classifyNamespace("CommunicationHub.Infrastructure.Identity.IdentityService", PREFIXES), "app");
});

test("a third-party library is framework, not app", () => {
  // Ocelot and Rebus survive a naive "not Microsoft" filter and would otherwise
  // read as first-party code.
  assert.equal(classifyNamespace("Ocelot.Authentication.Middleware.AuthenticationMiddleware", PREFIXES), "framework");
  assert.equal(classifyNamespace("Rebus.Retry.ErrorTracking.InMemErrorTracker", PREFIXES), "framework");
});

test("an unrecognized namespace is unclassified, never silently dropped", () => {
  // Usually a new application namespace nobody has added to the prefix list yet.
  // Reporting it is how it gets noticed.
  assert.equal(classifyNamespace("Bmw.Teleservices.V3.Infrastructure.Services.SftpService", PREFIXES), "unclassified");
  assert.equal(classifyNamespace("AutomationTelemetryCollector", PREFIXES), "unclassified");
});

test("app prefixes win over framework prefixes on an overlap", () => {
  const overlapping = {
    appNamespacePrefixes: ["Contoso.Ocelot."],
    frameworkNamespacePrefixes: ["Contoso."]
  };
  assert.equal(classifyNamespace("Contoso.Ocelot.Gateway", overlapping), "app");
});

test("namespaceRoot keeps two segments, or one when that is all there is", () => {
  assert.equal(namespaceRoot("CRM.Report.Application.Common.Behaviours.X"), "CRM.Report");
  assert.equal(namespaceRoot("SS.Identity.Api.Controllers.Y"), "SS.Identity");
  assert.equal(namespaceRoot("AutomationTelemetryCollector"), "AutomationTelemetryCollector");
  assert.equal(namespaceRoot(""), "");
});

test("nonFrameworkNamespaceRoots takes apart a service that is really several apps", () => {
  // This is `unknown_service:dotnet` — the largest bucket in both live
  // environments, and every app that failed to set OTel service.name. The only
  // way to tell them apart is the namespace of the emitting context.
  const contexts = [
    { name: "Microsoft.AspNetCore.Hosting.Diagnostics", count: 900_000 },
    { name: "CommunicationHub.Infrastructure.BackgroundJobs.OutboundCallbackSlaMonitorWorker", count: 10_119 },
    { name: "CommunicationHub.Infrastructure.Identity.IdentityAuthorizationClient", count: 7_384 },
    { name: "Bmw.Teleservices.V3.Infrastructure.Services.SftpService", count: 6_092 },
    { name: "CRM.Report.Application.Common.Behaviours.ResponseCachingBehaviour", count: 4_140 }
  ];
  assert.deepEqual(nonFrameworkNamespaceRoots(contexts, PREFIXES), [
    "CommunicationHub.Infrastructure",
    "Bmw.Teleservices",
    "CRM.Report"
  ]);
});

test("nonFrameworkNamespaceRoots keeps unclassified roots but drops framework noise", () => {
  const contexts = [
    { name: "Microsoft.AspNetCore.Routing.EndpointMiddleware", count: 500_000 },
    { name: "System.Net.Http.HttpClient", count: 400_000 },
    { name: "AutomationTelemetryCollector", count: 31_996 }
  ];
  // The framework entries contribute nothing; the unclassified one survives,
  // because suppressing it is how a discovery tool starts lying.
  assert.deepEqual(nonFrameworkNamespaceRoots(contexts, PREFIXES), ["AutomationTelemetryCollector"]);
});

test("frameworkHints answers 'what kind of thing is this service', most used first", () => {
  const contexts = [
    { name: "Ocelot.Authentication.Middleware.AuthenticationMiddleware", count: 122_715 },
    { name: "Ocelot.RateLimit.Middleware.ClientRateLimitMiddleware", count: 122_715 },
    { name: "Microsoft.AspNetCore.Hosting.Diagnostics", count: 952_801 },
    { name: "CRM.Gateway.Something", count: 10 }
  ];
  assert.deepEqual(frameworkHints(contexts, PREFIXES), ["Microsoft", "Ocelot"]);
});
