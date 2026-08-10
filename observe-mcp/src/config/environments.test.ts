import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";

import { PolicyViolationError } from "../middleware/errors.js";
import {
  assertEnvironment,
  buildEnvironmentRegistry,
  canonicalEnvName,
  maskEnvironment,
  parseEnvironmentSpec
} from "./environments.js";

/**
 * Run `fn` with only the given `OBSERVE_*` variables set. Every existing
 * `OBSERVE_*` is removed first so a developer's real credentials in the shell
 * cannot make a test pass that would fail in CI.
 *
 * Note `delete` rather than assigning undefined: Node coerces
 * `process.env.X = undefined` to the string "undefined", which every check here
 * would read as a configured value.
 */
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OBSERVE_")) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, saved.has(key) ? saved.get(key) : process.env[key]);
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("OBSERVE_")) {
        delete process.env[key];
      }
    }
    for (const [key, value] of saved) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
  }
}

const AUTH = { OBSERVE_AUTH_BASIC: "dGVzdDp0ZXN0" };
const FLAT = {
  OBSERVE_BASE_URL: "https://obs.example:10443",
  OBSERVE_ORG: "org-flat",
  OBSERVE_LOG_STREAM: "flat_logs"
};

// --- canonicalEnvName ---------------------------------------------------------

test("canonicalEnvName folds deployment synonyms and lowercases the rest", () => {
  assert.equal(canonicalEnvName("Development"), "dev");
  assert.equal(canonicalEnvName("DEV"), "dev");
  assert.equal(canonicalEnvName("Production"), "prod");
  assert.equal(canonicalEnvName("stg"), "staging");
  // Project-specific names pass through apart from case.
  assert.equal(canonicalEnvName("WECRM_AU_PROD"), "wecrm_au_prod");
  assert.equal(canonicalEnvName("  ssdev_au "), "ssdev_au");
});

// --- parseEnvironmentSpec -----------------------------------------------------

test("parseEnvironmentSpec: reads every key, camel or snake", () => {
  const spec = parseEnvironmentSpec(
    "baseUrl=https://a.example:10443;org=abc;log_stream=logs_x;traceStream=traces_x",
    "OBSERVE_ENV_X"
  );
  assert.deepEqual(spec, {
    baseUrl: "https://a.example:10443",
    org: "abc",
    logStream: "logs_x",
    traceStream: "traces_x"
  });
});

test("parseEnvironmentSpec: splits on the FIRST '=' so a URL survives intact", () => {
  // The regression this guards: splitting on every "=" would truncate any value
  // containing one, e.g. a query string on the base URL.
  const spec = parseEnvironmentSpec("url=https://a.example:10443/x?a=b&c=d;org=o;stream=s", "OBSERVE_ENV_X");
  assert.equal(spec.baseUrl, "https://a.example:10443/x?a=b&c=d");
  assert.equal(spec.org, "o");
  assert.equal(spec.logStream, "s");
});

test("parseEnvironmentSpec: tolerates trailing and doubled separators", () => {
  const spec = parseEnvironmentSpec("baseUrl=https://a.example;;org=o;stream=s;", "OBSERVE_ENV_X");
  assert.equal(spec.org, "o");
});

test("parseEnvironmentSpec: an unknown key throws and names the accepted ones", () => {
  // A typo must not silently produce an environment missing a stream.
  assert.throws(
    () => parseEnvironmentSpec("baseUrl=https://a.example;org=o;logstrem=s", "OBSERVE_ENV_X"),
    (error: unknown) => {
      assert.ok(error instanceof PolicyViolationError);
      assert.match(error.message, /unknown key "logstrem"/);
      assert.match(error.message, /Accepted keys: baseUrl, org, logStream/);
      return true;
    }
  );
});

test("parseEnvironmentSpec: rejects a non-pair and an empty value", () => {
  assert.throws(() => parseEnvironmentSpec("baseUrl=https://a;justnoise", "OBSERVE_ENV_X"), PolicyViolationError);
  assert.throws(() => parseEnvironmentSpec("baseUrl=;org=o", "OBSERVE_ENV_X"), PolicyViolationError);
});

// --- registry construction ----------------------------------------------------

test("the flat vars register as one environment named 'default'", () => {
  const reg = withEnv({ ...AUTH, ...FLAT }, buildEnvironmentRegistry);
  assert.deepEqual([...reg.environments.keys()], ["default"]);
  assert.equal(reg.defaultEnvironment, "default");
  const env = reg.environments.get("default");
  assert.equal(env?.org, "org-flat");
  assert.equal(env?.source, "flat");
  // No traceStream set → falls back to the logs stream, and says so.
  assert.equal(env?.traceStream, "flat_logs");
  assert.equal(env?.traceStreamConfigured, false);
});

