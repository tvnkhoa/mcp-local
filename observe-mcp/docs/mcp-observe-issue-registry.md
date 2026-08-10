# MCP Observe — Issue & Enhancement Registry

Findings, defects, and enhancement proposals for the `observe-mcp` server
(`D:\1.SourceCode\mcp-local\observe-mcp`), raised from consuming repos (primarily
`wec.communication-hub`). Each entry: Scenario · Tool/query · Expected vs actual · Root cause ·
Impact · Repro · Proposal. Mirrors the format of
`postgres-mcp/docs/mcp-postgres-issue-registry.md` and
`codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md`.

> Consuming repos document day-to-day usage in their own skills/CLAUDE.md. This file tracks server
> behaviour and gaps so the MCP team can triage at the source.

---

## Index

**4 entries — all resolved 2026-08-10**, filed the same day from `wec.communication-hub` while fixing
that service's missing OTLP `service.name` on the log pipeline. They shared one root observation:
**the catalog and the live discovery path treated `service_name` as the sole identity field, but on
these OpenObserve orgs `service_name` identifies only ~81% of log rows, and the field that identifies
the rest (`applicationname`) was never read by the server.**

| ID | Title | Kind | Status |
|---|---|---|---|
| `OBS-CAT-001` | `logsUnder` prefix heuristic attributes 4 of 3,504 rows for CommunicationHub.Web | defect | ✅ fixed |
| `OBS-CAT-002` | Server never reads `applicationname` — no second-tier identity resolution | enhancement | ✅ fixed |
| `OBS-CAT-003` | Catalog asserts lane facts that rot silently when a consumer fixes `service.name` | defect | ✅ fixed |
| `OBS-CAT-004` | Identification hints unranked; 5 entries carry no code link at all | enhancement | ✅ fixed (ranking); code links remain a manual TODO |

### What was built

`services/identity.ts` is the single place that knows about the two emission paths. Every logs query
resolves `COALESCE(NULLIF(service_name, '<sentinel>'), NULLIF(applicationname, ''), service_name)`;
traces stay on `service_name` because that stream has no such column and DataFusion rejects an
unknown column at *plan* time. A logs stream that lacks the column downgrades on first use and is
remembered, so no deployment is required to carry the field. Two new env vars —
`OBSERVE_APP_NAME_FIELD`, `OBSERVE_UNKNOWN_SERVICE_SENTINEL` — make the rule configurable and
switchable-off; blanking either restores the old behaviour exactly.

The third `COALESCE` arm is what keeps `service:"unknown_service:dotnet"` meaningful: a row that
nothing can name resolves back to the sentinel, so that query still addresses exactly the
unresolvable remainder without a special case anywhere.

### Correction to the *Shared evidence* below: the partition is per-row, not per-service

The table below is accurate about ROWS and was read too strongly about SERVICES. Verifying the fix
live showed almost every service reporting `identitySource: "mixed"` — rows on both sides of that
"mutually exclusive" partition. That is not a contradiction and not a rollout artifact: a .NET app
here runs **both** emission paths simultaneously, so its OTel-provider rows are named correctly
while its Serilog-sink rows are not. In one hour on `wecrm_al_prod`, `CRM.Gateway` emitted 15,528
rows through the SDK provider and 3,836 through the Serilog sink.

`mixed` is therefore the ordinary state, and the operationally useful one — it marks exactly the
services that lose rows to a query using `service_name` alone. The scale of what was being missed,
same window, same environment:

| | `groupBy:"serviceRaw"` (old) | `groupBy:"service"` (now) |
|---|---|---|
| largest bucket | `unknown_service:dotnet` — 22,569 | `CRM.Gateway` — 19,677 |
| `CRM.Gateway` | 15,756 | 19,677 (+3,921 recovered) |

### Verified live after the fix (2026-08-10, both environments)

- `search_logs(service:"CommunicationHub.Web", environment:"wecrm_au_prod_al")` → rows, with
  `identity.resolved: true`. **Was 0.** The rows come from
  `CommunicationHub.Infrastructure.BackgroundJobs.*` — one of the three namespace roots OBS-CAT-001
  reported as orphaned.
- `log_stats(groupBy:"service")` → the sentinel is gone from the top of the table;
  `groupBy:"serviceRaw"` still reproduces the old view exactly.
