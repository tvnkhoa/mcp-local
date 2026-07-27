/**
 * HMAC approval tokens.
 *
 * Mechanism for the platform's preview -> apply -> rollback pattern: a preview
 * step issues a short-lived token bound to a subject (typically a preview id),
 * and the apply step will not proceed without a valid one.
 *
 * This package owns the *mechanism* only. TTL length, the env var holding the
 * secret, and what counts as a subject are each server's policy.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { PlatformError, Result } from "@mcp/core";
import { err, ok, policyViolation, validationError } from "@mcp/core";

const TOKEN_VERSION = "v1";

export type ApprovalClaimValue = string | number | boolean;

export interface ApprovalClaims {
  /** What the token authorizes — a preview id, a migration id, etc. */
  readonly subject: string;
  /** Epoch milliseconds at issue time. */
  readonly issuedAt: number;
  /** Epoch milliseconds after which the token is rejected. */
  readonly expiresAt: number;
  readonly extra: Readonly<Record<string, ApprovalClaimValue>>;
}

export interface ApprovalToken {
  readonly token: string;
  readonly expiresAt: number;
  readonly ttlMs: number;
}

export interface ApprovalServiceOptions {
  /** HMAC secret. Use {@link resolveApprovalSecret} to derive one safely. */
  readonly secret: string;
  /** Token lifetime in milliseconds. */
  readonly ttlMs: number;
  /** Injectable clock for deterministic tests. */
  readonly clock?: () => number;
}

export interface ApprovalService {
  issue(subject: string, extra?: Readonly<Record<string, ApprovalClaimValue>>): ApprovalToken;
  verify(token: string, subject: string): Result<ApprovalClaims, PlatformError>;
}

interface TokenBody {
  readonly sub: string;
  readonly iat: number;
  readonly exp: number;
  readonly ext: Record<string, ApprovalClaimValue>;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string | undefined {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Constant-time comparison that tolerates differing lengths without leaking. */
function safeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

export function generateApprovalSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export interface ResolvedApprovalSecret {
  readonly secret: string;
  /** True when no secret was supplied and an ephemeral one was generated. */
  readonly generated: boolean;
}

/**
 * Resolve a secret from configuration, generating an ephemeral per-process one
 * when unset. A generated secret means tokens do not survive a restart — which
 * is a safe default, not a failure.
 */
export function resolveApprovalSecret(configured: string | undefined): ResolvedApprovalSecret {
  const trimmed = configured?.trim();
  if (trimmed !== undefined && trimmed !== "") {
    return { secret: trimmed, generated: false };
  }
  return { secret: generateApprovalSecret(), generated: true };
}

export function createApprovalService(options: ApprovalServiceOptions): ApprovalService {
  if (options.secret.trim() === "") {
    throw new Error("createApprovalService: secret must be a non-empty string");
  }
  if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
    throw new Error("createApprovalService: ttlMs must be a positive number");
  }

  const clock = options.clock ?? (() => Date.now());

  return {
    issue(subject, extra = {}) {
      if (subject.trim() === "") {
        throw new Error("ApprovalService.issue: subject must be a non-empty string");
      }
      const issuedAt = clock();
      const expiresAt = issuedAt + options.ttlMs;
      const body: TokenBody = { sub: subject, iat: issuedAt, exp: expiresAt, ext: { ...extra } };
      const encoded = base64UrlEncode(JSON.stringify(body));
      const payload = `${TOKEN_VERSION}.${encoded}`;
      const signature = sign(options.secret, payload);
      return { token: `${payload}.${signature}`, expiresAt, ttlMs: options.ttlMs };
    },

    verify(token, subject) {
      const parts = token.split(".");
      if (parts.length !== 3) {
        return err(validationError("Approval token is malformed.", { reason: "shape" }));
      }
      const [version, encoded, signature] = parts as [string, string, string];
      if (version !== TOKEN_VERSION) {
        return err(validationError("Approval token version is not supported.", { version }));
      }

      const expected = sign(options.secret, `${version}.${encoded}`);
      if (!safeEquals(signature, expected)) {
        return err(policyViolation("Approval token signature is invalid.", { reason: "signature" }));
      }

      const decoded = base64UrlDecode(encoded);
      if (decoded === undefined) {
        return err(validationError("Approval token payload is not decodable.", { reason: "encoding" }));
      }

      let body: TokenBody;
      try {
        body = JSON.parse(decoded) as TokenBody;
      } catch {
        return err(validationError("Approval token payload is not valid JSON.", { reason: "json" }));
      }

      if (typeof body.sub !== "string" || typeof body.exp !== "number" || typeof body.iat !== "number") {
        return err(validationError("Approval token payload is incomplete.", { reason: "claims" }));
      }

      if (!safeEquals(body.sub, subject)) {
        return err(
          policyViolation("Approval token was issued for a different subject.", { reason: "subject_mismatch" })
        );
      }

      if (clock() > body.exp) {
        return err(policyViolation("Approval token has expired. Re-run the preview step.", { reason: "expired" }));
      }

      return ok({
        subject: body.sub,
        issuedAt: body.iat,
        expiresAt: body.exp,
        extra: body.ext ?? {}
      });
    }
  };
}
