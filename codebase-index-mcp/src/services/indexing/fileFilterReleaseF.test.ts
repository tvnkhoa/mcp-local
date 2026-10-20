import assert from "node:assert/strict";
import test from "node:test";

import {
  hasExcludedPathSegment,
  hasOnlyGitDeferredSegments,
  isExcludedByPath,
  isMinifiedCheckExempt,
  isSecretBearingFile,
  languageForPath,
  shouldIndexFile
} from "./fileFilter.js";

/**
 * Release F: the text / JSON / HTML / SVG lanes (MCP-ISSUE-076, 077) and git-cleared build segments
 * (MCP-ISSUE-078) as `fileFilter` decides them. Kept beside `fileFilter.test.ts` rather than in it, so
 * the release's rules read as one set.
 */

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

test("text lane: config, script and data formats map to `text`", () => {
  for (const p of [
    ".github/workflows/ci.yml",
    "deploy/compose.yaml",
    "Dockerfile",
    "docker/Dockerfile.dev",
    "api.dockerfile",
    "Makefile",
    "scripts/run.sh",
    "docker/entry.envsh",
    "nginx/default.conf",
    "nginx/default.conf.template",
    "notes.txt",
    ".env.example",
    "aria.code-workspace",
    ".editorconfig",
    ".gitattributes",
    ".gitignore",
    ".dockerignore",
    ".nvmrc",
    "evals/cases/guardrails.jsonl"
  ]) {
    assert.equal(languageForPath(p), "text", p);
    const decision = shouldIndexFile(p, bytes("x: 1\n"));
    assert.deepEqual(decision, { include: true, reason: "extension_match", language: "text" }, p);
  }
});

test("json, html and svg get their own language tags", () => {
  assert.equal(languageForPath("package.json"), "json");
  assert.equal(languageForPath("tsconfig.build.json"), "json");
  assert.equal(languageForPath("index.html"), "html");
  assert.equal(languageForPath("src/assets/icon.svg"), "svg");
});

test("secrets stay out with their own reason, while their documentation twins are text", () => {
  for (const p of [".env", ".env.local", "storage/app.session", "certs/server.key", "keys/AuthKey.p8", ".npmrc"]) {
    assert.equal(isSecretBearingFile(p.split("/").pop() ?? p), true, p);
    assert.equal(shouldIndexFile(p, bytes("TOKEN=abc")).reason, "secret_file", p);
  }
  assert.equal(shouldIndexFile(".env.example", bytes("TOKEN=")).language, "text");
});

test("binary assets are reported as binary_asset", () => {
  for (const p of ["docs/spec.pdf", "img/a.png", "img/b.jpg", "img/c.gif", "favicon.ico", "fonts/x.woff2", "img/d.webp"]) {
    assert.equal(shouldIndexFile(p, bytes("x")).reason, "binary_asset", p);
  }
});

test("one-line JSON, JSONL and SVG are exempt from likely_minified; one-line JS is not", () => {
  const oneLine = bytes(JSON.stringify({ rows: Array.from({ length: 2000 }, (_, i) => `v${i}`) }));
  assert.ok(oneLine.length > 10_000);
  assert.equal(shouldIndexFile("data/x.json", oneLine).include, true);
  assert.equal(shouldIndexFile("data/x.jsonl", oneLine).include, true);
  assert.equal(shouldIndexFile("img/x.svg", oneLine).include, true);
  assert.equal(shouldIndexFile("dist-free/x.js", oneLine).reason, "likely_minified");
  assert.equal(isMinifiedCheckExempt("a/b.JSONL"), true);
  assert.equal(isMinifiedCheckExempt("a/b.js"), false);
});

test("an svg under assets/, public/ or static/ is an asset node; anything else there stays out", () => {
  for (const p of ["src/assets/icon.svg", "public/favicon.svg", "static/logo.svg"]) {
    assert.equal(isExcludedByPath(p), false, p);
    assert.equal(shouldIndexFile(p, bytes("<svg/>")).language, "svg", p);
  }
  for (const p of ["src/assets/vendor.js", "public/robots.txt", "wwwroot/icon.svg", "node_modules/pkg/icon.svg"]) {
    assert.equal(isExcludedByPath(p), true, p);
  }
});

test("build-named segments defer to git only for source files", () => {
  // Without git's word the segment rule stands.
  assert.equal(isExcludedByPath("packages/dep-lint/bin/depcruise-guarded.mjs"), true);
  // Git cleared it: source is in, non-source is still out.
  assert.equal(isExcludedByPath("packages/dep-lint/bin/depcruise-guarded.mjs", { gitCleared: true }), false);
  assert.equal(isExcludedByPath("tools/build/gen.ts", { gitCleared: true }), false);
  assert.equal(isExcludedByPath("packages/dep-lint/bin/notes.txt", { gitCleared: true }), true);
  assert.equal(isExcludedByPath("Api/obj/Debug/net8.0/Api.AssemblyInfo.cs", { gitCleared: false }), true);
  // node_modules / dist / .git are never deferred, whatever git says.
  assert.equal(isExcludedByPath("node_modules/x/bin/cli.js", { gitCleared: true }), true);
  assert.equal(isExcludedByPath("dist/bin/cli.js", { gitCleared: true }), true);
  // The strict form search_regex(scanAll) uses is unchanged.
  assert.equal(hasExcludedPathSegment("packages/dep-lint/bin/depcruise-guarded.mjs"), true);
});

test("hasOnlyGitDeferredSegments picks exactly the candidates the scan adds back from git", () => {
  assert.equal(hasOnlyGitDeferredSegments("packages/dep-lint/bin/x.mjs"), true);
  assert.equal(hasOnlyGitDeferredSegments("a/obj/b/out/c.cs"), true);
  assert.equal(hasOnlyGitDeferredSegments("src/x.ts"), false, "no excluded segment at all");
  assert.equal(hasOnlyGitDeferredSegments("node_modules/x/bin/cli.js"), false);
  assert.equal(hasOnlyGitDeferredSegments("a/bin"), false, "a FILE named bin is not a directory segment");
});
