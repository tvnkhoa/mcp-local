/**
 * `bitbucket-mcp`'s environment contract — 11 vars.
 *
 * The auth group has a shape `evaluateEnv` cannot express: Basic auth needs BOTH
 * `BITBUCKET_EMAIL` and `BITBUCKET_API_TOKEN`, while Bearer needs only
 * `BITBUCKET_ACCESS_TOKEN` — so "one of three" is looser than the truth. Setting just the email
 * satisfies the group and still fails at request time. The server validates the real pairing;
 * the group only stops the installer from claiming nothing was configured.
 */

import type { EnvField } from "../types.js";

export const bitbucketEnv: readonly EnvField[] = [
  // --- Target ------------------------------------------------------------------
  { name: "BITBUCKET_WORKSPACE", required: true, section: "Target", prompt: "Bitbucket workspace slug", note: "The ID in bitbucket.org/<workspace>/…" },
  { name: "BITBUCKET_DEFAULT_REPO", required: false, section: "Target", prompt: "Default repository slug (optional)", note: "Lets you omit `repoSlug` on every call." },

  // --- Auth: Bearer OR Basic ---------------------------------------------------
  {
    name: "BITBUCKET_ACCESS_TOKEN",
    required: false,
    secret: true,
    group: "bitbucket-auth",
    section: "Auth (Bearer token OR email + API token)",
    prompt: "Access token for Bearer auth (blank to use email + API token)",
    note: "Auth: this (Bearer) OR BITBUCKET_EMAIL + BITBUCKET_API_TOKEN (Basic). Scopes: read:repository, read:pullrequest, write:pullrequest."
  },
  {
    name: "BITBUCKET_EMAIL",
    required: false,
    group: "bitbucket-auth",
    section: "Auth (Bearer token OR email + API token)",
    prompt: "Atlassian account email (Basic auth)",
    note: "Basic auth needs BOTH this and BITBUCKET_API_TOKEN. An Atlassian API token (ATATT…) is a Basic credential, not a Bearer one."
  },
  { name: "BITBUCKET_API_TOKEN", required: false, secret: true, group: "bitbucket-auth", section: "Auth (Bearer token OR email + API token)", prompt: "Atlassian API token (Basic auth)" },

  // --- Write gate --------------------------------------------------------------
  {
    name: "BITBUCKET_WRITE_ENABLED",
    required: false,
    default: "false",
    section: "Write gate",
    note: "create_pull_request is DISABLED unless true. The tool is still advertised; the gate is enforced when it is called."
  },

  // --- HTTP --------------------------------------------------------------------
  { name: "BITBUCKET_BASE_URL", required: false, codeDefault: "https://api.bitbucket.org/2.0", section: "HTTP" },
  { name: "BITBUCKET_TIMEOUT_MS", required: false, default: "30000", section: "HTTP", note: "Must be > 0, else the default applies." },
  { name: "BITBUCKET_MAX_RETRIES", required: false, default: "2", section: "HTTP", note: "Retries for transient failures (network / 429 / 5xx). 0 disables." },
  { name: "BITBUCKET_DEFAULT_PAGELEN", required: false, codeDefault: "25", section: "HTTP" },
  { name: "BITBUCKET_MAX_PAGELEN", required: false, codeDefault: "100", section: "HTTP" }
];
