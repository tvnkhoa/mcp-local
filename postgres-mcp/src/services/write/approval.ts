import { createHash, randomBytes } from "node:crypto";

import {
  describePreviewTokenRejection,
  issuePreviewToken,
  verifyPreviewToken
} from "@mcp/shared";

import { PolicyViolationError } from "../../middleware/errors.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Stable digest of an approved plan. The same logical change always yields the same
 * digest, so the apply step can prove the token was issued for *this* plan.
 * Ported from codebase-index-mcp/src/refactorUtils.ts (createPreviewDigest).
 */
export function createWriteDigest(input: {
  environment: string;
  sql: string;
  params: unknown[];
  statementType: string;
  rowsAffected: number;
}): string {
  const stable = JSON.stringify({
    environment: input.environment,
    sql: input.sql,
    params: input.params,
    statementType: input.statementType,
    rowsAffected: input.rowsAffected
  });
  return sha256(stable);
}

/**
 * Issue / verify the preview approval token.
 *
 * The HMAC construction and token format are shared with codebase-index-mcp via
 * `@mcp/shared` — the two copies produced byte-identical tokens and identical
 * verdicts on every case. Raising `PolicyViolationError` stays here because the
 * exception type is this server's contract.
 */
export function issueApprovalToken(previewId: string, digest: string, expiresAt: string, secret: string): string {
  return issuePreviewToken({ previewId, digest, expiresAt }, secret);
}

export function verifyApprovalToken(
  token: string,
  previewId: string,
  digest: string,
  expiresAt: string,
  secret: string,
  options: { ignoreExpiry?: boolean } = {}
): void {
  // Migrations pass `ignoreExpiry:true`: for a schema migration the real staleness check is the
  // preSnapshotId drift guard re-run at apply time (the live schema must still match what was
  // previewed), not this time-box — a human-approval pause can legitimately outlast the TTL, and
  // an old token can still only apply the exact previewed plan against an unchanged schema. Data
  // writes (write_apply) have no such drift guard, so they keep the strict expiry (default).
  const verdict = verifyPreviewToken(
    token,
    { previewId, digest, expiresAt },
    secret,
    options.ignoreExpiry === undefined ? {} : { ignoreExpiry: options.ignoreExpiry }
  );
  if (!verdict.ok) {
    const { code, message } = describePreviewTokenRejection(verdict.reason);
    throw new PolicyViolationError(code, message);
  }
}

/**
 * Resolve the HMAC secret used to sign/verify approval tokens.
 *
 * The token is both issued (write_preview) and verified (write_apply) inside THIS
 * process, and the preview store is in-memory (cleared on restart), so the secret
 * never needs to be shared, persisted, or known by the client. We therefore generate
 * a strong random per-process secret when none is configured — writes work with just
 * POSTGRES_WRITE_ENABLED=true, while apply still requires a real preview-issued, unforgeable
 * token (the "review before approve" gate is the preview→apply round-trip itself).
 *
 * An explicit POSTGRES_WRITE_APPROVAL_SECRET is still honored (e.g. if an operator wants
 * tokens to stay valid across restarts), but it is no longer required.
 *
 * NOTE: deliberately NOT the `resolveApprovalSecret` exported by `@mcp/shared`, and
 * not shared with codebase-index-mcp either. All three have the same name and
 * different policy — codebase-index-mcp throws in strict mode and otherwise falls
 * back to a fixed development secret. Unifying them would change behaviour.
 */
export function resolveApprovalSecret(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length > 0) {
    return trimmed;
  }
  return randomBytes(32).toString("hex");
}
