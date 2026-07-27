import assert from "node:assert/strict";
import { test } from "node:test";

import { createEnvReader } from "./env.js";
import { PlatformError, isPlatformError, toPlatformError, validationError } from "./errors.js";
import { isPlainObject, normalizePayload, stableStringify } from "./json.js";
import { resolveBound } from "./limits.js";
import { createLogger } from "./logging.js";
import { isPathWithin, toPosixPath } from "./paths.js";
import { parseResponseProfile, shouldPrettyPrint } from "./profiles.js";
import { maskSecret, redactObject } from "./redaction.js";
import { allOk, err, isErr, isOk, ok } from "./result.js";

test("result: ok/err narrow correctly", () => {
  assert.equal(isOk(ok(1)), true);
  assert.equal(isErr(err("boom")), true);
  const collected = allOk([ok(1), ok(2)]);
  assert.deepEqual(collected.ok ? collected.value : null, [1, 2]);
  assert.equal(allOk([ok(1), err("x")]).ok, false);
});

test("errors: audience and retryability default from the code", () => {
  const validation = validationError("bad input", { field: "limit" });
  assert.equal(validation.code, "validation_error");
  assert.equal(validation.audience, "user");
  assert.equal(validation.retryable, false);

  const upstream = new PlatformError({ code: "upstream_error", message: "gateway" });
  assert.equal(upstream.audience, "developer");
  assert.equal(upstream.retryable, true);

  assert.deepEqual(validation.toPayload(), {
    code: "validation_error",
    message: "bad input",
    audience: "user",
    retryable: false,
    details: { field: "limit" }
  });
});

test("errors: toPlatformError never leaks the original message", () => {
  const wrapped = toPlatformError(new Error("connection string=secret"));
  assert.equal(isPlatformError(wrapped), true);
  assert.equal(wrapped.code, "internal_error");
  assert.equal(wrapped.message.includes("secret"), false);
});

test("redaction: secret-shaped keys and values are masked", () => {
  const redacted = redactObject({
    host: "localhost",
    password: "hunter2-very-long-secret",
    nested: { apiToken: "ATATT-abcdefghijklmnop", keep: 42 }
  });
  assert.equal(redacted["host"], "localhost");
  assert.notEqual(redacted["password"], "hunter2-very-long-secret");
  const nested = redacted["nested"] as Record<string, unknown>;
  assert.equal(nested["keep"], 42);
  assert.notEqual(nested["apiToken"], "ATATT-abcdefghijklmnop");
});

test("redaction: cycles do not hang", () => {
  const cyclic: Record<string, unknown> = { name: "root" };
  cyclic["self"] = cyclic;
  const redacted = redactObject(cyclic);
  assert.equal(redacted["self"], "[circular]");
});

test("redaction: short secrets are fully masked", () => {
  assert.equal(maskSecret("abcd"), "***");
  assert.equal(maskSecret(""), "");
  assert.equal(maskSecret("abcdefghijklmnop").includes("***"), true);
});

test("env: reads are trimmed, typed, and bounded", () => {
  const env = createEnvReader({
    NAME: "  observe  ",
    EMPTY: "   ",
    COUNT: "250",
    FLAG: "TRUE",
    LIST: "a, b ,, c"
  });
  assert.equal(env.string("NAME", "fallback"), "observe");
  assert.equal(env.string("EMPTY", "fallback"), "fallback");
  assert.equal(env.number("COUNT", 10, { max: 100 }), 100);
  assert.equal(env.number("MISSING", 7), 7);
  assert.equal(env.boolean("FLAG", false), true);
  assert.deepEqual(env.list("LIST"), ["a", "b", "c"]);
  assert.equal(env.requireString("MISSING").ok, false);
  assert.deepEqual(env.presentKeys(), ["COUNT", "FLAG", "LIST", "NAME"]);
  assert.equal(env.anyPresent(["NOPE", "FLAG"]), true);
});

test("logging: writes JSON to the injected sink and redacts fields", () => {
  const lines: string[] = [];
  const logger = createLogger({
    name: "test",
    level: "debug",
    sink: (line) => lines.push(line),
    clock: () => new Date("2026-01-01T00:00:00.000Z")
  });
  logger.info("started", { password: "super-secret-value" });
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(record["level"], "info");
  assert.equal(record["msg"], "started");
  assert.equal(JSON.stringify(record).includes("super-secret-value"), false);
});

