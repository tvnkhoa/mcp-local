import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  SERVERS,
  TOTAL_TOOL_COUNT,
  WORKSPACE_ROOT,
  evaluateEnv,
  evaluateEnvValues,
  getServer,
  serverDirPath,
  serverEntryPath,
  serverKeys
} from "./index.js";
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
  // `POSTGRES_ENV_*` is not a real variable name; it stands for a family, and only the group's
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
  const server = byKey("codebase-index");
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
  const result = evaluateEnv(byKey("codebase-index"), []);
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
  // The literal "POSTGRES_ENV_*" is never set by anyone; a real per-env var is what counts.
  assert.deepEqual(evaluateEnv(postgres, ["POSTGRES_ENV_DEV"]).unsatisfiedGroups, []);
  assert.deepEqual(evaluateEnv(postgres, ["POSTGRES_ENV_PROD"]).unsatisfiedGroups, []);
  // The trailing underscore is part of the prefix, so a var that merely starts with the same
  // letters does NOT count. `POSTGRES_ENVIRONMENT` is the near-miss worth pinning: it would be an
  // easy thing to "fix" by trimming the prefix to `POSTGRES_ENV`, which would then let an
  // unrelated variable pass as a connection source.
  assert.deepEqual(evaluateEnv(postgres, ["POSTGRES_ENVIRONMENT"]).unsatisfiedGroups, ["connection-source"]);
  assert.deepEqual(evaluateEnv(postgres, ["POSTGRES_WRITE_ENABLED"]).unsatisfiedGroups, ["connection-source"]);
});

test("evaluateEnv: a deprecated alias satisfies its field (S-43)", () => {
  const postgres = byKey("postgres-mcp");
  // The whole point of S-43's aliases: an install that still carries the pre-rename names is
  // configured, and the installer and doctor must agree with the runtime about that. Reporting
  // "no connection source" on a server that connects fine is worse than the rename itself.
  assert.deepEqual(evaluateEnv(postgres, ["CH_DB_CONNECTION"]).unsatisfiedGroups, []);
  assert.deepEqual(evaluateEnv(postgres, ["CH_APPSETTINGS_ROOTS"]).unsatisfiedGroups, []);
  // A family's alias is the old PREFIX, so it is matched the same way — by prefix, not equality.
  assert.deepEqual(evaluateEnv(postgres, ["PG_ENV_DEV"]).unsatisfiedGroups, []);
  // ...and the same near-miss rule applies to the legacy prefix.
  assert.deepEqual(evaluateEnv(postgres, ["PG_ENVIRONMENT"]).unsatisfiedGroups, ["connection-source"]);
});

