/**
 * Regression suite for the approval-token extraction.
 *
 * The HMAC construction now comes from @mcp/shared, shared with postgres-mcp.
 * Pinned here: this server's positional signatures, its PolicyViolationError
 * codes, and the fact that signature comparison is now constant-time WITHOUT any
 * verdict changing.
 *
 * Baseline: 19 cases characterized against the pre-extraction implementation
 * (including the exact token string). All 19 are identical.
 *
 * Usage: npm run build && node scripts/test/test-approval-token.mjs
 */

import { createHmac } from "node:crypto";

import {
  issueApprovalToken,
  verifyApprovalToken,
  resolveApprovalSecret,
  PolicyViolationError
} from "../../dist/refactor/refactorUtils.js";

const SECRET = "test-secret-0123456789";
const PREVIEW = "prev-abc-123";
const DIGEST = "a".repeat(64);
const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

let passed = 0;
const failures = [];

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed += 1;
  else failures.push(`${label}\n     expected: ${e}\n     actual:   ${a}`);
}

function rejection(label, fn) {
  try {
    fn();
    failures.push(`${label}\n     expected a PolicyViolationError, got none`);
    return null;
  } catch (error) {
    if (!(error instanceof PolicyViolationError)) {
      failures.push(`${label}\n     expected PolicyViolationError, got ${error.constructor.name}`);
      return null;
    }
    return { code: error.code, message: error.message };
  }
}

function accepts(label, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(`${label}\n     expected acceptance, threw ${error.code ?? error.constructor.name}: ${error.message}`);
  }
}

// --- issue -------------------------------------------------------------------
const token = issueApprovalToken(PREVIEW, DIGEST, FUTURE, SECRET);
check("token has two parts", token.split(".").length, 2);
check("token is base64url only", /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token), true);
check("issuing is deterministic", issueApprovalToken(PREVIEW, DIGEST, FUTURE, SECRET), token);
check(
  "issuing is secret-sensitive",
  issueApprovalToken(PREVIEW, DIGEST, FUTURE, "other") !== token,
  true
);
check(
  "payload decodes to the claims in signing order",
  Object.keys(JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"))),
  ["previewId", "digest", "expiresAt"]
);

// --- accept path -------------------------------------------------------------
accepts("a freshly issued token verifies", () => verifyApprovalToken(token, PREVIEW, DIGEST, FUTURE, SECRET));

// --- reject paths ------------------------------------------------------------
check("malformed: no dot", rejection("no dot", () => verifyApprovalToken("nodot", PREVIEW, DIGEST, FUTURE, SECRET)), {
  code: "INVALID_APPROVAL_TOKEN",
  message: "Approval token format is invalid."
});
check("malformed: empty", rejection("empty", () => verifyApprovalToken("", PREVIEW, DIGEST, FUTURE, SECRET)), {
  code: "INVALID_APPROVAL_TOKEN",
  message: "Approval token format is invalid."
});
check(
  "wrong secret",
  rejection("wrong secret", () => verifyApprovalToken(token, PREVIEW, DIGEST, FUTURE, "other")),
  { code: "INVALID_APPROVAL_TOKEN", message: "Approval token signature is invalid." }
);
check(
  "bound to a different previewId",
  rejection("mismatch previewId", () => verifyApprovalToken(token, "other", DIGEST, FUTURE, SECRET)),
  { code: "APPROVAL_TOKEN_MISMATCH", message: "Approval token does not match the approved preview plan." }
);
check(
  "bound to a different digest",
  rejection("mismatch digest", () => verifyApprovalToken(token, PREVIEW, "b".repeat(64), FUTURE, SECRET)),
  { code: "APPROVAL_TOKEN_MISMATCH", message: "Approval token does not match the approved preview plan." }
);

const expired = issueApprovalToken(PREVIEW, DIGEST, PAST, SECRET);
check(
  "expired token",
  rejection("expired", () => verifyApprovalToken(expired, PREVIEW, DIGEST, PAST, SECRET)),
  { code: "APPROVAL_TOKEN_EXPIRED", message: "Approval token has expired." }
);

// Constant-time comparison must still refuse mismatched LENGTHS rather than
// throwing out of timingSafeEqual — this is the case the old `!==` handled for free.
const [payload, signature] = token.split(".");
for (const [label, forged] of [
  ["last byte flipped", `${payload}.${signature.slice(0, -1)}X`],
  ["truncated signature", `${payload}.${signature.slice(0, 8)}`],
  ["padded signature", `${payload}.${signature}AAAA`]
]) {
  check(
    `forged signature: ${label}`,
    rejection(label, () => verifyApprovalToken(forged, PREVIEW, DIGEST, FUTURE, SECRET))?.code,
    "INVALID_APPROVAL_TOKEN"
  );
}

// A validly signed payload that is not JSON.
const junk = Buffer.from("not json at all").toString("base64url");
const junkSig = createHmac("sha256", SECRET).update(junk).digest("base64url");
check(
  "valid signature over a non-JSON payload",
  rejection("non-json payload", () => verifyApprovalToken(`${junk}.${junkSig}`, PREVIEW, DIGEST, FUTURE, SECRET)),
  { code: "INVALID_APPROVAL_TOKEN", message: "Approval token payload is invalid." }
);

// --- resolveApprovalSecret keeps THIS server's policy ------------------------
// Deliberately NOT shared: postgres-mcp generates a random per-process secret,
// this server throws in strict mode and otherwise returns a fixed dev secret.
check("configured secret is returned", resolveApprovalSecret("configured", false), "configured");
check("non-strict fallback is the dev secret", resolveApprovalSecret("", false), "dev-insecure-secret");
check(
  "strict mode refuses to invent a secret",
  rejection("strict approval", () => resolveApprovalSecret("", true))?.code,
  "APPROVAL_SECRET_REQUIRED"
);

// --- report ------------------------------------------------------------------
console.log(`\nResults: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll approval token tests passed!");