- `discover_services(service:"CommunicationHub.Web", include:["codeLinks"])` on prod → its
  `CommunicationHub.Infrastructure` and `CommunicationHub.Application` contexts now attach to its
  own entry, not to the sentinel's.
- `get_trace_spans` unchanged: the traces lane still queries `service_name` only.

### The re-capture (`npm run catalog:refresh`, both environments, 7d)

**`unknown_service:dotnet` no longer exists as a catalog entry** — it is the only name *gone since
the last capture*. Thirty-eight services were named through the app-name field, and three that had
been hidden inside the shared bucket appeared as services in their own right:
`Bmw.Teleservices.V3.DailyNormalizeJob`, `IdentityActivityJob`, `TaskReminderJob`. The file went
from 42 entries to 44, all 44 with a usable recognition signal, `identifiedBy`: namespace 32,
framework 12.

`npm run catalog:verify` then passed: **75 entry-environment assertions, 0 contradicted.**

Its first run did not, and the failure was the check's own: it compared the catalog's
`recognizeBy.identitySource` — which is merged *across* environments — against a single
environment's live value. `CommunicationHub.Web` merges to `mixed` precisely because the emitter
fix has reached `ssdev_au` and not prod, so the comparison contradicted itself by construction.
Verify now reads the per-environment capture, and treats identitySource drift as informational
rather than a failure: a window is a sample, so a service with sparse Serilog-sink rows can read
`resource` in one window and `mixed` in the next without anything having changed.

One incidental fix, because it blocked the refresh outright: the script now inherits OBSERVE_*
from the agent registration when the shell has none (read-only, values never printed, several
registrations refused rather than merged). By workspace convention those values live in
`~/.claude.json`, so a plain terminal could not run `catalog:refresh` at all without re-exporting
secrets by hand.

> ID prefixes: `CAT` service catalog / discovery attribution.

### Shared evidence — the two log paths

Measured on `wecrm_au_prod_al` (`wecrm_al_prod`), 1h window, 2026-08-10:

| | has `applicationname` | no `applicationname` |
|---|---|---|
| `service_name` = a real name | **0** | 170,938 |
| `service_name` = `unknown_service:dotnet` | 39,903 | **0** |

A clean, mutually exclusive partition — two emission paths in the same .NET processes:

- **OTel SDK `ILogger` provider** → carries the SDK resource, so `service_name` is right; carries no
  Serilog enricher, so `applicationname` is absent.
- **Serilog OTLP sink** (`Serilog.Sinks.OpenTelemetry`) → builds its **own** resource. If the app does
  not set `options.ResourceAttributes["service.name"]`, the sink falls back to the spec default
  `unknown_service:dotnet`; the Serilog enricher supplies `applicationname` instead.

Distinct-value counts over the same window: **26** `applicationname` vs **28** `service_name` vs 128
`instrumentation_library_name`. Neither identity field is a superset of the other.

**The traces stream has no `applicationname` column at all** (`describe_stream(type:"traces")` →
25 fields: `service_name`, `service_environment`, `service_aspnetcore_namespace`,
`service_service_instance_id`, `service_telemetry_sdk_*`, …). So re-keying the catalog on
`applicationname` is not an option — it would drop the whole traces lane. The fix is a **resolution
rule**, not a new key:

```sql
COALESCE(NULLIF(service_name, 'unknown_service:dotnet'), applicationname)  -- logs
service_name                                                              -- traces
```

Note the third quadrant now exists: once a service sets `service.name` on its Serilog sink, its rows
carry **both** fields (verified on `ssdev_au` after the CommunicationHub fix deployed 2026-08-10 —
599 rows with `service_name='CommunicationHub.Web'` *and* `applicationname='CommunicationHub.Web'`).
Any rule added must stay correct for all three quadrants.

---

## OBS-CAT-001 — `logsUnder` prefix heuristic attributes 4 of 3,504 rows for CommunicationHub.Web

- **Status:** ✅ fixed 2026-08-10. Filed the same day.
- **Resolution:** the prefix match is no longer the primary attribution. `discover_services`
  groups `include:["codeLinks"]` by the resolved identity, so all four of CommunicationHub's
  namespace roots land on its own entry instead of one matching root and three orphans. The
  heuristic in `scripts/refresh-catalog.mjs` survives as the documented fallback for the case the
  enricher cannot cover — a span producer whose log rows carry neither a real `service_name` nor an
  app name, e.g. `Bmw.Teleservices.V3.Api` — and its `continue` guard already skips any service the
  measurement has covered. The generated note now says it is a point-in-time observation and names
  `catalog:verify`.
