import assert from "node:assert/strict";
import test from "node:test";

import { argvOf, call, configFor, SESSION, stubRepo } from "../tools/testSupport.test.js";
import { interpretRun, parseJsonOutput } from "./boardCli.js";

const root = stubRepo();
const config = configFor(root);

// --- exit classification, pure ----------------------------------------------

test("exit 0 is ok with the text; JSON stdout is parsed only when asked", () => {
  const r = interpretRun({ exitCode: 0, stdout: "{\"a\":1}\n", stderr: "", timedOut: false }, { command: "next", parseJson: true });
  assert.deepEqual(r, { ok: true, value: { ok: true, json: { a: 1 }, text: "{\"a\":1}" } });
  const t = interpretRun({ exitCode: 0, stdout: "{\"a\":1}\n", stderr: "", timedOut: false }, { command: "claim" });
  assert.deepEqual(t, { ok: true, value: { ok: true, text: "{\"a\":1}" } });
  assert.equal(parseJsonOutput("42"), undefined);
  assert.equal(parseJsonOutput(" 1. horizontal--w01  LANDED"), undefined);
});

test("a non-zero exit whose stderr starts `board: ` is a refusal carrying the CLI's why", () => {
  const r = interpretRun({ exitCode: 1, stdout: "", stderr: "board: screen--x is at P2 Design run; P4 cannot be done before it — no phase is skipped\n", timedOut: false }, { command: "advance" });
  assert.ok(r.ok);
  assert.equal(r.value.ok, false);
  assert.equal(r.value.refused, true);
  assert.equal(r.value.why, "screen--x is at P2 Design run; P4 cannot be done before it — no phase is skipped");
  assert.equal(typeof r.value.hint, "string");
});

test("any other non-zero exit is an upstream_error, not a refusal", () => {
  const r = interpretRun({ exitCode: 1, stdout: "", stderr: "fatal: bad revision 'a7b3422e..HEAD'\nError: Command failed", timedOut: false }, { command: "status" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, "upstream_error");
  // A refusal line that is not FIRST does not make the run a refusal.
  const late = interpretRun({ exitCode: 1, stdout: "", stderr: "warning\nboard: x", timedOut: false }, { command: "claim" });
  assert.equal(late.ok, false);
});

test("check/gate exit 1 with no refusal line is a findings report, not an error", () => {
  const r = interpretRun({ exitCode: 1, stdout: "  ✗ f\n1 unit(s) read, 1 finding(s)\n", stderr: "", timedOut: false }, { command: "check", findingsExit: true });
  assert.ok(r.ok);
  assert.equal(r.value.ok, false);
  assert.equal(r.value.refused, undefined);
  assert.match(r.value.text, /1 finding/);
});

test("a killed run is a timeout error", () => {
  const r = interpretRun({ exitCode: null, stdout: "", stderr: "", timedOut: true }, { command: "status" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, "timeout");
});

// --- through a real child process -------------------------------------------

test("refusal mapping end to end: the stub's `board: ` line becomes { refused, why }", async () => {
  const { isError, payload } = await call(config, "claim", { unit: "screen--refuse", session: SESSION });
  assert.equal(isError, false);
  assert.equal(payload.ok, false);
  assert.equal(payload.refused, true);
  assert.match(payload.why, /^screen--refuse is held by someone-else/);
});

test("a crash (stack trace, no `board: `) is upstream_error with the stderr tail in detail", async () => {
  const { isError, payload } = await call(config, "claim", { unit: "screen--crash", session: SESSION });
  assert.equal(isError, true);
  assert.equal(payload.code, "upstream_error");
  assert.match(payload.detail, /boom: not a refusal/);
});

test("check's exit 1 reaches the caller as ok:false with the findings", async () => {
  const { isError, payload } = await call(config, "check", {});
  assert.equal(isError, false);
  assert.equal(payload.ok, false);
  assert.match(payload.text, /1 finding\(s\)/);
});

test("BOARD_CALL_TIMEOUT_MS kills a slow run and reports timeout", async () => {
  const { isError, payload } = await call(configFor(root, { callTimeoutMs: 500 }), "claim", { unit: "screen--slow", session: SESSION });
  assert.equal(isError, true);
  assert.equal(payload.code, "timeout");
});

test("arg quoting round-trip: Vietnamese, backticks, $, \\\\, ||, quotes and %VAR% reach board.mjs byte-for-byte", async () => {
  const words = [
    "Đồng ý (Recommended) || Giữ nguyên — không đổi",
    "run `rm -rf /` then $(whoami) and ${HOME} and $PATH",
    "C:\\Program Files\\Git\\ \\\\server\\share\\ trailing\\",
    "a \"quoted\" 'word' & | ; < > ^ %PATH% !x! \t tab",
    "ends with a backslash before a quote\\\"",
    "x || y || z"
  ];
  for (const gate of words) {
    const { isError, payload } = await call(config, "advance", { unit: "screen--review-intent", phase: "P1", gate, session: SESSION });
    assert.equal(isError, false, JSON.stringify(payload));
    const argv = argvOf(payload.text);
    assert.deepEqual(argv, ["advance", "screen--review-intent", "P1", `--gate=${gate}`, `--as=${SESSION}`], gate);
  }
  // Free text on other flags travels the same way.
  const why = "lý do: `x` $y \\z || w";
  const { payload } = await call(config, "reopen", { unit: "screen--review-intent", phase: "P2", why, session: SESSION });
  assert.ok(argvOf(payload.text).includes(`--why=${why}`));
});
