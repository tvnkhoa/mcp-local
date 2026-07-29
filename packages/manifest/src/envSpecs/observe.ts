/**
 * `observe-mcp`'s environment contract — 22 vars.
 *
 * The per-profile character caps are the bulk of it. They were the S-25 finding that no schema
 * could have revealed — serialization differs by response profile — so they are documented here
 * rather than left to be rediscovered from the config module.
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
  { name: "OBSERVE_LOG_STREAM", required: true, section: "Connection", prompt: "Log stream name", default: "wecrm_dev" },
  { name: "OBSERVE_TRACE_STREAM", required: true, section: "Connection", prompt: "Trace stream name", default: "wecrm_dev" },

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