- **Scenario:** An agent asks the catalog where a service's logs live, then follows the instruction.
- **Tool/query:** `discover_services(source:"catalog")` → entry `CommunicationHub.Web`.
- **Expected vs actual:** Expected a filter that reaches the service's logs. Actual, verbatim from the
  committed artifact:

  ```json
  "namespaceRoots": [],
  "logsUnder": ["unknown_service:dotnet"],
  "appContextCount": 3,
  "note": "This service names itself on spans but not on log rows: search logs under service_name
           \"unknown_service:dotnet\" and filter by sourceContext starting \"CommunicationHub.Web.\"."
  ```

  That filter reaches **0.1%** of the service's logs.

- **Root cause:** `scripts/refresh-catalog.mjs:352-375` derives `logsUnder` by prefix-matching a
  service's **own name** against the sourceContexts owned by other services
  (`if (!ctx.startsWith(\`${name}.\`)) continue;`). It assumes *assembly/service name is a prefix of
  every namespace the app logs from*. That holds for `Bmw.Teleservices.V3.Api.*` (the case it was
  written against) and breaks for any Clean-Architecture layout where the host assembly is one of
  several namespace roots.

  CommunicationHub.Web logs from `CommunicationHub.Web.*`, `CommunicationHub.Application.*`,
  `CommunicationHub.Infrastructure.*`, and `SSNet.CommunicationHub.*` — one process, four roots, only
  the first matching the heuristic. The other three stay attributed to the `unknown_service:dotnet`
  entry, which lists `CommunicationHub.Infrastructure`, `CommunicationHub.Application` and
  `CommunicationHub.Web` among its 27 `namespaceRoots`. **The Hub is split across two catalog entries
  and neither is complete.**

- **Impact:** an agent following the note investigates the wrong 0.1% and concludes the service is
  quiet. This is the failure mode the catalog exists to prevent.

- **Repro** (`wecrm_au_prod_al`, 6h):

  ```sql
  SELECT CASE WHEN instrumentation_library_name LIKE 'CommunicationHub.Web.%'
              THEN 'matches_servicename_prefix' ELSE 'orphaned_to_unknown_entry' END AS bucket,
         count(DISTINCT instrumentation_library_name) AS distinct_ctx, count(*) AS rows
  FROM "wecrm_al_prod" WHERE applicationname = 'CommunicationHub.Web' GROUP BY 1
  ```

  → `matches_servicename_prefix`: **1 context, 4 rows** · `orphaned_to_unknown_entry`: **16 contexts,
  3,500 rows**.

- **Proposal:** replace the prefix heuristic with the direct owner label where it exists — group the
  unknown bucket by `applicationname` and attribute every context in that group to the named service
  (see `OBS-CAT-002`). Keep the prefix match as the fallback for rows where `applicationname` is
  absent. Both signals are one `GROUP BY` away in the same capture query, so this costs no extra
  round-trip.

---

## OBS-CAT-002 — Server never reads `applicationname`; no second-tier identity resolution

- **Status:** ✅ fixed 2026-08-10. Filed the same day.
- **Resolution:** all four proposal points shipped, with one deliberate difference from point 1.
  Rather than adding a `resolvedService` field alongside `service_name`, the resolved value **is**
  the service everywhere on the logs lane — a second field would have left every existing caller on
  the broken one. `identitySource` (`resource` | `enricher` | `mixed`) rides along in the same
  `GROUP BY` on `discover_services`, and every response echoes an `identity` block saying whether
  resolution was applied and why not when it was not. `log_stats(groupBy:"serviceRaw")` is the new
  escape hatch for the pre-resolution view. Point 4 was honoured: the catalog is still keyed on
  `service_name`, and the app name is a resolution rule, not a key.
- **Scenario:** Any tool that answers "which service is this row from?".
- **Tool/query:** `discover_services` (live and catalog), `search_logs(service:)`, `log_stats(groupBy:"service")`.
- **Expected vs actual:** Expected each log row to resolve to an owning app. Actual: rows on the
  Serilog path resolve to `unknown_service:dotnet` — 39,903 of 210,841 rows/hour on prod, ~19% —
  even though every one of them carries an unambiguous `applicationname`.

  ```
  grep -rn "applicationname" src scripts skill docs README.md   →  no matches
  ```

  The field is not referenced anywhere in the server.

