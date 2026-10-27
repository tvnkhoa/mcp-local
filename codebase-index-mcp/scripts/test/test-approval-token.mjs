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

import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  issueApprovalToken,
  verifyApprovalToken,
  resolveApprovalSecret,
  PolicyViolationError
} from "../../dist/services/refactor/refactorUtils.js";
import { refactorApprovalSecret } from "../../dist/config/envConfig.js";

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
// Deliberately NOT shared with postgres-mcp. MCP-ISSUE-104: there is no fallback any more — the constant
// "dev-insecure-secret" it returned let anyone mint an apply token; startup supplies the secret instead.
check("configured secret is returned", resolveApprovalSecret("configured", false), "configured");
check(
  "non-strict mode refuses an empty secret too (no constant fallback)",
  rejection("non-strict empty", () => resolveApprovalSecret("", false))?.code,
  "APPROVAL_SECRET_REQUIRED"
);
{
  // A token minted with the old constant is refused by a server whose secret startup generated.
  const stdio = refactorApprovalSecret("", "stdio");
  check("stdio without a secret gets a per-process random one", [stdio.source, /^[0-9a-f]{64}$/.test(stdio.secret)], ["per-process", true]);
  check("two processes get different secrets", refactorApprovalSecret("", "stdio").secret !== stdio.secret, true);
  const forged = issueApprovalToken(PREVIEW, DIGEST, FUTURE, "dev-insecure-secret");
  check(
    "a token minted with the old constant is refused",
    rejection("forged", () => verifyApprovalToken(forged, PREVIEW, DIGEST, FUTURE, resolveApprovalSecret(stdio.secret, false)))?.code,
    "INVALID_APPROVAL_TOKEN"
  );
  let httpError = "";
  try {
    refactorApprovalSecret("", "http");
  } catch (e) {
    httpError = e.message;
  }
  check("http without a secret refuses to start", /--transport http needs CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET/.test(httpError), true);
  check("an env secret wins in either transport", refactorApprovalSecret("from-env", "http"), { secret: "from-env", source: "env" });
}
check(
  "strict mode refuses to invent a secret",
  rejection("strict approval", () => resolveApprovalSecret("", true))?.code,
  "APPROVAL_SECRET_REQUIRED"
);

// --- MCP-ISSUE-104: the built server refuses to start over HTTP without a secret ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cim-approval-"));
  const env = { ...process.env, CODEBASE_INDEX_ALLOWED_ROOTS: dir, CODEBASE_INDEX_DB_PATH: path.join(dir, "x.db"), CODEBASE_INDEX_HTTP_PORT: "1", CODEBASE_INDEX_HTTP_TOKEN: "t" };
  delete env.CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET;
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("../../dist/index.js", import.meta.url)), "--transport", "http"], { env, encoding: "utf8", timeout: 60_000 });
  check("dist/index.js --transport http with no secret exits non-zero", run.status !== 0 && run.status !== null, true);
  check("... saying which variable it needs", /CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET/.test(run.stderr ?? ""), true);
  check("... before creating the index DB", fs.existsSync(path.join(dir, "x.db")), false);
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- report ------------------------------------------------------------------
console.log(`\nResults: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll approval token tests passed!");
