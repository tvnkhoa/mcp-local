import assert from "node:assert/strict";
import test from "node:test";

import { buildTools } from "./index.js";
import { GATE_PASSING_TOOLS, MAPPED } from "./commandMap.js";
import { argvOf, call, configFor, SESSION, stubRepo } from "./testSupport.test.js";

/**
 * What a CALL returns, which `contracts/board-mcp.json` cannot see. Every call here goes through
 * dispatch exactly as `index.ts` wires it, against a stub board.mjs that echoes its argv.
 */

const root = stubRepo();
const config = configFor(root);
const READ_TOOLS = ["status", "next", "left", "check", "assess", "gate", "find", "notes"];
const WRITE_TOOLS = Object.values(MAPPED)
  .flat()
  .filter((t) => !READ_TOOLS.includes(t));

// --- definitions -------------------------------------------------------------

test("every tool is snake_case, described, and declares annotations", () => {
  for (const tool of buildTools(config)) {
    assert.match(tool.name, /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/, `${tool.name} is not snake_case`);
    assert.equal(typeof tool.annotations.readOnly, "boolean");
    assert.equal(typeof tool.annotations.idempotent, "boolean");
    assert.equal(typeof tool.annotations.destructive, "boolean");
    assert.notEqual(tool.description.trim(), "", `${tool.name} has an empty description`);
  }
});

test("the tool table is health_check + every mapped tool, nothing else", () => {
  const names = buildTools(config).map((t) => t.name).sort();
  assert.deepEqual(names, ["health_check", ...Object.values(MAPPED).flat()].sort());
});

test("read tools are read-only; write tools are not, and every write tool is gated by write_enabled + session_uuid", () => {
  const tools = new Map(buildTools(config).map((t) => [t.name, t]));
  for (const name of READ_TOOLS) assert.equal(tools.get(name)?.annotations.readOnly, true, name);
  for (const name of WRITE_TOOLS) {
    const t = tools.get(name);
    assert.ok(t, name);
    assert.equal(t.annotations.readOnly, false, name);
    const guards = t.guards.map((g) => g.name);
    assert.ok(guards.includes("write_enabled"), `${name} lacks write_enabled`);
    assert.ok(guards.includes("session_uuid"), `${name} lacks session_uuid`);
  }
  for (const name of GATE_PASSING_TOOLS) assert.ok(WRITE_TOOLS.includes(name), `${name} is a gate tool but not a write tool`);
});

test("no tool accepts --words / --uuid from the model (find's `words` is its search text, a positional)", () => {
  for (const tool of buildTools(config)) {
    for (const key of Object.keys(tool.inputSchema.properties)) {
      if (tool.name === "find" && key === "words") continue;
      assert.ok(!["words", "uuid"].includes(key), `${tool.name} advertises ${key}`);
    }
  }
});

// --- the write gate ----------------------------------------------------------

test("a write tool with BOARD_WRITE_ENABLED=false is refused before any process runs", async () => {
  const off = configFor(root, { writeEnabled: false });
  for (const name of ["claim", "advance", "acknowledge", "release"]) {
    const args: Record<string, unknown> =
      name === "advance" ? { unit: "screen--review-intent", phase: "P0", session: SESSION }
      : name === "acknowledge" ? { unit: "screen--review-intent", sha: "abcdef1", gate: "Acknowledge (Recommended)", session: SESSION }
      : name === "release" ? { target: "screen--review-intent", session: SESSION }
      : { unit: "screen--review-intent", session: SESSION };
    const { isError, payload } = await call(off, name, args);
    assert.equal(isError, true, name);
    assert.equal(payload.code, "policy_violation", name);
    assert.match(payload.message, /BOARD_WRITE_ENABLED/, name);
  }
});

test("read tools work with writes disabled", async () => {
  const { isError, payload } = await call(configFor(root, { writeEnabled: false }), "next", {});
  assert.equal(isError, false);
  assert.equal(payload.ok, true);
});

