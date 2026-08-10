/**
 * Classify a log row's source context into application code, framework noise, or
 * neither — the mechanism behind the code↔log link.
 *
 * Serilog's `SourceContext` is exported as the OTLP instrumentation scope name,
 * which for .NET is the fully-qualified type that emitted the row. That makes it
 * the one field in a log record that points at a specific file — but only after the
 * framework plumbing is separated out. Ranked by raw volume, the top contexts in
 * these streams are entirely `Microsoft.AspNetCore.Hosting.Diagnostics`,
 * `Microsoft.AspNetCore.Routing.EndpointMiddleware` and
 * `Microsoft.EntityFrameworkCore.Database.Command`, which identify nothing. With
 * them removed the same field yields
 * `WecSocialAds.Infrastructure.Jobs.LaunchingToLaunchedJob` and
 * `CRM.Report.Application.Common.Behaviours.ResponseCachingBehaviour`.
 *
 * Two design choices worth keeping:
 *
 *  - **`unclassified` is reported, never dropped.** A context matching neither list
 *    is the interesting case: it is usually a new application namespace nobody has
 *    added yet. Silently filtering it is how a discovery tool starts lying.
 *  - **Third-party libraries are `framework`, not `app`.** `Ocelot.*` (the gateway)
 *    and `Rebus.*` (the bus) survive a naive "not Microsoft" filter and would
 *    otherwise look like first-party code. They are still useful as *hints* about
 *    what a service is built from, so callers keep them separately rather than
 *    discarding them.
 */

export type NamespaceClass = "app" | "framework" | "unclassified";

export type NamespacePrefixes = {
  appNamespacePrefixes: string[];
  frameworkNamespacePrefixes: string[];
};

/**
 * App prefixes win over framework prefixes. The order matters for a name that
 * matches both lists (e.g. an app namespace that happens to start with a vendor
 * name): treating it as first-party is the safer failure, because an over-reported
 * app context is visible and correctable while a wrongly-suppressed one is not.
 */
export function classifyNamespace(name: string, prefixes: NamespacePrefixes): NamespaceClass {
  if (prefixes.appNamespacePrefixes.some((p) => name.startsWith(p))) {
    return "app";
  }
  if (prefixes.frameworkNamespacePrefixes.some((p) => name.startsWith(p))) {
    return "framework";
  }
  return "unclassified";
}

/**
 * Reduce a fully-qualified type name to the namespace root used to attribute it to
 * a project: two segments where that is meaningful (`CRM.Report`, `SS.Identity`),
 * one where it is not (`AutomationTelemetryCollector`).
 *
 * Two segments rather than one because the first segment alone is too coarse to be
 * useful here — nearly every service in these systems is under `CRM.`.
 */
export function namespaceRoot(name: string): string {
  const parts = name.split(".").filter((p) => p.length > 0);
  if (parts.length === 0) {
    return name;
  }
  return parts.slice(0, 2).join(".");
}

/**
 * Distinct namespace roots of every context that is NOT framework noise, most
 * frequent first — so app-classified and `unclassified` alike.
 *
 * Including `unclassified` is the point, and the name says so rather than claiming
 * "app": an unclassified root is usually a first-party namespace nobody has added
 * to `OBSERVE_APP_NAMESPACE_PREFIXES` yet, and it is exactly the pointer-to-code a
 * caller is asking for. Dropping it would make this function agree with
 * `appContexts` and lose the roots that matter most.
 *
 * The visible consequence, which is intended: a catalog entry can carry
 * `appContexts: []` alongside a non-empty `namespaceRoots` (`CRM.Notification`,
 * `SS.Identity.Api`, `TenantAnalystJob`). That is a service whose namespace is
 * unclassified, not a bug — do not "fix" it by filtering `unclassified` out here.
 */
export function nonFrameworkNamespaceRoots(
  contexts: Array<{ name: string; count: number }>,
  prefixes: NamespacePrefixes
): string[] {
  const totals = new Map<string, number>();
  for (const ctx of contexts) {
    const cls = classifyNamespace(ctx.name, prefixes);
    if (cls === "framework") {
      continue;
    }
    const root = namespaceRoot(ctx.name);
    totals.set(root, (totals.get(root) ?? 0) + ctx.count);
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([root]) => root);
}

/**
 * The library/framework roots a service leans on — `Ocelot` for the gateway,
 * `Rebus` for the touchpoint worker. Not code to navigate to, but the fastest
 * answer to "what kind of thing is this service".
 */
export function frameworkHints(
  contexts: Array<{ name: string; count: number }>,
  prefixes: NamespacePrefixes
): string[] {
  const totals = new Map<string, number>();
  for (const ctx of contexts) {
    if (classifyNamespace(ctx.name, prefixes) !== "framework") {
      continue;
    }
    // The first segment is the right granularity for a hint: "Microsoft", "Ocelot".
    const root = ctx.name.split(".")[0];
    if (!root) {
      continue;
    }
    totals.set(root, (totals.get(root) ?? 0) + ctx.count);
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([root]) => root);
}
