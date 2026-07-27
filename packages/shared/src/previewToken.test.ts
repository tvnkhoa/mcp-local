import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describePreviewTokenRejection,
  issuePreviewToken,
  verifyPreviewToken
} from "./approval/previewToken.js";

// --- Regression: preview approval token extraction ---------------------------
// postgres-mcp and codebase-index-mcp both hand-copied this. The copies produced
// byte-identical tokens and identical verdicts across 14 cases, which is what
// made sharing them behaviour-preserving. These tests pin the wire format.

const TOKEN_SECRET = "test-secret-0123456789";
const CLAIMS = { previewId: "prev-abc-123", digest: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z" };

test("previewToken: format is <base64url payload>.<base64url hmac>", () => {
  const token = issuePreviewToken(CLAIMS, TOKEN_SECRET);
  const parts = token.split(".");
  assert.equal(parts.length, 2);
  // Payload decodes back to the claims, in the order that defines the signature.
  const decoded = JSON.parse(Buffer.from(parts[0] as string, "base64url").toString("utf8"));
  assert.deepEqual(Object.keys(decoded), ["previewId", "digest", "expiresAt"]);
  assert.deepEqual(decoded, CLAIMS);
});

test("previewToken: issuing is deterministic and secret-sensitive", () => {
  assert.equal(issuePreviewToken(CLAIMS, TOKEN_SECRET), issuePreviewToken(CLAIMS, TOKEN_SECRET));
  assert.notEqual(issuePreviewToken(CLAIMS, TOKEN_SECRET), issuePreviewToken(CLAIMS, "other-secret"));
});

test("previewToken: a freshly issued token verifies", () => {
  const token = issuePreviewToken(CLAIMS, TOKEN_SECRET);
  assert.deepEqual(verifyPreviewToken(token, CLAIMS, TOKEN_SECRET), { ok: true });
});

test("previewToken: every rejection path returns its own reason", () => {
  const token = issuePreviewToken(CLAIMS, TOKEN_SECRET);
  const [payload, signature] = token.split(".") as [string, string];

  assert.deepEqual(verifyPreviewToken("nodot", CLAIMS, TOKEN_SECRET), { ok: false, reason: "invalid_format" });
  assert.deepEqual(verifyPreviewToken("", CLAIMS, TOKEN_SECRET), { ok: false, reason: "invalid_format" });
  assert.deepEqual(verifyPreviewToken(".", CLAIMS, TOKEN_SECRET), { ok: false, reason: "invalid_format" });
  assert.deepEqual(verifyPreviewToken(`${payload}.`, CLAIMS, TOKEN_SECRET), { ok: false, reason: "invalid_format" });

  // Wrong secret and edited signature are both signature failures.
  assert.deepEqual(verifyPreviewToken(token, CLAIMS, "other"), { ok: false, reason: "invalid_signature" });
  assert.deepEqual(
    verifyPreviewToken(`${payload}.${signature.slice(0, -1)}X`, CLAIMS, TOKEN_SECRET),
    { ok: false, reason: "invalid_signature" }
  );
  // A shorter signature must not throw out of timingSafeEqual.
  assert.deepEqual(
    verifyPreviewToken(`${payload}.${signature.slice(0, 8)}`, CLAIMS, TOKEN_SECRET),
    { ok: false, reason: "invalid_signature" }
  );

  // Correctly signed but the claims describe a different plan.
  assert.deepEqual(
    verifyPreviewToken(token, { ...CLAIMS, previewId: "other" }, TOKEN_SECRET),
    { ok: false, reason: "mismatch" }
  );
  assert.deepEqual(
    verifyPreviewToken(token, { ...CLAIMS, digest: "b".repeat(64) }, TOKEN_SECRET),
    { ok: false, reason: "mismatch" }
  );
});

test("previewToken: expiry is checked against an injectable clock", () => {
  const expired = { ...CLAIMS, expiresAt: "2000-01-01T00:00:00.000Z" };
  const token = issuePreviewToken(expired, TOKEN_SECRET);
  assert.deepEqual(verifyPreviewToken(token, expired, TOKEN_SECRET), { ok: false, reason: "expired" });
  // ignoreExpiry is what migrations use — the drift guard replaces the time box.
  assert.deepEqual(verifyPreviewToken(token, expired, TOKEN_SECRET, { ignoreExpiry: true }), { ok: true });
  // An explicit clock before the deadline accepts it.
  assert.deepEqual(
    verifyPreviewToken(token, expired, TOKEN_SECRET, { now: Date.parse("1999-01-01T00:00:00.000Z") }),
    { ok: true }
  );
});

test("previewToken: signature is verified BEFORE the payload is parsed", () => {
  // A junk payload with a valid signature is invalid_payload; with an invalid
  // signature it must never reach the parser.
  const junk = Buffer.from("not json").toString("base64url");
  const signed = issuePreviewToken(CLAIMS, TOKEN_SECRET);
  assert.deepEqual(verifyPreviewToken(`${junk}.${signed.split(".")[1]}`, CLAIMS, TOKEN_SECRET), {
    ok: false,
    reason: "invalid_signature"
  });
});

test("previewToken: rejection codes and messages are stable contract", () => {
  assert.deepEqual(describePreviewTokenRejection("invalid_format"), {
    code: "INVALID_APPROVAL_TOKEN",
    message: "Approval token format is invalid."
  });
  assert.deepEqual(describePreviewTokenRejection("invalid_signature"), {
    code: "INVALID_APPROVAL_TOKEN",
    message: "Approval token signature is invalid."
  });
  assert.deepEqual(describePreviewTokenRejection("invalid_payload"), {
    code: "INVALID_APPROVAL_TOKEN",
    message: "Approval token payload is invalid."
  });
  assert.deepEqual(describePreviewTokenRejection("mismatch"), {
    code: "APPROVAL_TOKEN_MISMATCH",
    message: "Approval token does not match the approved preview plan."
  });
  assert.deepEqual(describePreviewTokenRejection("expired"), {
    code: "APPROVAL_TOKEN_EXPIRED",
    message: "Approval token has expired."
  });
});
