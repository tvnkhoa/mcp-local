/**
 * Two-part approval token for preview → apply flows.
 *
 * This is the format postgres-mcp and codebase-index-mcp both already issue:
 *
 *     base64url(JSON({previewId, digest, expiresAt})) "." base64url(HMAC-SHA256)
 *
 * It is deliberately kept distinct from `createApprovalService`, whose `v1.`-
 * prefixed format is not wire-compatible. Both servers had hand-copied this
 * logic; the copies produced byte-identical tokens and identical verdicts on
 * every case, which is what makes sharing it behaviour-preserving.
 *
 * Verification returns a verdict rather than throwing. Each server raises its own
 * error type with its own code vocabulary, and that mapping is part of its tool
 * contract — so the decision is shared and the reporting stays local.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Claims bound into the token. The apply step must present all three unchanged. */
export interface PreviewTokenClaims {
  readonly previewId: string;
  readonly digest: string;
  readonly expiresAt: string;
}

export type PreviewTokenRejection =
  /** Not `<payload>.<signature>`, or either half empty. */
  | "invalid_format"
  /** HMAC did not match — wrong secret, or the token was edited. */
  | "invalid_signature"
  /** Signature valid but the payload is not the expected JSON. */
  | "invalid_payload"
  /** Signature valid, but the claims describe a different plan. */
  | "mismatch"
  /** Everything valid, but `expiresAt` has passed. */
  | "expired";

export type PreviewTokenVerification = { readonly ok: true } | { readonly ok: false; readonly reason: PreviewTokenRejection };

export interface VerifyPreviewTokenOptions {
  /**
   * Skip the expiry check.
   *
   * Used by schema migrations, where the real staleness guard is a snapshot-drift
   * re-check at apply time rather than a time box: a human approval pause can
   * legitimately outlast the TTL, and an old token can still only apply the exact
   * previewed plan. Data writes leave this off.
   */
  readonly ignoreExpiry?: boolean;
  /** Injectable clock, in epoch milliseconds. Defaults to `Date.now()`. */
  readonly now?: number;
}

export interface PreviewTokenRejectionDetail {
  readonly code: string;
  readonly message: string;
}

/**
 * Stable code and message for each rejection reason.
 *
 * Both servers already used exactly these strings, so the mapping was duplicated
 * too. They are client-visible: `write_apply` and `refactor_replace_apply` surface
 * them verbatim, so treat them as contract rather than as log text.
 */
export function describePreviewTokenRejection(reason: PreviewTokenRejection): PreviewTokenRejectionDetail {
  switch (reason) {
    case "invalid_format":
      return { code: "INVALID_APPROVAL_TOKEN", message: "Approval token format is invalid." };
    case "invalid_signature":
      return { code: "INVALID_APPROVAL_TOKEN", message: "Approval token signature is invalid." };
    case "invalid_payload":
      return { code: "INVALID_APPROVAL_TOKEN", message: "Approval token payload is invalid." };
    case "mismatch":
      return {
        code: "APPROVAL_TOKEN_MISMATCH",
        message: "Approval token does not match the approved preview plan."
      };
    case "expired":
      return { code: "APPROVAL_TOKEN_EXPIRED", message: "Approval token has expired." };
  }
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function issuePreviewToken(claims: PreviewTokenClaims, secret: string): string {
  // Key order is part of the wire format: it determines the payload bytes, and
  // therefore the signature. Do not reorder.
  const payload = Buffer.from(
    JSON.stringify({
      previewId: claims.previewId,
      digest: claims.digest,
      expiresAt: claims.expiresAt
    })
  ).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyPreviewToken(
  token: string,
  claims: PreviewTokenClaims,
  secret: string,
  options: VerifyPreviewTokenOptions = {}
): PreviewTokenVerification {
  // Split on the LAST dot: base64url never contains one, but splitting from the
  // right is what the original implementations did and keeps parsing total.
  const dotIndex = token.lastIndexOf(".");
  const payload = dotIndex > 0 ? token.slice(0, dotIndex) : "";
  const signature = dotIndex > 0 ? token.slice(dotIndex + 1) : "";
  if (payload === "" || signature === "") {
    return { ok: false, reason: "invalid_format" };
  }

  // Constant-time comparison: never short-circuit on the first differing byte.
  // `timingSafeEqual` throws on length mismatch, so the length is checked first
  // — that leak is unavoidable and reveals nothing about the secret.
  const expected = Buffer.from(sign(payload, secret));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, reason: "invalid_signature" };
  }

  let decoded: PreviewTokenClaims;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as PreviewTokenClaims;
  } catch {
    return { ok: false, reason: "invalid_payload" };
  }

  if (
    decoded.previewId !== claims.previewId ||
    decoded.digest !== claims.digest ||
    decoded.expiresAt !== claims.expiresAt
  ) {
    return { ok: false, reason: "mismatch" };
  }

  if (options.ignoreExpiry !== true && Date.parse(decoded.expiresAt) < (options.now ?? Date.now())) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true };
}
