/**
 * `observe-mcp`'s environment contract.
 *
 * The per-profile character caps are the bulk of it. They were the S-25 finding that no schema
 * could have revealed — serialization differs by response profile — so they are documented here
 * rather than left to be rediscovered from the config module.
 *
 * The flat `OBSERVE_BASE_URL` / `OBSERVE_ORG` / `OBSERVE_LOG_STREAM` trio stays **required and
 * ungrouped** deliberately, even though `OBSERVE_ENV_*` can now supply the same thing. Two gates
 * depend on it:
 *   - `scripts/contract-snapshot.mjs` skips any field whose name contains `*` and fills only the
 *     first member of each `group`. If the connection were reachable only through the wildcard, or
 *     grouped behind one member, the snapshot server would boot with zero environments and throw.
 *     The flat trio is what `placeholderFor()` can fill.
 *   - `env.ts` excludes group members from `missingRequired`, so grouping them would weaken
 *     `mcp:doctor` into not noticing an install with no connection at all.
 */

import type { EnvField } from "../types.js";

export const observeEnv: readonly EnvField[] = [
  // --- Connection --------------------------------------------------------------
  {
    name: "OBSERVE_BASE_URL",
    required: true,
    section: "Connection",
    prompt: "OpenObserve base URL (query API host)",
    note: "The OpenObserve UI/API host — NOT the OTLP ingest host."
  },
  { name: "OBSERVE_ORG", required: true, section: "Connection", prompt: "Organization identifier", note: "From the OpenObserve URL: org_identifier=…" },
  // No default for either stream: the previous `wecrm_dev` outlived the deployment it was copied
  // from, and because the server also defaulted the host and org, a wrong install silently queried
  // an org that no longer existed instead of failing at startup.
  { name: "OBSERVE_LOG_STREAM", required: true, section: "Connection", prompt: "Log stream name" },
  // NOT required, unlike the trio above: the server falls back to the logs stream name, so an
  // install that omits this works. Marking it required made `mcp:doctor` report a healthy
  // traces-capable install as `missing: OBSERVE_TRACE_STREAM` and had install-mcp warn that the
  // server may fail to start.
  {
    name: "OBSERVE_TRACE_STREAM",
    required: false,
    section: "Connection",
    prompt: "Trace stream name (blank to reuse the logs stream name)",
    note: "Optional. Unset reuses the logs stream NAME, which usually resolves correctly anyway because span queries pass the `traces` stream type and OpenObserve resolves a name within its type — both live environments run this way and return spans. get_trace_spans warns only if that fallback actually returns nothing."
  },

  // --- Auth: one of ------------------------------------------------------------
  {
    name: "OBSERVE_AUTH_BASIC",
    required: false,
    secret: true,
    group: "observe-auth",
    section: "Auth (need EITHER the token OR username+password)",
    prompt: "Pre-encoded Basic token (blank to use username+password)",
    note: "Auth: provide this OR OBSERVE_USERNAME + OBSERVE_PASSWORD. Accepted with or without the \"Basic \" prefix."
  },
  {
    name: "OBSERVE_USERNAME",
    required: false,
    group: "observe-auth",
    section: "Auth (need EITHER the token OR username+password)",
    prompt: "OpenObserve username (if not using OBSERVE_AUTH_BASIC)"
  },
  { name: "OBSERVE_PASSWORD", required: false, secret: true, group: "observe-auth", section: "Auth (need EITHER the token OR username+password)", prompt: "OpenObserve password" },

  // --- Additional environments ---------------------------------------------------
  // Every var here is `codeDefault`, never `default`/`prompt`: per types.ts, either of those makes
  // install-mcp pin the value into ~/.claude.json, and a pinned environment name or allowlist is a
  // filter someone has to discover and undo later.
  {
    name: "OBSERVE_ENV_*",
    prefix: "OBSERVE_ENV_",
    familyExamples: ["OBSERVE_ENV_SSDEV_AU", "OBSERVE_ENV_WECRM_AU_PROD"],
    required: false,
    secret: true,
    section: "Additional environments",
    note:
      "A family, not a literal var name — the trailing underscore is part of the prefix, and the suffix becomes the environment name. Value is a `;`-separated spec: `baseUrl=…;org=…;logStream=…;traceStream=…`, optionally with `username=`/`password=`/`authBasic=` to override the shared credentials for that one environment. Each pair splits on its first `=` only, so a URL survives intact. An unknown key is rejected at startup rather than ignored."
  },
  {
    name: "OBSERVE_PRIMARY_ENV_NAME",
    required: false,
    codeDefault: "default",
    section: "Additional environments",
    note: "Names the environment built from the flat OBSERVE_BASE_URL/ORG/LOG_STREAM trio. Set it when that trio is a real named environment (e.g. `ssdev_au`) rather than an unnamed default."
  },
  {
    name: "OBSERVE_DEFAULT_ENVIRONMENT",
    required: false,
    section: "Additional environments",
    note: "Which environment answers when a tool call omits `environment`. Validated against the configured set — an unknown value falls back to dev, then default, then the first registered, rather than breaking every call."
  },
  {
    name: "OBSERVE_ALLOWED_ENVIRONMENTS",
    required: false,
    section: "Additional environments",
    note: "Comma-separated allowlist. Filters at registration, so a name outside it does not exist in the server at all. Unset = no filtering."
  },

  // --- Discovery -----------------------------------------------------------------
  {
    name: "OBSERVE_APP_NAMESPACE_PREFIXES",
    required: false,
    codeDefault: "CRM.,SS.,SSNet.,WEC,WeCRM.,CommunicationHub.,OSB.,Bmw.,WecSocialAds.",
    section: "Discovery",
    note: "Comma-separated namespace prefixes counted as first-party code when classifying a log row's sourceContext. This is what makes discover_services able to point at the owning project."
  },
  {
    name: "OBSERVE_FRAMEWORK_NAMESPACE_PREFIXES",
    required: false,
    codeDefault: "Microsoft.,System.,Npgsql,MassTransit,Quartz,Hangfire,Serilog,OpenTelemetry,Rebus,Ocelot,Elsa.,Grpc.,Amazon.,AWSSDK,Azure.,Polly,StackExchange.,MediatR,FluentValidation,Refit,IdentityServer,FFmpeg.",
    section: "Discovery",
    note: "Comma-separated prefixes treated as framework/library noise. Necessary because by raw volume the top log scopes are all framework plumbing, which identifies nothing. A context matching neither list is reported as `unclassified`, never dropped."
  },
  // --- Service identity ----------------------------------------------------------
  // These two exist because a .NET process can emit logs down TWO OTLP paths: the OTel
  // SDK's ILogger provider (carries the SDK resource, so `service_name` is right) and a
  // Serilog OTLP sink (builds its own resource and, unless the app sets service.name,
  // falls back to the spec sentinel while a Serilog enricher supplies the real app name
  // in a separate field). Measured on the live orgs: ~19% of log rows/hour arrive on the
  // second path. Without this resolution `search_logs(service:)` returns 0 rows for those
  // apps and `log_stats(groupBy:"service")` reports the sentinel as the largest service.
  {
    name: "OBSERVE_APP_NAME_FIELD",
    required: false,
    codeDefault: "applicationname",
    section: "Service identity",
    note: "Log column holding the application name when the OTLP resource does not (a Serilog enricher property). Used only for LOGS — the traces stream has no such column, and naming an absent column fails the query at plan time, so trace queries always use service_name. A logs stream without this column downgrades automatically on the first query and reports identity.resolved=false."
  },
  {
    name: "OBSERVE_UNKNOWN_SERVICE_SENTINEL",
    required: false,
    codeDefault: "unknown_service:dotnet",
    section: "Service identity",
    note: "The service_name value that means \"the emitter never set service.name\" (the OTel spec default). Rows carrying it are re-attributed via OBSERVE_APP_NAME_FIELD. Set to an empty string to disable resolution entirely and go back to raw service_name."
  },

  // --- Result and time-window caps ---------------------------------------------
  { name: "OBSERVE_DEFAULT_SIZE", required: false, default: "100", section: "Result and time-window caps" },
  { name: "OBSERVE_MAX_SIZE", required: false, default: "1000", section: "Result and time-window caps" },
  { name: "OBSERVE_DEFAULT_LOOKBACK_MS", required: false, default: "3600000", section: "Result and time-window caps", note: "1 hour." },
  { name: "OBSERVE_MAX_LOOKBACK_MS", required: false, default: "604800000", section: "Result and time-window caps", note: "7 days." },
  { name: "OBSERVE_TIMEOUT_MS", required: false, default: "30000", section: "Result and time-window caps" },
  {
    name: "OBSERVE_MAX_RETRIES",
    required: false,
    codeDefault: "2",
    section: "Result and time-window caps",
    note: "Retries for transient HTTP failures (network / 5xx / 429). 0 disables."
  },

  // --- Projection --------------------------------------------------------------
  {
    name: "OBSERVE_LOG_COLUMNS",
    required: false,
    section: "Projection",
    note: "Comma-separated columns instead of SELECT * (smaller/faster). Unset = SELECT *, which is schema-safe. A query naming a column the stream lacks auto-falls back to SELECT *."
  },

  // --- Per-profile field caps --------------------------------------------------
  {
    name: "OBSERVE_MSG_MAX_NANO",
    required: false,
    codeDefault: "200",
    section: "Per-profile field caps (characters)",
    note: "Caps the long `message` field per response profile. verbose keeps full text."
  },
  { name: "OBSERVE_MSG_MAX_COMPACT", required: false, codeDefault: "400", section: "Per-profile field caps (characters)" },
  { name: "OBSERVE_MSG_MAX_STANDARD", required: false, codeDefault: "2000", section: "Per-profile field caps (characters)" },
  { name: "OBSERVE_MSG_MAX_VERBOSE", required: false, codeDefault: "unlimited", section: "Per-profile field caps (characters)" },
  {
    name: "OBSERVE_EXC_MAX_NANO",
    required: false,
    codeDefault: "0",
    section: "Per-profile field caps (characters)",
    note: "Caps the `exception` field. 0 = drop the field entirely, which is what nano does."
  },
  { name: "OBSERVE_EXC_MAX_COMPACT", required: false, codeDefault: "800", section: "Per-profile field caps (characters)" },
  { name: "OBSERVE_EXC_MAX_STANDARD", required: false, codeDefault: "6000", section: "Per-profile field caps (characters)" },
  { name: "OBSERVE_EXC_MAX_VERBOSE", required: false, codeDefault: "unlimited", section: "Per-profile field caps (characters)" },

  // --- Node runtime ------------------------------------------------------------
  // Not an observe-mcp variable, but the hand-written .env.example documented it and the guidance
  // is real: the self-hosted query host may present an untrusted certificate. Kept so generating
  // the file does not silently drop operational knowledge.
  {
    name: "NODE_TLS_REJECT_UNAUTHORIZED",
    required: false,
    section: "Node runtime (last resort)",
    note: "Set to 0 ONLY if the query host uses a self-signed/untrusted TLS certificate. This is a Node flag, not a server setting, and it disables certificate verification for the WHOLE process — every outbound TLS connection, not just OpenObserve. Prefer trusting the CA."
  }
];
