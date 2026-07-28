/**
 * The entry point's own contract — the parts no `tools/list` snapshot can see (S-31).
 *
 * S-31 moves this server onto `createMcpServer` with a legacy bridge in front of the
 * 43-branch switch. Everything the switch itself does is covered by the other suites;
 * what is NOT covered anywhere is the wiring *around* it, and every one of those pieces
 * has a plausible SDK default that differs:
 *
 *   - the error envelope `{ code, message, requestId }`, pretty-printed regardless of
 *     profile (the platform default is a different shape, minified)
 *   - the unknown-tool rejection, which is an `isError` RESULT carrying `MCP_ERROR`, not
 *     a JSON-RPC error (the platform default is a `not_found` PlatformError)
 *   - `resources/read` on an unroutable URI, which IS a JSON-RPC error, with this
 *     server's message (the platform default substitutes its own)
 *   - `resources/list` with a cursor, which returns nothing
 *   - `notifications/progress`, which only exists because the entry point reads the
 *     request's `_meta.progressToken` and puts a sink in AsyncLocalStorage
 *   - the telemetry line emitted at serialization time, on both the success and the
 *     failure path — a side effect that is invisible in the response bytes
 *
 * Written against the pre-migration server and passing there first: a test authored
 * after a refactor only proves the refactor agrees with itself.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./_fixtures.mjs";
import { handleListResources } from "../../dist/handlers/resourceHandler.js";

let passed = 0, failed = 0;
function assert(cond, label, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const txt = (r) => Array.isArray(r?.content) ? (r.content.find((x) => x.type === "text")?.text ?? "") : "";
const js = (r) => { try { return JSON.parse(txt(r)); } catch { return null; } };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const tmpDir = makeTempDir("envelope-test-");
const repoId = `envelope-${Date.now()}`;
mkdirSync(join(tmpDir, "src"), { recursive: true });
for (let i = 0; i < 4; i += 1) {
  writeFileSync(join(tmpDir, "src", `mod${i}.ts`), `export function fn${i}(): number { return ${i}; }\n`, "utf8");
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: {
    ...process.env,
    CODEBASE_INDEX_ALLOWED_ROOTS: tmpDir,
    CODEBASE_INDEX_DB_PATH: join(tmpDir, "index.db"),
    CODEBASE_INDEX_LLM_ENABLED: "false",
    // The telemetry assertions below are the only reason this is on: the emit is a
    // side effect of serialization, so it cannot be observed in the result payload.
    CODEBASE_INDEX_TELEMETRY_ENABLED: "true",
    CODEBASE_INDEX_TELEMETRY_SAMPLE_RATE: "1"
  },
  stderr: "pipe"
});
const client = new Client({ name: "envelope-test", version: "0.1.0" });
await client.connect(transport);

let stderrText = "";
transport.stderr?.on("data", (chunk) => { stderrText += chunk.toString("utf8"); });

try {
  // ── Declared capabilities ────────────────────────────────────────────────────
  // `resources` is only advertised because this server serves them. Dropping the
  // declaration is an initialize-response change no tools/list diff would catch.
  const caps = client.getServerCapabilities();
  assert(caps?.tools !== undefined, "capabilities declare tools", JSON.stringify(caps));
  assert(caps?.resources !== undefined, "capabilities declare resources", JSON.stringify(caps));

  const version = client.getServerVersion();
  assert(version?.name === "codebase-index-mcp", "server name unchanged", JSON.stringify(version));
  assert(version?.version === "0.1.0", "advertised protocol-level version unchanged", JSON.stringify(version));

  // ── tools/list ───────────────────────────────────────────────────────────────
  const listed = (await client.listTools()).tools;
  assert(listed.length === 43, "publishes 43 tools", `got ${listed.length}`);

  // Every tool now carries annotations: S-32 finished, so all 43 are registry-served and
  // `defineTool` requires them. The legacy descriptors had none, which made their arrival the
  // one wire-visible marker of migration progress — registry-vs-switch is otherwise invisible
  // from out here, which is the point.
  //
  // The tools whose annotations are NOT the plain read-only default are asserted field by field.
  // Those are the judgement calls, and a silent flip in either direction should fail here rather
  // than change what a host prompts the user to confirm.
  const NON_DEFAULT = {
    // Replaces symbols/edges and prunes on mode='full' — a replace, not an additive write — but
    // only of derived state it can rebuild from source.
    index_repository: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    // Starts/stops a watcher: server state, but removes nothing.
    watch_repo: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    // The only tool that edits the user's source files.
    refactor_replace_apply: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
    // Destructive because it overwrites working-tree files too — being the undo does not make it
    // safe to invoke unprompted.
    refactor_replace_rollback: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    // Preview/dry-run: writes no source, but mints a previewId + approval token per call.
    refactor_replace_preview: { readOnlyHint: true, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    rename_assist: { readOnlyHint: true, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    refactor_symbol_migration: { readOnlyHint: true, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    change_value_representation: { readOnlyHint: true, idempotentHint: false, destructiveHint: false, openWorldHint: false }
  };

  const unannotated = listed.filter((t) => t.annotations === undefined).map((t) => t.name);
  assert(unannotated.length === 0, "all 43 tools carry annotations", unannotated.join(","));

  for (const [name, expected] of Object.entries(NON_DEFAULT)) {
    const actual = listed.find((t) => t.name === name)?.annotations;
    const keys = Object.keys(expected).sort();
    assert(
      JSON.stringify(actual, keys) === JSON.stringify(expected, keys),
      `${name} annotations are exactly as declared`,
      `got ${JSON.stringify(actual)}`
    );
  }

  const defaults = listed.filter((t) => !(t.name in NON_DEFAULT));
  assert(
    defaults.length === 43 - Object.keys(NON_DEFAULT).length,
    `${43 - Object.keys(NON_DEFAULT).length} tools use the plain read-only annotation`,
    `got ${defaults.length}`
  );
  assert(
    defaults.every(
      (t) =>
        t.annotations.readOnlyHint === true &&
        t.annotations.idempotentHint === true &&
        t.annotations.destructiveHint === false &&
        t.annotations.openWorldHint === false
    ),
    "every remaining tool is annotated readOnly + idempotent + local",
    JSON.stringify(defaults.find((t) => t.annotations.readOnlyHint !== true)?.name)
  );

  // ── Unknown tool: an isError RESULT, not a JSON-RPC error ────────────────────
  // The switch's `default:` throws McpError(MethodNotFound) and the entry point's
  // catch turns it into a result. A client that only handles JSON-RPC errors would
  // see a *successful* call with isError set, and that is the established contract.
  const unknown = await client.callTool({ name: "no_such_tool_at_all", arguments: {} });
  assert(unknown.isError === true, "unknown tool → isError result");
  const unknownBody = js(unknown);
  assert(unknownBody?.code === "MCP_ERROR", "unknown tool → code MCP_ERROR", JSON.stringify(unknownBody));
  assert(
    typeof unknownBody?.message === "string" && unknownBody.message.includes("no_such_tool_at_all"),
    "unknown tool → message names the tool",
    JSON.stringify(unknownBody)
  );
  assert(
    typeof unknownBody?.message === "string" && unknownBody.message.includes("-32601"),
    "unknown tool → message carries the MethodNotFound code",
    JSON.stringify(unknownBody)
  );

  // ── Envelope shape and pretty-printing ───────────────────────────────────────
  const invalid = await client.callTool({ name: "get_call_chain", arguments: { repoId } });
  assert(invalid.isError === true, "missing required arg → isError result");
  const invalidBody = js(invalid);
  assert(invalidBody?.code === "VALIDATION_ERROR", "zod failure → code VALIDATION_ERROR", JSON.stringify(invalidBody));
  assert(
    typeof invalidBody?.message === "string" && invalidBody.message.startsWith("get_call_chain: "),
    "error message is prefixed with the tool name",
    JSON.stringify(invalidBody)
  );
  assert(
    Object.keys(invalidBody ?? {}).sort().join(",") === "code,message,requestId",
    "error payload has exactly code/message/requestId",
    Object.keys(invalidBody ?? {}).join(",")
  );
  assert(UUID_RE.test(invalidBody?.requestId ?? ""), "requestId is a uuid", String(invalidBody?.requestId));
  // Errors are pretty-printed at every profile — the success path is not.
  assert(txt(invalid).includes("\n  \"code\""), "error text is pretty-printed (2-space indent)", JSON.stringify(txt(invalid)));
  const invalidCompact = await client.callTool({ name: "get_call_chain", arguments: { repoId, profile: "nano" } });
  assert(
    txt(invalidCompact).includes("\n  \"code\""),
    "error stays pretty-printed even at profile=nano",
    JSON.stringify(txt(invalidCompact))
  );

  // A failed apply reports the envelope — S-31 changed this, deliberately.
  //
  // The pre-SDK switch used a plain `return handleRefactorReplaceApply(...)` inside its try, and
  // inside a try a plain return does NOT route a rejection to the catch. Measured against the
  // build at a441500, a bad previewId came back as a raw JSON-RPC error, while its two siblings
  // (which used `return await`) returned the normal envelope. The PolicyViolationError code —
  // PREVIEW_EXPIRED, AMBIGUITY_THRESHOLD_EXCEEDED — was lost with it. All three now await.
  const badApply = await client.callTool({
    name: "refactor_replace_apply",
    arguments: { previewId: "does-not-exist", approvalToken: "x" }
  });
  assert(badApply.isError === true, "a failed apply is an isError result, not a JSON-RPC error");
  const badApplyBody = js(badApply);
  assert(
    badApplyBody?.code === "MCP_ERROR" && UUID_RE.test(badApplyBody?.requestId ?? ""),
    "a failed apply carries the standard { code, message, requestId } envelope",
    JSON.stringify(badApplyBody)
  );

  // ── notifications/progress ───────────────────────────────────────────────────
  // Supplying a progress callback makes the client attach a progressToken; the sink
  // reaches the indexer only through AsyncLocalStorage, so this fails the moment the
  // per-request scope is not established around the call.
  const progressFrames = [];
  await client.callTool(
    { name: "index_repository", arguments: { repoId, repoPath: tmpDir, mode: "full" } },
    undefined,
    { onprogress: (frame) => progressFrames.push(frame) }
  );
  assert(progressFrames.length > 0, "index_repository streams notifications/progress when a token is supplied");
  assert(
    progressFrames.every((f) => typeof f.progress === "number"),
    "every progress frame carries a numeric progress",
    JSON.stringify(progressFrames.slice(0, 2))
  );

  // Without a callback there is no token, so nothing should be streamed — and the
  // call must still succeed rather than fail building a sink that goes nowhere.
  const noToken = await client.callTool({ name: "list_repositories", arguments: {} });
  assert(noToken.isError !== true, "a call with no progressToken succeeds", txt(noToken).slice(0, 200));

  // ── resources ────────────────────────────────────────────────────────────────
  const resources = (await client.listResources()).resources;
  assert(resources.length === 4, "one indexed repo exposes 4 resources", `got ${resources.length}`);
  assert(
    resources.map((r) => r.uri).sort().join(",") ===
      [`repo://${repoId}/context`, `repo://${repoId}/risk`, `repo://${repoId}/routes`, `repo://${repoId}/schema`].sort().join(","),
    "resource URIs unchanged",
    resources.map((r) => r.uri).join(",")
  );

  const read = await client.readResource({ uri: `repo://${repoId}/schema` });
  assert(read.contents?.[0]?.mimeType === "application/json", "resources/read returns application/json", JSON.stringify(read).slice(0, 200));

  // An unroutable URI is a JSON-RPC *error* here, unlike a tool failure. The message
  // is this server's, and it tells the caller the URI grammar.
  let readError;
  try {
    await client.readResource({ uri: "bogus://nope" });
  } catch (error) {
    readError = error;
  }
  assert(readError !== undefined, "unsupported resource URI rejects at the protocol level");
  assert(
    String(readError?.message ?? "").includes("resources/read: unsupported uri"),
    "unsupported resource URI keeps this server's message",
    String(readError?.message)
  );

  // The cursor branch cannot be reached over the wire — this server never emits a
  // nextCursor, so a conforming client never sends one. Asserted directly instead,
  // because a provider interface with no cursor parameter silently loses it.
  const fakeStore = { listRepositories: () => [{ repoId: "r1", repoPath: "/tmp/r1" }] };
  assert(handleListResources(fakeStore).resources.length === 4, "handleListResources: no cursor → full list");
  assert(handleListResources(fakeStore, "some-cursor").resources.length === 0, "handleListResources: any cursor → empty page");

  // ── Telemetry, on both paths ─────────────────────────────────────────────────
  const telemetry = stderrText.split("\n").filter((line) => line.includes("[tool-telemetry]"));
  assert(telemetry.length > 0, "telemetry lines are emitted to stderr when enabled", `stderr bytes: ${stderrText.length}`);
  assert(
    telemetry.some((line) => line.includes("\"isError\":false")),
    "telemetry is emitted on the success path",
    telemetry.slice(-3).join(" | ").slice(0, 400)
  );
  assert(
    telemetry.some((line) => line.includes("\"isError\":true") && line.includes("VALIDATION_ERROR")),
    "telemetry is emitted on the failure path, with the error code",
    telemetry.slice(-3).join(" | ").slice(0, 400)
  );
  assert(
    telemetry.some((line) => line.includes("\"toolName\":\"list_repositories\"")),
    "telemetry names the tool that ran",
    telemetry.slice(-3).join(" | ").slice(0, 400)
  );

  // The profile a tool actually answered at, which is only observable here.
  //
  // list_repositories declares `profile: responseProfileSchema.default("compact").optional()`.
  // `.optional()` short-circuits an absent value BEFORE `.default()` runs, so `profile` reaches
  // the handler as undefined and the handler falls back to "standard". S-32 migrated this tool
  // as `rawResult` precisely to keep that: letting dispatch serialize would resolve the profile
  // from the raw arguments and answer at "compact" instead — same tool, smaller response, and
  // nothing in tools/list or a response replay would show which one was intended.
  const listRepoLine = telemetry.find((line) => line.includes("\"toolName\":\"list_repositories\""));
  assert(
    (listRepoLine ?? "").includes("\"profile\":\"standard\""),
    "list_repositories with no profile argument answers at standard, not compact",
    String(listRepoLine)
  );
} finally {
  await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
