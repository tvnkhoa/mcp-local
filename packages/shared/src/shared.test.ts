import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { createApprovalService, resolveApprovalSecret } from "./approval/index.js";
import { createPathAllowlist } from "./fs/index.js";
import { computeBackoffMs, createHttpClient, isRetryableStatus } from "./http/index.js";
import { createReadOnlySqlValidator, stripStringsAndComments } from "./sql/index.js";

// --- approval -------------------------------------------------------------

function fixedClock(start: number): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    }
  };
}

test("approval: a freshly issued token verifies for its subject", () => {
  const clock = fixedClock(1_000);
  const service = createApprovalService({ secret: "test-secret", ttlMs: 60_000, clock: clock.now });
  const issued = service.issue("preview-123", { rows: 4 });

  const verified = service.verify(issued.token, "preview-123");
  assert.equal(verified.ok, true);
  if (verified.ok) {
    assert.equal(verified.value.subject, "preview-123");
    assert.equal(verified.value.extra["rows"], 4);
  }
});

test("approval: a token for another subject is rejected", () => {
  const service = createApprovalService({ secret: "test-secret", ttlMs: 60_000 });
  const issued = service.issue("preview-123");
  const verified = service.verify(issued.token, "preview-999");
  assert.equal(verified.ok, false);
  if (!verified.ok) {
    assert.equal(verified.error.code, "policy_violation");
  }
});

test("approval: a tampered signature is rejected", () => {
  const service = createApprovalService({ secret: "test-secret", ttlMs: 60_000 });
  const issued = service.issue("preview-123");
  const tampered = `${issued.token.slice(0, -4)}AAAA`;
  const verified = service.verify(tampered, "preview-123");
  assert.equal(verified.ok, false);
});

test("approval: a token signed with a different secret is rejected", () => {
  const issuer = createApprovalService({ secret: "secret-a", ttlMs: 60_000 });
  const verifier = createApprovalService({ secret: "secret-b", ttlMs: 60_000 });
  const issued = issuer.issue("preview-123");
  assert.equal(verifier.verify(issued.token, "preview-123").ok, false);
});

test("approval: an expired token is rejected", () => {
  const clock = fixedClock(1_000);
  const service = createApprovalService({ secret: "test-secret", ttlMs: 1_000, clock: clock.now });
  const issued = service.issue("preview-123");
  clock.advance(1_500);
  const verified = service.verify(issued.token, "preview-123");
  assert.equal(verified.ok, false);
  if (!verified.ok) {
    assert.equal(verified.error.code, "policy_violation");
  }
});

test("approval: malformed tokens are rejected as validation errors", () => {
  const service = createApprovalService({ secret: "test-secret", ttlMs: 60_000 });
  for (const bad of ["", "abc", "v1.only-two", "v2.a.b"]) {
    assert.equal(service.verify(bad, "preview-123").ok, false);
  }
});

test("approval: an unset secret yields an ephemeral generated one", () => {
  assert.equal(resolveApprovalSecret(undefined).generated, true);
  assert.equal(resolveApprovalSecret("   ").generated, true);
  assert.deepEqual(resolveApprovalSecret("configured"), { secret: "configured", generated: false });
});

// --- sql guardrails -------------------------------------------------------

const postgresPolicy = {
  name: "postgres",
  allowedLeadingKeywords: ["select", "with"],
  forbiddenTokens: [
    "insert", "update", "delete", "truncate", "alter", "drop", "create",
    "grant", "revoke", "comment", "copy", "call", "do", "vacuum",
    "analyze", "reindex", "refresh", "merge"
  ]
};

test("sql: string literals and comments are blanked before token scanning", () => {
  const cleaned = stripStringsAndComments("select 'drop table x' -- delete\nfrom t");
  assert.equal(cleaned.includes("drop"), false);
  assert.equal(cleaned.includes("delete"), false);
  assert.equal(cleaned.includes("select"), true);
  assert.equal(cleaned.includes("from t"), true);
});

test("sql: valid read-only statements pass", () => {
  const validate = createReadOnlySqlValidator(postgresPolicy);
  assert.equal(validate("SELECT id FROM users LIMIT 10").ok, true);
  assert.equal(validate("WITH x AS (SELECT 1) SELECT * FROM x").ok, true);
  const trailing = validate("SELECT 1;");
  assert.equal(trailing.ok, true);
  if (trailing.ok) {
    assert.equal(trailing.value.sanitizedSql, "SELECT 1");
  }
});

test("sql: writes, multi-statements, and empties are rejected", () => {
  const validate = createReadOnlySqlValidator(postgresPolicy);
  for (const bad of [
    "",
    "   ",
    "DELETE FROM users",
    "SELECT 1; DROP TABLE users",
    "UPDATE users SET name = 'x'",
    "SELECT 1 -- ok\n; SELECT 2"
  ]) {
    assert.equal(validate(bad).ok, false, `expected rejection for: ${bad}`);
  }
});

