/**
 * @mcp/core — Tier-0 platform primitives.
 *
 * Zero runtime dependencies. No MCP protocol knowledge. No I/O at import time.
 * Everything here is usable from a build script as readily as from a server.
 */

export type { Err, Ok, Result } from "./result.js";
export { allOk, err, isErr, isOk, mapErr, mapOk, ok, unwrapOr } from "./result.js";

export type { ErrorAudience, ErrorCode, PlatformErrorOptions, PlatformErrorPayload } from "./errors.js";
export {
  ERROR_CODES,
  PlatformError,
  PolicyViolationError,
  configError,
  conflictError,
  internalError,
  isPlatformError,
  notFound,
  policyViolation,
  rateLimitedError,
  timeoutError,
  toPlatformError,
  unauthorizedError,
  unsupportedError,
  upstreamError,
  validationError
} from "./errors.js";

export type { MaskOptions, RedactOptions, Redactor } from "./redaction.js";
export {
  createRedactor,
  isSecretKey,
  maskSecret,
  maskUriCredentials,
  redactObject,
  redactValue
} from "./redaction.js";

export type { EnvReader, EnvSource, NumberOptions } from "./env.js";
export { createEnvReader, defaultEnvSource } from "./env.js";

export type { EventLogger, LogFields, LogLevel, LogSink, Logger, LoggerOptions } from "./logging.js";
export { LOG_LEVELS, createEventLogger, createLogger, createNullLogger, isLogLevel, parseLogLevel } from "./logging.js";

export type { ResponseProfile } from "./profiles.js";
export {
  DEFAULT_RESPONSE_PROFILE,
  RESPONSE_PROFILES,
  isResponseProfile,
  parseResponseProfile,
  profileVerbosityRank,
  shouldDropNullish,
  shouldPrettyPrint
} from "./profiles.js";

export type { BoundResolution, BoundSpec, LimitPolicy } from "./limits.js";
export { createLimitPolicy, resolveBound, resolveLimit, resolveTimeoutMs } from "./limits.js";

export type { JsonValue, NormalizeOptions } from "./json.js";
export { isPlainObject, normalizePayload, stableStringify } from "./json.js";

export { isPathWithin, normalizePosixPath, pathSegments, toPosixPath } from "./paths.js";