test("OBSERVE_PRIMARY_ENV_NAME names the flat environment", () => {
  const reg = withEnv({ ...AUTH, ...FLAT, OBSERVE_PRIMARY_ENV_NAME: "ssdev_au" }, buildEnvironmentRegistry);
  assert.deepEqual([...reg.environments.keys()], ["ssdev_au"]);
  assert.equal(reg.defaultEnvironment, "ssdev_au");
});

test("a trailing slash on the base URL is normalized away", () => {
  const reg = withEnv({ ...AUTH, ...FLAT, OBSERVE_BASE_URL: "https://obs.example:10443///" }, buildEnvironmentRegistry);
  assert.equal(reg.environments.get("default")?.baseUrl, "https://obs.example:10443");
});

test("the OBSERVE_ENV_* family adds environments alongside the flat one", () => {
  const reg = withEnv(
    {
      ...AUTH,
      ...FLAT,
      OBSERVE_PRIMARY_ENV_NAME: "ssdev_au",
      OBSERVE_ENV_WECRM_AU_PROD: "baseUrl=https://obs.example:10443;org=org-prod;logStream=prod_logs;traceStream=prod_traces"
    },
    buildEnvironmentRegistry
  );
  assert.deepEqual([...reg.environments.keys()].sort(), ["ssdev_au", "wecrm_au_prod"]);
  const prod = reg.environments.get("wecrm_au_prod");
  assert.equal(prod?.org, "org-prod");
  assert.equal(prod?.traceStreamConfigured, true);
  assert.equal(prod?.source, "env-family");
  assert.equal(prod?.sourceDetail, "OBSERVE_ENV_WECRM_AU_PROD");
});

test("the family overrides the flat vars for the same environment name", () => {
  const reg = withEnv(
    {
      ...AUTH,
      ...FLAT,
      OBSERVE_PRIMARY_ENV_NAME: "dev",
      OBSERVE_ENV_DEV: "baseUrl=https://obs.example;org=org-family;logStream=family_logs"
    },
    buildEnvironmentRegistry
  );
  assert.equal(reg.environments.size, 1);
  assert.equal(reg.environments.get("dev")?.org, "org-family");
});

test("a control variable inside the OBSERVE_ENV_ namespace is not an environment", () => {
  // /^OBSERVE_ENV_(.+)$/ would otherwise register an environment called "name".
  const reg = withEnv({ ...AUTH, ...FLAT, OBSERVE_ENV_NAME: "whatever" }, buildEnvironmentRegistry);
  assert.deepEqual([...reg.environments.keys()], ["default"]);
});

test("an environment missing a required key fails loudly, naming the key", () => {
  assert.throws(
    () => withEnv({ ...AUTH, OBSERVE_ENV_BROKEN: "baseUrl=https://a.example;org=o" }, buildEnvironmentRegistry),
    (error: unknown) => {
      assert.ok(error instanceof PolicyViolationError);
      assert.match(error.message, /Environment 'broken'.*missing required key: logStream/);
      return true;
    }
  );
});

test("no configuration at all throws with the fix in the message", () => {
  assert.throws(
    () => withEnv({ ...AUTH }, buildEnvironmentRegistry),
    (error: unknown) => {
      assert.ok(error instanceof PolicyViolationError);
      assert.match(error.message, /No OpenObserve environments configured/);
      assert.match(error.message, /OBSERVE_BASE_URL \+ OBSERVE_ORG \+ OBSERVE_LOG_STREAM/);
      return true;
    }
  );
});

test("there is no fallback host, org or stream — a partial config cannot silently work", () => {
  // The previous version defaulted all three, so a wrong install quietly queried
  // an org that no longer existed instead of failing at startup.
  assert.throws(
    () => withEnv({ ...AUTH, OBSERVE_BASE_URL: "https://obs.example" }, buildEnvironmentRegistry),
    PolicyViolationError
  );
});

test("missing credentials are reported per environment", () => {
  assert.throws(
    () => withEnv({ ...FLAT }, buildEnvironmentRegistry),
    (error: unknown) => {
      assert.ok(error instanceof PolicyViolationError);
      assert.match(error.message, /No OpenObserve credentials configured for environment 'default'/);
      return true;
    }
  );
});