- **Root cause:** design predates the observation that the org runs two OTLP log paths (see *Shared
  evidence*). `service_name` was reasonably assumed to be the identity field.

- **Impact:**
  - `discover_services` reports `unknown_service:dotnet` as the **largest service** in the org
    (1.42M logs/24h on prod) when it is 25+ apps in a trench coat.
  - `search_logs(service:"CommunicationHub.Web")` returned **0 rows** while the service was the
    largest span producer in the org (6.17M spans/24h) — the symptom that started this investigation.
  - `log_stats(groupBy:"service")` mixes real services with the shared bucket, so per-service
    error/warn counts are wrong for every app on the Serilog path.

- **Proposal:**
  1. Add a derived `resolvedService` = `COALESCE(NULLIF(service_name,'unknown_service:dotnet'), applicationname)`
     to the logs lane, plus `identitySource: "resource" | "enricher" | "namespace"` so a caller can
     see how the attribution was made and how much to trust it. Traces stay on `service_name`
     (`identitySource:"resource"`) — the column does not exist there.
  2. Let `search_logs(service:)` and `log_stats(groupBy:"service")` match on the resolved value, so
     one query works whether or not the target app has been fixed yet.
  3. Record `recognizeBy.appNames[]` in the catalog as a **second-tier hint**, not a key. In the
     unknown bucket it is the fastest single-field filter and it is never null there (verified: 0 rows
     with `service_name='unknown_service:dotnet'` and no `applicationname`).
  4. **Do not re-key the catalog on `applicationname`** — 26 distinct values vs 28, absent from the
     traces stream entirely, and it is a Serilog enricher property rather than an OTLP resource
     attribute. Re-keying would entrench the emitter-side bug instead of routing around it.

- **Consumer-side note:** the emitter fix is small and worth propagating — set
  `options.ResourceAttributes["service.name"]` in the `WriteTo.OpenTelemetry(...)` callback, or export
  `OTEL_RESOURCE_ATTRIBUTES` at the deployment layer so both paths pick it up. CommunicationHub did
  the former (`wec.communication-hub@ac968a1`, `src/Web/Infrastructure/OtelResource.cs`); the resolved
  identity above is what keeps the tooling correct for every service that has not.

---

## OBS-CAT-003 — Catalog asserts lane facts that rot silently when a consumer fixes `service.name`

- **Status:** ✅ fixed 2026-08-10. Filed the same day, with a live example the same day.
- **Resolution:** lane/attribution facts are now derived from the quadrant measurement
  (`identitySource`) rather than the name-prefix scan, so the statement is what was observed. A new
  `npm run catalog:verify` re-tests only the assertions — one `discover_services` call per
  environment answers every entry at once — and exits non-zero on a contradiction. A service in
  both quadrants is reported as `TRANSITIONING`, not forced to one side, and is not treated as a
  failure: that is a rollout in flight, which is exactly when someone is mid-fix.
  `catalogFreshness` now carries an unconditional `assertionsNote`, because gating it on age is the
  bug — the capture that misled was zero days old.
- **Scenario:** A consuming team fixes its service's `service.name`; the committed catalog keeps
  telling agents the old story.
- **Tool/query:** `discover_services(source:"catalog")`.
- **Expected vs actual:** Catalog `capturedAt: 2026-08-10T06:04:22Z`, `ageDays: 0` — reported as
  fresh. By 09:38Z the same day, four of its assertions about `CommunicationHub.Web` were false:

  | Field | Catalog says | Live (`ssdev_au`, post-deploy) |
  |---|---|---|
  | `lanes` | `["traces"]` | logs **and** traces |
  | `logsUnder` | `["unknown_service:dotnet"]` | its own `service_name` |
  | `note` | "names itself on spans but not on log rows" | it now names itself on both |
  | `namespaceRoots` | `[]` | `CommunicationHub.{Web,Application,Infrastructure}` |

  The `unknown_service:dotnet` entry likewise still lists the three `CommunicationHub.*` roots.

- **Root cause:** these are point-in-time observations written as durable facts
  (`refresh-catalog.mjs:396-401`), and freshness is judged by capture **age** only
  (`src/tools/discovery.ts:176-190`), not by whether the assertions still hold.

- **Impact:** the failure is silent and inverted — the staler the artifact, the more confident the
  note. An agent reading a 0-day-old catalog is told to search a bucket the service has just left.

