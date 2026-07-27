# @mcp/core

**Tier 0 · Stability: evolving · Runtime dependencies: none (permanent)**

Platform primitives. No MCP protocol knowledge, no I/O at import time, and no
runtime dependencies — ever. Adding one requires an ADR.

## Modules

| Module | Provides |
|---|---|
| `result` | `Result<T,E>`, `ok`, `err`, `isOk`, `isErr`, `mapOk`, `mapErr`, `allOk` |
| `errors` | `PlatformError`, the 11-code taxonomy, `toPlatformError`, per-code factories |
| `redaction` | `maskSecret`, `redactValue`, `redactObject`, `createRedactor` |
| `env` | `createEnvReader`, `defaultEnvSource` — the only permitted `process.env` reader |
| `logging` | `createLogger` (stderr only), `createNullLogger` |
| `profiles` | `ResponseProfile`, `parseResponseProfile`, `shouldPrettyPrint` |
| `limits` | `resolveBound`, `resolveLimit`, `resolveTimeoutMs` |
| `json` | `isPlainObject`, `normalizePayload`, `stableStringify` |
| `paths` | `toPosixPath`, `isPathWithin`, `normalizePosixPath` |

## Invariants

1. **Zero runtime dependencies.** Enforced by `guard:deps`.
2. **stderr only.** `createLogger` never writes to stdout — stdout is the MCP transport.
3. **No import-time side effects.** `defaultEnvSource()` is a function, not a constant.
4. **Errors never leak internals.** `toPlatformError` puts the original message on
   `cause` (logged) and never in `details` (returned to the caller).

## Usage

```ts
import { createEnvReader, createLogger, defaultEnvSource, ok } from "@mcp/core";

const env = createEnvReader(defaultEnvSource());
const logger = createLogger({ name: "my-server", level: "info" });

const timeoutMs = env.number("MY_SERVER_TIMEOUT_MS", 30_000, { max: 60_000 });
logger.info("configured", { timeoutMs });
```

## Test

```bash
npm test --workspace @mcp/core
```
