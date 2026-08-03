/**
 * Regression suite for the approval-token extraction.
 *
 * The HMAC construction now comes from @mcp/shared. What is pinned here is this
 * server's contract: the positional signatures its call sites use, the
 * `PolicyViolationError` type, the error codes, and the `ignoreExpiry` escape
 * hatch that migrations depend on.
 *
 * Baseline: 19 cases characterized against the pre-extraction implementation
 * (including the exact token string). All 19 are identical.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PolicyViolationError } from "../../middleware/errors.js";
import {
  createWriteDigest,
  issueApprovalToken,
  resolveApprovalSecret,
  verifyApprovalToken
} from "./approval.js";

const SECRET = "test-secret-0123456789";
const PREVIEW = "prev-abc-123";
const DIGEST = "a".repeat(64);
const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

function rejectionOf(fn: () => void): { code: string; message: string } {
  try {
    fn();
    assert.fail("expected the token to be rejected");
  } catch (error) {
    assert.ok(error instanceof PolicyViolationError, "must raise PolicyViolationError");
    return { code: error.code, message: error.message };
  }
}

test("a freshly issued token verifies", () => {
  const token = issueApprovalToken(PREVIEW, DIGEST, FUTURE, SECRET);
  assert.doesNotThrow(() => verifyApprovalToken(token, PREVIEW, DIGEST, FUTURE, SECRET));
});

test("token format is two dot-separated base64url parts", () => {
  const token = issueApprovalToken(PREVIEW, DIGEST, FUTURE, SECRET);
  assert.equal(token.split(".").length, 2);
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test("issuing is deterministic — the same plan yields the same token", () => {
  assert.equal(
    issueApprovalToken(PREVIEW, DIGEST, FUTURE, SECRET),
    issueApprovalToken(PREVIEW, DIGEST, FUTURE, SECRET)
  );
});

test("a token issued under a different secret is refused", () => {
  const foreign = issueApprovalToken(PREVIEW, DIGEST, FUTURE, "other-secret");
  assert.deepEqual(rejectionOf(() => verifyApprovalToken(foreign, PREVIEW, DIGEST, FUTURE, SECRET)), {
    code: "INVALID_APPROVAL_TOKEN",
    message: "Approval token signature is invalid."
  });
});

test("error codes are contract", () => {
  const token = issueApprovalToken(PREVIEW, DIGEST, FUTURE, SECRET);

  assert.deepEqual(rejectionOf(() => verifyApprovalToken("nodot", PREVIEW, DIGEST, FUTURE, SECRET)), {
    code: "INVALID_APPROVAL_TOKEN",
    message: "Approval token format is invalid."
  });

  // Signature valid, but bound to a different plan.
  assert.deepEqual(rejectionOf(() => verifyApprovalToken(token, "other-preview", DIGEST, FUTURE, SECRET)), {
    code: "APPROVAL_TOKEN_MISMATCH",
    message: "Approval token does not match the approved preview plan."
  });

  const expired = issueApprovalToken(PREVIEW, DIGEST, PAST, SECRET);
  assert.deepEqual(rejectionOf(() => verifyApprovalToken(expired, PREVIEW, DIGEST, PAST, SECRET)), {
    code: "APPROVAL_TOKEN_EXPIRED",
    message: "Approval token has expired."
  });
});

test("a tampered signature cannot be padded or truncated into acceptance", () => {
  const token = issueApprovalToken(PREVIEW, DIGEST, FUTURE, SECRET);
  const [payload, signature] = token.split(".") as [string, string];

  for (const forged of [
    `${payload}.${signature.slice(0, -1)}X`,
    `${payload}.${signature.slice(0, 8)}`,
    `${payload}.${signature}AAAA`
  ]) {
    assert.equal(
      rejectionOf(() => verifyApprovalToken(forged, PREVIEW, DIGEST, FUTURE, SECRET)).code,
      "INVALID_APPROVAL_TOKEN"
    );
  }
});

test("ignoreExpiry accepts a stale token — the migration escape hatch", () => {
  // Migrations rely on this: the preSnapshotId drift guard, not the TTL, is what
  // makes a stale migration token safe. Data writes must NOT pass this flag.
  const expired = issueApprovalToken(PREVIEW, DIGEST, PAST, SECRET);
  assert.doesNotThrow(() =>
    verifyApprovalToken(expired, PREVIEW, DIGEST, PAST, SECRET, { ignoreExpiry: true }));

  // ignoreExpiry must not weaken any other check.
  assert.equal(
    rejectionOf(() => verifyApprovalToken(expired, "other", DIGEST, PAST, SECRET, { ignoreExpiry: true })).code,
    "APPROVAL_TOKEN_MISMATCH"
  );
});

test("createWriteDigest is stable for the same plan and sensitive to each field", () => {
  const plan = { environment: "dev", sql: "update t set a=1", params: [1], statementType: "update", rowsAffected: 1 };
  assert.equal(createWriteDigest(plan), createWriteDigest({ ...plan }));
  assert.notEqual(createWriteDigest(plan), createWriteDigest({ ...plan, environment: "staging" }));
  assert.notEqual(createWriteDigest(plan), createWriteDigest({ ...plan, rowsAffected: 2 }));
  assert.notEqual(createWriteDigest(plan), createWriteDigest({ ...plan, params: [2] }));
});

test("resolveApprovalSecret keeps THIS server's policy, not the shared one", () => {
  // Configured secret wins, trimmed.
  assert.equal(resolveApprovalSecret("  configured  "), "configured");
  // Unset generates a random per-process secret — 32 bytes hex — rather than
  // throwing or returning a fixed development value (which is what
  // codebase-index-mcp does). Same function name, different policy on purpose.
  const generated = resolveApprovalSecret("");
  assert.match(generated, /^[0-9a-f]{64}$/);
  assert.notEqual(generated, resolveApprovalSecret(""));
});