test("evaluateEnv: groupMembers lists the alternatives for the installer's message", () => {
  const result = evaluateEnv(byKey("postgres-mcp"), []);
  assert.deepEqual(result.groupMembers("connection-source"), [
    "POSTGRES_CONNECTION",
    "POSTGRES_APPSETTINGS_ROOTS",
    "POSTGRES_ENV_*"
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

// --- generated tool lists (S-36) ---------------------------------------------

test("tool lists match the committed contract snapshots exactly", () => {
  // The manifest's `tools` used to be hand-maintained and had drifted to 12 of 43 for
  // codebase-index. This asserts the generator's output against the same source it read,
  // so a hand-edit to either side fails here rather than silently shipping a wrong skill.
  let total = 0;
  for (const server of SERVERS) {
    const snapshot = JSON.parse(
      readFileSync(path.join(WORKSPACE_ROOT, "contracts", `${server.key}.json`), "utf8")
    ) as { tools: { name: string }[] };
    const expected = snapshot.tools.map((t) => t.name).sort();
    assert.deepEqual([...server.tools], expected, `${server.key}: tool list is stale`);
    total += server.tools.length;
  }
  assert.equal(total, TOTAL_TOOL_COUNT);
  assert.equal(total, 76, "the workspace advertises 76 tools; update this number deliberately");
});

test("codebase-index advertises all 43 of its tools", () => {
  // The specific drift S-36 existed to fix — pinned so it cannot silently return.
  assert.equal(byKey("codebase-index").tools.length, 43);
});

// --- env field hygiene (S-35) -------------------------------------------------

test("no field carries both default and codeDefault", () => {
  // They mean opposite things: `default` is written into the agent config, `codeDefault` documents
  // what the server does when nothing is written. A field with both tells the reader neither.
  for (const server of SERVERS) {
    for (const field of server.env) {
      const both = field.default !== undefined && field.codeDefault !== undefined;
      assert.equal(both, false, `${server.key}/${field.name}: has default AND codeDefault`);
    }
  }
});

test("every env field declares a section", () => {
  // The generated .env.example groups by section; a field without one lands in a fallback bucket
  // and reads like an afterthought.
  for (const server of SERVERS) {
    for (const field of server.env) {
      assert.ok(field.section, `${server.key}/${field.name}: no section`);
    }
  }
});

test("familyExamples belong to prefix fields and match the prefix", () => {
  for (const server of SERVERS) {
    for (const field of server.env) {
      if (field.familyExamples === undefined) continue;
      assert.ok(field.prefix, `${server.key}/${field.name}: familyExamples without a prefix`);
      for (const example of field.familyExamples) {
        assert.ok(
          example.startsWith(field.prefix as string),
          `${server.key}: "${example}" does not start with "${field.prefix}"`
        );
      }
    }
  }
});

test("the env contract covers every server, and grew as S-35 intended", () => {
  // 96 vars across four servers, up from the 41 the manifest declared before S-35. The count is
  // asserted so that dropping a declaration is a test failure rather than a quiet regression in
  // the generated docs. codebase-index gained CODEBASE_INDEX_VECTOR_ENABLED (MCP-ISSUE-035) and
  // CODEBASE_INDEX_MAX_TYPE_REF_EDGES_PER_FILE (MCP-ISSUE-038).
  const counts = Object.fromEntries(SERVERS.map((s) => [s.key, s.env.length]));
  assert.deepEqual(counts, {
    "codebase-index": 41,
    "postgres-mcp": 21,
    "observe-mcp": 23,
    "bitbucket-mcp": 11
  });
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

test("evaluateEnvValues catches a config whose keys are right and values are wrong", () => {
  const cbi = byKey("codebase-index");

  // The shape that passed every check while the install was broken: keys all present, values wrong.
  const bad = evaluateEnvValues(cbi, {
    CODEBASE_INDEX_ALLOWED_ROOTS: "D:/1.SourceCode/mcp-local,,relative/path",
    CODEBASE_INDEX_DOCS_INDEXING_ENABLED: "yep",
    CODEBASE_INDEX_PARSE_TIMEOUT_MS: "5s",
    CODEBASE_INDEX_LARGE_REPO_PROFILE: "turbo"
  });
  const byName = Object.fromEntries(bad.map((f) => [f.name, f.problem]));

  assert.match(byName.CODEBASE_INDEX_ALLOWED_ROOTS ?? "", /empty entry|absolute/);
  // Inferred from `default: "false"` — no annotation needed for the boolean flags.
  assert.match(byName.CODEBASE_INDEX_DOCS_INDEXING_ENABLED ?? "", /boolean/);
  // Inferred from `codeDefault: "5000"`. `booleanFromEnv`/`numberFromEnv` fall back silently, so this
  // knob was simply not applied and nothing said so.
  assert.match(byName.CODEBASE_INDEX_PARSE_TIMEOUT_MS ?? "", /number/);
  assert.match(byName.CODEBASE_INDEX_LARGE_REPO_PROFILE ?? "", /expected one of/);
});

test("evaluateEnvValues never echoes a value it rejects", () => {
  const pg = byKey("postgres-mcp");
  const secretish = "postgres://user:hunter2@db.internal:5432/app";
  const findings = evaluateEnvValues(pg, {
    POSTGRES_APPSETTINGS_ROOTS: secretish, // not a path; will be reported
    POSTGRES_WRITE_ENABLED: secretish
  });
  assert.ok(findings.length > 0, "expected findings to prove the check ran");
  for (const f of findings) {
    assert.ok(!f.problem.includes("hunter2"), `leaked a value: ${f.problem}`);
    assert.ok(!f.problem.includes(secretish), `leaked a value: ${f.problem}`);
  }
});

test("evaluateEnvValues stays silent on a healthy config and on absent vars", () => {
  const cbi = byKey("codebase-index");
  assert.deepEqual(
    evaluateEnvValues(cbi, {
      CODEBASE_INDEX_ALLOWED_ROOTS: "D:/1.SourceCode/mcp-local,/srv/other",
      CODEBASE_INDEX_DOCS_INDEXING_ENABLED: "true",
      CODEBASE_INDEX_PARSE_TIMEOUT_MS: "5000",
      CODEBASE_INDEX_LARGE_REPO_PROFILE: "AUTO" // case-insensitive on purpose
    }),
    []
  );
  // Absence is evaluateEnv's question. Answering it here too would double-report every optional var.
  assert.deepEqual(evaluateEnvValues(cbi, {}), []);
  assert.deepEqual(evaluateEnvValues(cbi, { CODEBASE_INDEX_DOCS_INDEXING_ENABLED: "  " }), []);
});

test("evaluateEnvValues honours deprecated aliases, so a pre-rename config is not misreported", () => {
  const pg = byKey("postgres-mcp");
  // S-43 renamed this; the runtime still reads the old name, so validating only the canonical name
  // would silently skip the check for exactly the operators most likely to have a stale value.
  const findings = evaluateEnvValues(pg, { CH_APPSETTINGS_ROOTS: "not/absolute" });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].name, "POSTGRES_APPSETTINGS_ROOTS");
});