- **Proposal:**
  1. Derive lane/attribution facts from the quadrant matrix at capture time (`service_name` named ·
     `applicationname` present) rather than from the name-prefix scan, so the statement is a
     measurement rather than a claim.
  2. Add a cheap `catalog:check`-style probe that re-tests only the *assertions* (one grouped query
     per environment: does this service still have 0 rows under its own name?) and flags contradicted
     entries. Much cheaper than a full refresh and it is the thing that actually rots.
  3. When a service appears in **both** quadrants — mid-rollout, exactly what CommunicationHub looked
     like for ~20 seconds — say so instead of picking one, e.g.
     `"transitioning: rows under both service_name and unknown_service:dotnet"`.
  4. Re-run `npm run catalog:refresh` for both environments once CommunicationHub's fix reaches prod.

---

## OBS-CAT-004 — Identification hints unranked; 5 entries carry no code link

- **Status:** ✅ fixed 2026-08-10 for the ranking. The five missing `code` links remain open as a
  manual task — see *Remaining* below. Filed the same day.
- **Resolution:** every catalog entry now carries
  `identifiedBy: "namespace" | "context" | "framework" | "serviceNameOnly"`, the artifact's
  top-level `note` states what the precedence means, and `catalog:refresh` prints the distribution
  so a weakening trend is visible between captures. `discover_services` keeps the field at every
  profile — it is one scalar and it is what tells a caller whether an entry points at first-party
  code or was inferred from libraries.
- **Scenario:** An agent needs to describe an unfamiliar service, or map a log row to a repo.
- **Tool/query:** `discover_services(include:["codeLinks"])`.
- **Expected vs actual:** Entries expose `namespaceRoots`, `appContexts`, `frameworkHints` and `code`
  as a flat set, with no stated precedence. In practice their evidential value is strictly ordered —
  `namespaceRoots` (names the owning code) > `appContexts` (names the emitting class) >
  `frameworkHints` (names only the *kind* of app: Ocelot → gateway, Elsa/Rebus → workflow engine,
  Quartz → has scheduled jobs). Five entries fall back to `frameworkHints` alone with an empty
  `code: {}`: `CRM.Notification`, `CRM.NotificationHub.Api`, `wec.ape-logo-sync`, `wecsocialads-api`,
  `whatsapp-api`.
- **Impact:** low — nothing is wrong, the description is just weaker than it could be. Listed so the
  gap is visible next to the entries that matter.
- **Proposal:** state the ranking in the artifact (`identifiedBy: "namespace" | "context" | "framework"`)
  so a caller knows whether a description is grounded in first-party code or inferred from libraries;
  and resolve the five missing `code` links, which likely live outside the `wec.be` repo the matcher
  scans.

---

## Remaining

Two items survive the fix. Neither is a code change.

- **Eight entries have an empty `code: {}`** — up from five, because the re-capture surfaced three
  services that had been invisible inside the sentinel bucket. The original five:
  `CRM.Notification`, `CRM.NotificationHub.Api`, `wec.ape-logo-sync`, `wecsocialads-api`,
  `whatsapp-api`; newly visible: `Bmw.Teleservices.V3.DailyNormalizeJob`, `IdentityActivityJob`,
  `TaskReminderJob`. The `code` block is hand-verified and preserved across refreshes by design, so
  no capture will ever fill it. The first five most likely live outside the `wec.be` repo the
  matcher scans; `bitbucket-mcp list_repositories` and a name match is the cheapest way in. Filling
  them is safe at any time — edit `docs/service-catalog.json` directly and a refresh keeps what you
  wrote.
- **`CommunicationHub.Web`'s emitter fix has not reached prod.** The capture measures it as
  `enricher` on `wecrm_au_prod_al` and `mixed` on `ssdev_au`, i.e. every prod log row is still
  named only via `applicationname`. Nothing is broken — resolution covers it — but the consumer-side
  note in OBS-CAT-002 still applies to prod, and a refresh after that deploy will flip it to
  `resource`/`mixed`.

## Provenance

All measurements in this file were taken with `observe-mcp` itself against
`wecrm_au_prod_al` (`wecrm_al_prod`) and `ssdev_au` (`wecrm_easyserv_dev`) on 2026-08-10, while
diagnosing and fixing the missing `service.name` on CommunicationHub's Serilog OTLP sink
(`wec.communication-hub@ac968a1`). Every query is reproducible read-only and is quoted in the entry
that relies on it.
