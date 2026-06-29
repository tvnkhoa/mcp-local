import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { PolicyViolationError } from "../errors.js";

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

export function issueApprovalToken(previewId: string, digest: string, expiresAt: string, secret: string): string {
  const payload = Buffer.from(JSON.stringify({ previewId, digest, expiresAt })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyApprovalToken(
  token: string,
  previewId: string,
  digest: string,
  expiresAt: string,
  secret: string
): void {
  const dotIdx = token.lastIndexOf(".");
  const payload = dotIdx > 0 ? token.slice(0, dotIdx) : "";
  const signature = dotIdx > 0 ? token.slice(dotIdx + 1) : "";
  if (!payload || !signature) {
    throw new PolicyViolationError("INVALID_APPROVAL_TOKEN", "Approval token format is invalid.");
  }
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  // Constant-time comparison: never short-circuit on the first differing byte.
  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(signature);
  if (expectedBuf.length !== signatureBuf.length || !timingSafeEqual(expectedBuf, signatureBuf)) {
    throw new PolicyViolationError("INVALID_APPROVAL_TOKEN", "Approval token signature is invalid.");
  }

  let decoded: { previewId: string; digest: string; expiresAt: string };
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new PolicyViolationError("INVALID_APPROVAL_TOKEN", "Approval token payload is invalid.");
  }

  if (decoded.previewId !== previewId || decoded.digest !== digest || decoded.expiresAt !== expiresAt) {
    throw new PolicyViolationError("APPROVAL_TOKEN_MISMATCH", "Approval token does not match the approved preview plan.");
  }

  if (Date.parse(decoded.expiresAt) < Date.now()) {
    throw new PolicyViolationError("APPROVAL_TOKEN_EXPIRED", "Approval token has expired.");
  }
}

/**
 * Resolve the HMAC secret used to sign/verify approval tokens.
 *
 * The token is both issued (write_preview) and verified (write_apply) inside THIS
 * process, and the preview store is in-memory (cleared on restart), so the secret
 * never needs to be shared, persisted, or known by the client. We therefore generate
 * a strong random per-process secret when none is configured — writes work with just
 * PG_WRITE_ENABLED=true, while apply still requires a real preview-issued, unforgeable
 * token (the "review before approve" gate is the preview→apply round-trip itself).
 *
 * An explicit PG_WRITE_APPROVAL_SECRET is still honored (e.g. if an operator wants
 * tokens to stay valid across restarts), but it is no longer required.
 */
export function resolveApprovalSecret(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length > 0) {
    return trimmed;
  }
  return randomBytes(32).toString("hex");
}
