import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { SERVERS, WORKSPACE_ROOT, evaluateEnv, getServer, serverDirPath, serverEntryPath, serverKeys } from "./index.js";
import type { ServerDescriptor } from "./types.js";

const byKey = (key: string): ServerDescriptor => {
  const server = getServer(key);
  assert.ok(server, `manifest has no server "${key}"`);
  return server;
};

// --- WORKSPACE_ROOT ----------------------------------------------------------
// The one genuinely fragile value in the package: it counts `..` segments from this module, so
// it breaks silently if the emitted layout gains a level or the package moves. Type-checking
// cannot see that, which is why it is asserted against the real directory.

test("WORKSPACE_ROOT points at the actual workspace root", () => {
  assert.ok(
    existsSync(path.join(WORKSPACE_ROOT, "tsconfig.base.json")),
    `no tsconfig.base.json under ${WORKSPACE_ROOT} — the '..' depth in paths.ts is wrong`
  );
  const pkg = JSON.parse(readFileSync(path.join(WORKSPACE_ROOT, "package.json"), "utf8")) as { name?: string };
  assert.equal(pkg.name, "mcp-local", `resolved ${WORKSPACE_ROOT}, which is not the workspace root`);
});

test("WORKSPACE_ROOT resolves the same from src and dist", () => {
  // Both layouts sit exactly three levels under the root. Asserting the shape rather than the
  // string keeps this meaningful on any checkout path.
  assert.equal(path.basename(path.dirname(WORKSPACE_ROOT)) !== "packages", true);
  assert.ok(existsSync(path.join(WORKSPACE_ROOT, "packages", "manifest", "package.json")));
});

// --- the data itself ---------------------------------------------------------

test("every declared server directory, entry and skill template exists", () => {
  for (const server of SERVERS) {
    assert.ok(existsSync(serverDirPath(server)), `${server.key}: dir "${server.dir}" is missing`);
    assert.ok(
      existsSync(path.join(WORKSPACE_ROOT, server.skillSource, "SKILL.md")),
      `${server.key}: no SKILL.md under "${server.skillSource}" — the installer renders it`
    );
    // The build output itself is gitignored, so only the path shape is asserted here.
    assert.match(server.entry, /^dist\//, `${server.key}: entry should be under dist/`);
  }
});

test("keys are unique, and so are env names within a server", () => {
  assert.equal(new Set(serverKeys()).size, SERVERS.length, "duplicate server key");
  for (const server of SERVERS) {
    const names = server.env.map((f) => f.name);
    assert.equal(new Set(names).size, names.length, `${server.key}: duplicate env var name`);
  }
});

test("a prefix field is only meaningful inside a group", () => {
  // `PG_ENV_*` is not a real variable name; it stands for a family, and only the group's
  // "one of" check knows how to satisfy it. A prefix field outside a group could never be met.
  for (const server of SERVERS) {
    for (const field of server.env) {
      if (field.prefix !== undefined) {
        assert.ok(field.group, `${server.key}/${field.name}: prefix field must belong to a group`);
      }
    }
  }
});

test("getServer returns null for an unknown key rather than throwing", () => {
  assert.equal(getServer("no-such-server"), null);
});

test("serverEntryPath and serverDirPath are absolute and nested correctly", () => {
  const server = byKey("codebase-index-local");
  assert.ok(path.isAbsolute(serverEntryPath(server)));
  assert.equal(serverDirPath(server), path.join(WORKSPACE_ROOT, "codebase-index-mcp"));
  assert.equal(serverEntryPath(server), path.join(WORKSPACE_ROOT, "codebase-index-mcp", "dist", "index.js"));
});

// --- evaluateEnv -------------------------------------------------------------
// The installer and the doctor share this, so each branch is pinned separately.

test("evaluateEnv: nothing set reports required vars and unsatisfied groups", () => {
  const result = evaluateEnv(byKey("observe-mcp"), []);
  assert.deepEqual([...result.missingRequired].sort(), [
    "OBSERVE_BASE_URL",
    "OBSERVE_LOG_STREAM",
    "OBSERVE_ORG",
    "OBSERVE_TRACE_STREAM"
  ]);
  assert.deepEqual(result.unsatisfiedGroups, ["observe-auth"]);
});

test("evaluateEnv: a grouped var is never reported as individually missing", () => {
  // CODEBASE_INDEX_ALLOWED_ROOTS is `required: true` AND in the "roots" group. The group is what
  // must be satisfied; reporting it twice would make the installer print a contradiction.
  const result = evaluateEnv(byKey("codebase-index-local"), []);
  assert.deepEqual(result.missingRequired, []);
  assert.deepEqual(result.unsatisfiedGroups, ["roots"]);
});

test("evaluateEnv: one group member satisfies the whole group", () => {
  const result = evaluateEnv(byKey("bitbucket-mcp"), ["BITBUCKET_WORKSPACE", "BITBUCKET_EMAIL"]);
  assert.deepEqual(result.missingRequired, []);
  assert.deepEqual(result.unsatisfiedGroups, []);
});

test("evaluateEnv: a prefix family is satisfied by any matching var, not its literal name", () => {
  const postgres = byKey("postgres-mcp");
  // The literal "PG_ENV_*" is never set by anyone; a real per-env var is what counts.
  assert.deepEqual(evaluateEnv(postgres, ["PG_ENV_DEV"]).unsatisfiedGroups, []);
  assert.deepEqual(evaluateEnv(postgres, ["PG_ENV_PROD"]).unsatisfiedGroups, []);
  // The trailing underscore is part of the prefix, so a var that merely starts with the same
  // letters does NOT count. `PG_ENVIRONMENT` is the near-miss worth pinning: it would be an
  // easy thing to "fix" by trimming the prefix to `PG_ENV`, which would then let an unrelated
  // variable pass as a connection source.
  assert.deepEqual(evaluateEnv(postgres, ["PG_ENVIRONMENT"]).unsatisfiedGroups, ["connection-source"]);
  assert.deepEqual(evaluateEnv(postgres, ["PG_WRITE_ENABLED"]).unsatisfiedGroups, ["connection-source"]);
});

test("evaluateEnv: groupMembers lists the alternatives for the installer's message", () => {
  const result = evaluateEnv(byKey("postgres-mcp"), []);
  assert.deepEqual(result.groupMembers("connection-source"), [
    "CH_DB_CONNECTION",
    "CH_APPSETTINGS_ROOTS",
    "PG_ENV_*"
  ]);
  assert.deepEqual(result.groupMembers("no-such-group"), []);
});

// --- config-value hygiene ----------------------------------------------------

test("path defaults are POSIX-separated", () => {
  // These land in ~/.claude.json and in CODEBASE_INDEX_ALLOWED_ROOTS, where a backslash is an
  // escape character. A Windows-separated default would be written and then misread.
  for (const server of SERVERS) {
    for (const field of server.env) {
      if (field.default !== undefined) {
        assert.ok(!field.default.includes("\\"), `${server.key}/${field.name}: default has a backslash`);
      }
    }
  }
});

test("no env default carries a secret value", () => {
  for (const server of SERVERS) {
    for (const field of server.env) {
      if (field.secret === true) {
        assert.equal(
          field.default,
          undefined,
          `${server.key}/${field.name}: a secret must not have a committed default`
        );
      }
    }
  }
});