test("a per-environment credential overrides the shared one", () => {
  const reg = withEnv(
    {
      ...AUTH,
      OBSERVE_ENV_A: "baseUrl=https://a.example;org=a;stream=a_logs;username=u;password=p",
      OBSERVE_ENV_B: "baseUrl=https://b.example;org=b;stream=b_logs"
    },
    buildEnvironmentRegistry
  );
  assert.equal(reg.environments.get("a")?.authHeader, `Basic ${Buffer.from("u:p").toString("base64")}`);
  // B falls back to the shared token, which is the point of the fallback.
  assert.equal(reg.environments.get("b")?.authHeader, "Basic dGVzdDp0ZXN0");
});

// --- allowlist and default selection ------------------------------------------

test("OBSERVE_ALLOWED_ENVIRONMENTS filters at registration, so the env does not exist", () => {
  const reg = withEnv(
    {
      ...AUTH,
      OBSERVE_ENV_DEV: "baseUrl=https://a.example;org=a;stream=a_logs",
      OBSERVE_ENV_PROD: "baseUrl=https://b.example;org=b;stream=b_logs",
      OBSERVE_ALLOWED_ENVIRONMENTS: "dev"
    },
    buildEnvironmentRegistry
  );
  assert.deepEqual([...reg.environments.keys()], ["dev"]);
  assert.throws(() => assertEnvironment(reg, "prod"), PolicyViolationError);
});

test("an allowlist that matches nothing says so, distinctly from 'nothing configured'", () => {
  assert.throws(
    () =>
      withEnv(
        { ...AUTH, ...FLAT, OBSERVE_ALLOWED_ENVIRONMENTS: "nosuch" },
        buildEnvironmentRegistry
      ),
    (error: unknown) => {
      assert.ok(error instanceof PolicyViolationError);
      assert.match(error.message, /matched OBSERVE_ALLOWED_ENVIRONMENTS/);
      return true;
    }
  );
});

test("OBSERVE_DEFAULT_ENVIRONMENT is honoured when it exists", () => {
  const reg = withEnv(
    {
      ...AUTH,
      OBSERVE_ENV_DEV: "baseUrl=https://a.example;org=a;stream=a_logs",
      OBSERVE_ENV_WECRM_AU_PROD: "baseUrl=https://b.example;org=b;stream=b_logs",
      OBSERVE_DEFAULT_ENVIRONMENT: "wecrm_au_prod"
    },
    buildEnvironmentRegistry
  );
  assert.equal(reg.defaultEnvironment, "wecrm_au_prod");
});

test("a typo'd default degrades to the fallback chain instead of breaking every call", () => {
  const reg = withEnv(
    {
      ...AUTH,
      OBSERVE_ENV_DEV: "baseUrl=https://a.example;org=a;stream=a_logs",
      OBSERVE_DEFAULT_ENVIRONMENT: "wecrm_au_prud"
    },
    buildEnvironmentRegistry
  );
  assert.equal(reg.defaultEnvironment, "dev");
});

test("the default falls back dev -> default -> first registered", () => {
  const onlyOther = withEnv(
    { ...AUTH, OBSERVE_ENV_SSDEV_AU: "baseUrl=https://a.example;org=a;stream=a_logs" },
    buildEnvironmentRegistry
  );
  assert.equal(onlyOther.defaultEnvironment, "ssdev_au");

  const withDefaultName = withEnv({ ...AUTH, ...FLAT }, buildEnvironmentRegistry);
  assert.equal(withDefaultName.defaultEnvironment, "default");
});

// --- masking -------------------------------------------------------------------

test("maskEnvironment cannot leak the auth header — it is never selected", () => {
  const reg = withEnv({ ...AUTH, ...FLAT }, buildEnvironmentRegistry);
  const env = reg.environments.get("default");
  assert.ok(env);
  const masked = maskEnvironment(env, true);
  assert.equal(JSON.stringify(masked).includes("Basic"), false);
  assert.equal((masked as Record<string, unknown>).authHeader, undefined);
  assert.equal(masked.isDefault, true);
  assert.equal(masked.sourceDetail, "OBSERVE_BASE_URL/OBSERVE_ORG/OBSERVE_LOG_STREAM");
});

test("assertEnvironment names the known environments when one is missing", () => {
  const reg = withEnv({ ...AUTH, ...FLAT }, buildEnvironmentRegistry);
  assert.throws(
    () => assertEnvironment(reg, "nope"),
    (error: unknown) => {
      assert.ok(error instanceof PolicyViolationError);
      assert.equal(error.code, "unknown_environment");
      assert.match(error.message, /Known environments: default\./);
      return true;
    }
  );
});