test("logging: level threshold suppresses lower records", () => {
  const lines: string[] = [];
  const logger = createLogger({ name: "test", level: "warn", sink: (line) => lines.push(line) });
  logger.debug("nope");
  logger.info("nope");
  logger.warn("yes");
  assert.equal(lines.length, 1);
});

test("profiles: compact is the default and only verbose pretty-prints", () => {
  assert.equal(parseResponseProfile(undefined), "compact");
  assert.equal(parseResponseProfile("nonsense"), "compact");
  assert.equal(parseResponseProfile("verbose"), "verbose");
  assert.equal(shouldPrettyPrint("verbose"), true);
  assert.equal(shouldPrettyPrint("compact"), false);
});

test("limits: requests are clamped to the spec", () => {
  const spec = { defaultValue: 50, max: 200, min: 1 };
  assert.equal(resolveBound(undefined, spec).value, 50);
  assert.equal(resolveBound(1000, spec).value, 200);
  assert.equal(resolveBound(1000, spec).clamped, true);
  assert.equal(resolveBound(0, spec).value, 1);
  assert.equal(resolveBound("30", spec).value, 30);
});

test("json: normalization drops nullish and rewrites path keys", () => {
  const normalized = normalizePayload(
    { filePath: "src\\a\\b.ts", empty: null, keep: 1 },
    { dropNullish: true, pathKeys: ["filePath"] }
  ) as Record<string, unknown>;
  assert.equal(normalized["filePath"], "src/a/b.ts");
  assert.equal("empty" in normalized, false);
  assert.equal(normalized["keep"], 1);
});

test("json: stableStringify is order-independent", () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject([]), false);
});

test("json: a repeated reference is NOT a cycle", () => {
  // Regression: `seen` used to be add-only, so a node legitimately reused in a
  // sibling position (a symbol referenced by an edge) serialized as
  // "[circular]" and the client silently lost the object.
  const shared = { id: "n1", name: "foo" };
  const normalized = normalizePayload({
    nodes: [shared, { id: "n2" }],
    edges: [{ from: shared, to: { id: "n2" } }]
  }) as { edges: { from: unknown }[] };
  assert.deepEqual(normalized.edges[0]?.from, { id: "n1", name: "foo" });

  const twice = normalizePayload({ a: shared, b: shared }) as Record<string, unknown>;
  assert.deepEqual(twice["b"], { id: "n1", name: "foo" });
});

test("json: a true ancestor cycle is still caught", () => {
  const cyclic: Record<string, unknown> = { name: "root" };
  cyclic["self"] = cyclic;
  const normalized = normalizePayload(cyclic) as Record<string, unknown>;
  assert.equal(normalized["self"], "[circular]");
});

test("json: array holes become null instead of reindexing the array", () => {
  // Dropping would shift elements, so element n of the response would no
  // longer correspond to element n of the source.
  assert.deepEqual(normalizePayload({ rows: [1, undefined, 3] }), { rows: [1, null, 3] });
  assert.deepEqual(normalizePayload([1, undefined, 3]), [1, null, 3]);
});

test("redaction: a repeated reference is NOT a cycle", () => {
  const shared = { path: "a" };
  const redacted = redactObject({ a: shared, b: shared });
  assert.deepEqual(redacted["b"], { path: "a" });
});

test("redaction: credentials embedded in a URI are masked anywhere they appear", () => {
  const redacted = redactObject({
    url: "postgres://admin:S3cretPass@db.internal:5432/app",
    baseUrl: "https://user:hunter2@api.example.com",
    message: "failed to connect using postgresql://u:p4ssw0rd@h/db"
  });
  const serialized = JSON.stringify(redacted);
  for (const secret of ["S3cretPass", "hunter2", "p4ssw0rd"]) {
    assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
  }
  // Scheme, user and host survive - the diagnostic value is the point.
  assert.equal(String(redacted["url"]).includes("postgres://admin:***@db.internal"), true);
});

test("redaction: a URL without credentials is left intact", () => {
  const redacted = redactObject({ baseUrl: "https://api.internal.example/v2" });
  assert.equal(redacted["baseUrl"], "https://api.internal.example/v2");
});

test("paths: containment respects segment boundaries", () => {
  assert.equal(toPosixPath("D:\\a\\b"), "D:/a/b");
  assert.equal(isPathWithin("/foo", "/foo/bar"), true);
  assert.equal(isPathWithin("/foo", "/foobar"), false);
  assert.equal(isPathWithin("/foo", "/foo"), true);
});