// --- the session / gate rule -------------------------------------------------

test("every gate-passing tool without a session UUID is refused", async () => {
  const base: Record<string, Record<string, unknown>> = {
    advance: { unit: "screen--review-intent", phase: "P1", gate: "Đồng ý (Recommended)" },
    weigh: { unit: "screen--review-intent", weight: "light", yes: [], why: "owner chose light", gate: "Light is enough" },
    new_unit: { kind: "screen", route: "/review/intent", weight: "light", yes: [], gate: "Light is enough" },
    acknowledge: { unit: "screen--review-intent", sha: "abcdef1", gate: "Acknowledge (Recommended)" },
    discover: { unit: "screen--review-intent", id: "d1", owner: true, gate: "leave it as it is" },
    accept: { unit: "task--board-kind", verdict: "accepted", why: "read the numstat", gate: "Chấp nhận (Recommended)" }
  };
  assert.deepEqual(Object.keys(base).sort(), [...GATE_PASSING_TOOLS].sort());
  for (const [name, args] of Object.entries(base)) {
    for (const session of ["wec-aria-37", "0F8FAD5B-D9CB-469F-A165-70867728950E", "", "0f8fad5b-d9cb-469f-a165-70867728950e --as=x"]) {
      const { isError, payload } = await call(config, name, { ...args, session });
      assert.equal(isError, true, `${name} accepted session ${JSON.stringify(session)}`);
      assert.equal(payload.code, "policy_violation", `${name} / ${session}`);
      assert.match(payload.message, /session/u);
    }
    const missing = await call(config, name, args);
    assert.equal(missing.isError, true, `${name} accepted a missing session`);
    assert.equal(missing.payload.code, "validation_error");
    assert.match(missing.payload.detail, /session/u);
  }
});

test("a gate tool passes the session as --as and the words as --gate, nothing else", async () => {
  const { isError, payload } = await call(config, "advance", { unit: "screen--review-intent", phase: "P1", gate: "Approve (Recommended)", session: SESSION });
  assert.equal(isError, false);
  assert.deepEqual(argvOf(payload.text), ["advance", "screen--review-intent", "P1", "--gate=Approve (Recommended)", `--as=${SESSION}`]);
});

test("owner dispositions and over-budget need the owner's words", async () => {
  const d = await call(config, "discover", { unit: "screen--review-intent", id: "d1", owner: true, session: SESSION });
  assert.equal(d.payload.code, "validation_error");
  const a = await call(config, "advance", { unit: "screen--review-intent", phase: "P3", overBudget: true, session: SESSION });
  assert.equal(a.payload.code, "validation_error");
});

// --- argument mapping --------------------------------------------------------