test("sql: a keyword hidden in a literal does not trip the guard", () => {
  const validate = createReadOnlySqlValidator(postgresPolicy);
  assert.equal(validate("SELECT * FROM t WHERE note = 'please delete me'").ok, true);
});

test("sql: dollar-quoted strings cannot smuggle a second statement", () => {
  // Regression: the scanner knew '..' and "..", but not $$..$$ / $tag$..$tag$.
  // An apostrophe inside a dollar quote opened a phantom string that swallowed
  // the rest of the statement, so DROP TABLE was invisible to every check.
  const validate = createReadOnlySqlValidator(postgresPolicy);
  for (const bad of [
    "SELECT $$'$$; DROP TABLE t",
    "SELECT $q$don't$q$; DROP TABLE t",
    "SELECT $$ x $$; DELETE FROM users",
    "SELECT $tag$ '); DROP TABLE t; -- $tag$, drop"
  ]) {
    assert.equal(validate(bad).ok, false, `expected rejection for: ${bad}`);
  }
});

test("sql: a legitimate dollar-quoted literal is still accepted", () => {
  const validate = createReadOnlySqlValidator(postgresPolicy);
  assert.equal(validate("SELECT $$plain text$$ AS note").ok, true);
  assert.equal(validate("SELECT $msg$it's fine$msg$ AS note").ok, true);
  // A keyword hidden inside the literal must not trip the guard.
  assert.equal(validate("SELECT $$drop table x$$ AS note").ok, true);
});

test("sql: $1 placeholders are not mistaken for dollar quotes", () => {
  const validate = createReadOnlySqlValidator(postgresPolicy);
  assert.equal(validate("SELECT * FROM t WHERE id = $1").ok, true);
});

test("sql: unterminated literals and comments are refused", () => {
  const validate = createReadOnlySqlValidator(postgresPolicy);
  for (const bad of ["SELECT 'unclosed", "SELECT $$unclosed", "SELECT 1 /* unclosed"]) {
    assert.equal(validate(bad).ok, false, `expected rejection for: ${bad}`);
  }
});

test("sql: E'' escape strings cannot hide a delimiter", () => {
  const validate = createReadOnlySqlValidator(postgresPolicy);
  assert.equal(validate("SELECT E'it\\'s'; DROP TABLE t").ok, false);
  assert.equal(validate("SELECT E'plain' AS note").ok, true);
});

test("sql: tokens containing regex metacharacters do not crash the validator", () => {
  const validate = createReadOnlySqlValidator({
    name: "postgres",
    allowedLeadingKeywords: ["select"],
    forbiddenTokens: ["pg_read_file(", "dblink(", "pg_sleep("]
  });
  assert.doesNotThrow(() => validate("SELECT 1"));
  assert.equal(validate("SELECT 1").ok, true);
  assert.equal(validate("SELECT pg_read_file('/etc/passwd')").ok, false);
});

test("sql: policy is a parameter - two dialects diverge explicitly", () => {
  const strict = createReadOnlySqlValidator(postgresPolicy);
  const lenient = createReadOnlySqlValidator({
    name: "openobserve",
    allowedLeadingKeywords: ["select"],
    forbiddenTokens: ["insert", "update", "delete"]
  });
  // "vacuum" is forbidden by the Postgres policy but not the OpenObserve one.
  assert.equal(strict("SELECT vacuum FROM t").ok, false);
  assert.equal(lenient("SELECT vacuum FROM t").ok, true);
});

// --- http client ----------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("http: a successful request returns a parsed body", async () => {
  const client = createHttpClient({
    baseUrl: "https://internal.example/api",
    timeoutMs: 1_000,
    fetchImpl: async () => jsonResponse(200, { hello: "world" })
  });
  const result = await client.get<{ hello: string }>("/thing");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.body.hello, "world");
    assert.equal(result.value.attempts, 0);
  }
});

test("http: retryable statuses are retried up to maxRetries", async () => {
  let calls = 0;
  const client = createHttpClient({
    baseUrl: "https://internal.example",
    timeoutMs: 1_000,
    maxRetries: 2,
    sleepImpl: async () => undefined,
    randomImpl: () => 0.5,
    fetchImpl: async () => {
      calls += 1;
      return calls < 3 ? jsonResponse(503, { error: "unavailable" }) : jsonResponse(200, { ok: true });
    }
  });
  const result = await client.get("/thing");
  assert.equal(result.ok, true);
  assert.equal(calls, 3);
});

test("http: non-retryable statuses fail immediately", async () => {
  let calls = 0;
  const client = createHttpClient({
    baseUrl: "https://internal.example",
    timeoutMs: 1_000,
    maxRetries: 3,
    sleepImpl: async () => undefined,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(404, { error: "missing" });
    }
  });
  const result = await client.get("/thing");
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
});

