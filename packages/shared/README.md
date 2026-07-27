# @mcp/shared

**Tier 2 · Stability: evolving · Depends on: `@mcp/core`**

Cross-cutting capabilities. Each is independent — **no module here imports a
sibling** — and each provides *mechanism* while taking *policy* as a parameter.

## Capabilities

| Import | Provides |
|---|---|
| `@mcp/shared/approval` | `createApprovalService` — HMAC token issue/verify with TTL, timing-safe compare |
| `@mcp/shared/sql` | `createReadOnlySqlValidator` — dialect-parameterized read-only SQL guard |
| `@mcp/shared/http` | `createHttpClient` — timeout, bounded retry with jitter, redacted errors |
| `@mcp/shared/fs` | `createPathAllowlist` — root allowlist with traversal defence |

## Mechanism, not policy

This is the package's defining rule, and it exists because of a real defect: the
audit found three hand-copied SQL guard implementations whose forbidden-token
lists had silently diverged (Postgres forbade 18 tokens, the OpenObserve copy
13). Nobody noticed because nothing compared them.

So `@mcp/shared/sql` ships **no token list**. The caller supplies one:

```ts
import { createReadOnlySqlValidator } from "@mcp/shared/sql";

const validate = createReadOnlySqlValidator({
  name: "postgres",
  allowedLeadingKeywords: ["select", "with"],
  forbiddenTokens: ["insert", "update", "delete", /* … */]
});

const outcome = validate(sql);
if (!outcome.ok) return outcome;          // PlatformError with a stable code
runQuery(outcome.value.sanitizedSql);
```

Two servers can now share the implementation and still differ — but the
difference is a reviewable data change, not an invisible fork.

The same principle applies throughout: `approval` does not know what a subject
means, `http` does not know any endpoint, `fs` does not know which roots matter.

## Security notes

- **Approval tokens** use HMAC-SHA256 with a constant-time comparison, and are
  bound to a subject: a token issued for one preview cannot apply another.
  `resolveApprovalSecret(undefined)` generates an ephemeral per-process secret,
  so tokens simply do not survive a restart — a safe default, not a failure.
- **`describe()` on the HTTP client** reports `authConfigured: true/false` and
  never the header value.

## Test

```bash
npm test --workspace @mcp/shared
```