test("each write tool maps its typed input to the CLI's exact flags", async () => {
  const cases: [string, Record<string, unknown>, string[]][] = [
    ["claim", { unit: "screen--review-intent" }, ["claim", "screen--review-intent"]],
    ["touch", { unit: "screen--review-intent", path: "packages/portal/src/X.vue" }, ["touch", "screen--review-intent", "packages/portal/src/X.vue"]],
    ["hold", { path: "docs/15-decision-log.md" }, ["hold", "docs/15-decision-log.md"]],
    ["release", { target: "docs/15-decision-log.md" }, ["release", "docs/15-decision-log.md"]],
    ["reopen", { unit: "screen--review-intent", rebuild: true, why: "owner notes" }, ["reopen", "screen--review-intent", "--rebuild", "--why=owner notes"]],
    ["reopen", { unit: "screen--review-intent", phase: "P2", why: "w" }, ["reopen", "screen--review-intent", "P2", "--why=w"]],
    ["queue_spec", { unit: "screen--review-intent", spec: "SPEC-066" }, ["queue-spec", "screen--review-intent", "SPEC-066"]],
    ["amend", { unit: "screen--review-intent", phase: "P4", why: "re-cut" }, ["amend", "screen--review-intent", "P4", "--why=re-cut"]],
    ["weigh", { unit: "screen--review-intent", weight: "full", yes: ["route", "spec"], why: "w" }, ["weigh", "screen--review-intent", "full", "--yes=route,spec", "--why=w"]],
    ["acknowledge", { offBoard: true, gate: "acknowledge them all" }, ["acknowledge", "--off-board", "--gate=acknowledge them all"]],
    ["acknowledge", { unit: "screen--review-intent", sha: "abcdef1", gate: "Acknowledge (Recommended)" }, ["acknowledge", "screen--review-intent", "abcdef1", "--gate=Acknowledge (Recommended)"]],
    ["discover", { unit: "screen--review-intent", text: "a site missed" }, ["discover", "screen--review-intent", "--text=a site missed"]],
    ["discover", { unit: "screen--review-intent", id: "d2", left: "why", revisit: "2026-11-02" }, ["discover", "screen--review-intent", "d2", "--left=why", "--revisit=2026-11-02"]],
    ["discover", { unit: "screen--review-intent", id: "d2", owner: true, gate: "để lại như cũ" }, ["discover", "screen--review-intent", "d2", "--owner", "--gate=để lại như cũ"]],
    ["discover", { unit: "screen--review-intent", id: "d3", sameAs: "screen--documents#d1" }, ["discover", "screen--review-intent", "d3", "--same-as=screen--documents#d1"]],
    ["reserve", { kind: "docs15" }, ["reserve", "docs15"]],
    ["notes_write", { unit: "screen--review-intent" }, ["notes", "screen--review-intent", "--write"]],
    ["new_unit", { kind: "family", route: "/documents" }, ["new", "/documents", "--family"]],
    ["new_unit", { kind: "screen", route: "/review/intent", weight: "standard", yes: ["layout"] }, ["new", "/review/intent", "--weight=standard", "--yes=layout"]],
    [
      "new_unit",
      { kind: "horizontal", name: "dates", paths: ["packages/portal/src/a.ts", "packages/portal/src/b.ts"], weight: "light", yes: [], after: "horizontal--w01-screen-primitives", about: "one line" },
      ["new", "--horizontal=dates", "--paths=packages/portal/src/a.ts,packages/portal/src/b.ts", "--after=horizontal--w01-screen-primitives", "--about=one line", "--weight=light", "--yes=none"]
    ]
  ];
  for (const [name, args, expected] of cases) {
    const { isError, payload } = await call(config, name, { ...args, session: SESSION });
    assert.equal(isError, false, `${name}: ${JSON.stringify(payload)}`);
    const argv = argvOf(payload.text);
    // `notes_write` puts --write last; every other tool ends with --as.
    assert.deepEqual(argv.filter((a) => a !== `--as=${SESSION}`), expected, name);
    assert.ok(argv.includes(`--as=${SESSION}`), `${name} did not pass --as`);
  }
});

test("read tools map to the CLI and pass --json where the CLI will honour it", async () => {
  const cases: [string, Record<string, unknown>, string[]][] = [
    ["status", {}, ["status", "--json"]],
    ["status", { unit: "screen--review-intent" }, ["status", "screen--review-intent", "--json"]],
    ["left", {}, ["left", "--json"]],
    ["gate", { unit: "screen--review-intent" }, ["gate", "screen--review-intent", "--json"]],
    ["assess", { kind: "screen", yes: [] }, ["assess", "--kind=screen", "--yes=none"]],
    ["assess", { kind: "horizontal" }, ["assess", "--kind=horizontal"]],
    ["find", { words: "Đồng ý — $HOME `x` || y" }, ["find", "Đồng ý — $HOME `x` || y"]],
    ["notes", { unit: "screen--review-intent", session: SESSION, since: "2026-10-01" }, ["notes", "screen--review-intent", `--as=${SESSION}`, "--since=2026-10-01"]]
  ];
  for (const [name, args, expected] of cases) {
    const { isError, payload } = await call(config, name, args);
    assert.equal(isError, false, `${name}: ${JSON.stringify(payload)}`);
    assert.deepEqual(argvOf(payload.text), expected, name);
  }
});

