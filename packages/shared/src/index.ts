/**
 * @mcp/shared — Tier-2 capabilities.
 *
 * Each capability is independent: no module here imports a sibling. Every one
 * provides mechanism and takes policy as a parameter, so two servers can share
 * the implementation while keeping different rules.
 */

export type {
  ApprovalClaimValue,
  ApprovalClaims,
  ApprovalService,
  ApprovalServiceOptions,
  ApprovalToken,
  ResolvedApprovalSecret
} from "./approval/index.js";
export { createApprovalService, generateApprovalSecret, resolveApprovalSecret } from "./approval/index.js";

export type {
  ReadOnlySqlValidator,
  SqlDialectPolicy,
  SqlValidation,
  SqlValidationSuccess
} from "./sql/index.js";
export {
  createReadOnlySqlValidator,
  findForbiddenToken,
  hasMultipleStatements,
  startsWithAllowedKeyword,
  stripStringsAndComments
} from "./sql/index.js";

export type {
  HttpClient,
  HttpClientOptions,
  HttpMethod,
  HttpRequest,
  HttpResponse,
  QueryValue
} from "./http/index.js";
export { computeBackoffMs, createHttpClient, defaultSleep, isRetryableStatus } from "./http/index.js";

export type { PathAllowlist, PathAllowlistOptions } from "./fs/index.js";
export { createPathAllowlist } from "./fs/index.js";