test("http: a POST is NOT retried - a failed write may already have committed", async () => {
  let calls = 0;
  const client = createHttpClient({
    baseUrl: "https://internal.example",
    timeoutMs: 1_000,
    maxRetries: 3,
    sleepImpl: async () => undefined,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(503, { error: "unavailable" });
    }
  });
  const result = await client.post("/pulls", { title: "x" });
  assert.equal(result.ok, false);
  assert.equal(calls, 1, "a 503 on POST must not be replayed");
});

test("http: a non-idempotent method can opt in to retry explicitly", async () => {
  let calls = 0;
  const client = createHttpClient({
    baseUrl: "https://internal.example",
    timeoutMs: 1_000,
    maxRetries: 2,
    sleepImpl: async () => undefined,
    randomImpl: () => 0.5,
    fetchImpl: async () => {
      calls += 1;
      return calls < 3 ? jsonResponse(503, {}) : jsonResponse(200, { ok: true });
    }
  });
  const result = await client.request({ method: "POST", path: "/x", body: {}, idempotent: true });
  assert.equal(result.ok, true);
  assert.equal(calls, 3);
});

test("http: the upstream error body never reaches the returned error", async () => {
  // `details` is serialized straight to the MCP client, and a 401 body commonly
  // echoes the submitted credential.
  const client = createHttpClient({
    baseUrl: "https://internal.example",
    timeoutMs: 1_000,
    maxRetries: 0,
    fetchImpl: async () =>
      new Response('{"error":"token abc123SECRET rejected"}', {
        status: 401,
        headers: { "content-type": "application/json" }
      })
  });
  const result = await client.get("/x");
  assert.equal(result.ok, false);
  if (!result.ok) {
    const serialized = JSON.stringify(result.error.toPayload());
    assert.equal(serialized.includes("abc123SECRET"), false, "upstream body leaked to the caller");
    assert.equal(serialized.includes("401"), true, "status should still be reported");
  }
});

test("http: a per-request authorization header overrides the client credential", async () => {
  let seen = "";
  const client = createHttpClient({
    baseUrl: "https://internal.example",
    timeoutMs: 1_000,
    authHeader: "Bearer CLIENT",
    fetchImpl: async (_url, init) => {
      seen = String((init?.headers as Record<string, string>)["authorization"]);
      return jsonResponse(200, {});
    }
  });
  await client.request({ method: "GET", path: "/x", headers: { authorization: "Bearer PERREQ" } });
  assert.equal(seen, "Bearer PERREQ");
});

test("http: describe() masks credentials embedded in the base URL", () => {
  const client = createHttpClient({
    baseUrl: "https://svc:hunter2@internal.example",
    timeoutMs: 1_000
  });
  const described = JSON.stringify(client.describe());
  assert.equal(described.includes("hunter2"), false);
  assert.equal(described.includes("internal.example"), true);
});

test("http: describe() never exposes the auth header", () => {
  const client = createHttpClient({
    baseUrl: "https://internal.example",
    timeoutMs: 1_000,
    authHeader: "Bearer super-secret-token-value"
  });
  const described = JSON.stringify(client.describe());
  assert.equal(described.includes("super-secret-token-value"), false);
  assert.equal(described.includes("authConfigured"), true);
});

test("http: backoff grows and stays capped", () => {
  const random = () => 1;
  assert.equal(computeBackoffMs(0, 100, 5_000, random), 100);
  assert.equal(computeBackoffMs(1, 100, 5_000, random), 200);
  assert.equal(computeBackoffMs(10, 100, 5_000, random), 5_000);
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(404), false);
});

// --- path allowlist -------------------------------------------------------

test("fs: paths inside a root resolve, paths outside are refused", () => {
  const root = path.resolve("D:/workspace/repo");
  const allowlist = createPathAllowlist([root]);

  assert.equal(allowlist.resolve(path.join(root, "src", "index.ts")).ok, true);
  assert.equal(allowlist.contains(path.join(root, "src")), true);
  assert.equal(allowlist.resolve(path.resolve("D:/elsewhere/secret.txt")).ok, false);
});

test("fs: traversal escapes are refused after resolution", () => {
  const root = path.resolve("D:/workspace/repo");
  const allowlist = createPathAllowlist([root]);
  const escape = path.join(root, "..", "..", "etc", "passwd");
  assert.equal(allowlist.resolve(escape).ok, false);
});

test("fs: a sibling directory sharing a prefix is not inside the root", () => {
  const allowlist = createPathAllowlist([path.resolve("D:/workspace/repo")]);
  assert.equal(allowlist.contains(path.resolve("D:/workspace/repo-backup/x.ts")), false);
});

test("fs: null bytes and empty paths are refused", () => {
  const allowlist = createPathAllowlist([path.resolve("D:/workspace/repo")]);
  assert.equal(allowlist.resolve("").ok, false);
  assert.equal(allowlist.resolve("a\0b").ok, false);
});

test("fs: a relative or empty root is a startup failure", () => {
  assert.throws(() => createPathAllowlist([]));
  assert.throws(() => createPathAllowlist(["relative/path"]));
});