test("status(unit) returns the RAW unit file beside the CLI text", async () => {
  const { payload } = await call(config, "status", { unit: "screen--review-intent" });
  assert.deepEqual(payload.unitFile, { id: "screen--review-intent", kind: "screen", phases: { P0: { state: "active" } } });
});

test("output that parses as JSON lands in `json` (the day the CLI honours --json)", async () => {
  const { payload } = await call(config, "next", {});
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.json, { queue: [{ id: "horizontal--w01", state: "LANDED" }] });
});

// --- input hygiene -----------------------------------------------------------

test("a positional starting with '-' is refused: it would become a flag", async () => {
  for (const [name, args] of [
    ["find", { words: "--force" }],
    ["touch", { unit: "screen--review-intent", path: "--force", session: SESSION }],
    ["hold", { path: "-x", session: SESSION }],
    ["claim", { unit: "--force", session: SESSION }]
  ] as const) {
    const { isError, payload } = await call(config, name, args);
    assert.equal(isError, true, name);
    assert.equal(payload.code, "validation_error", name);
  }
});

test("unknown keys, including words/uuid, are rejected", async () => {
  const { payload } = await call(config, "advance", { unit: "screen--review-intent", phase: "P1", words: "x", uuid: "y", session: SESSION });
  assert.equal(payload.code, "validation_error");
});

test("a non-absolute BOARD_REPO_ROOT is refused before any process runs", async () => {
  const { isError, payload } = await call(configFor("relative/root"), "next", {});
  assert.equal(isError, true);
  assert.equal(payload.code, "policy_violation");
  assert.match(payload.message, /absolute/);
});

test("an unknown tool reports not_found", async () => {
  const { payload } = await call(config, "prune_shots", {});
  assert.deepEqual(payload, { code: "not_found", message: "Unknown tool: prune_shots." });
});

// --- blank owner words (a blank part proves nothing; short words are the CLI's call) ---

test("gate words with a blank ||-part are refused before any process runs", async () => {
  for (const gate of ["||", " || ", "|| ||", "a||", "|| Approve (Recommended)", "Approve (Recommended) ||  "]) {
    for (const [name, args] of [
      ["advance", { unit: "screen--review-intent", phase: "P1" }],
      ["acknowledge", { unit: "screen--review-intent", sha: "abcdef1" }],
      ["discover", { unit: "screen--review-intent", id: "d1", owner: true }],
      ["weigh", { unit: "screen--review-intent", weight: "light", yes: [], why: "owner chose light" }],
      ["new_unit", { kind: "screen", route: "/review/intent", weight: "light", yes: [] }]
    ] as const) {
      const { isError, payload } = await call(config, name, { ...args, gate, session: SESSION });
      assert.equal(isError, true, `${name} accepted gate ${JSON.stringify(gate)}`);
      assert.equal(payload.code, "validation_error", `${name} / ${JSON.stringify(gate)}`);
      assert.match(payload.detail, /gate/u);
    }
  }
});

test("short gate words pass through to board.mjs unchanged — the whole-line rule is the CLI's", async () => {
  for (const gate of ["ok", "Đồng ý", "Duyệt || ok", "Đồng ý cả hai || Giữ nguyên"]) {
    const { isError, payload } = await call(config, "advance", { unit: "screen--review-intent", phase: "P1", gate, session: SESSION });
    assert.equal(isError, false, `${JSON.stringify(gate)}: ${JSON.stringify(payload)}`);
    assert.deepEqual(argvOf(payload.text), ["advance", "screen--review-intent", "P1", `--gate=${gate}`, `--as=${SESSION}`]);
  }
});
