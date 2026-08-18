import assert from "node:assert/strict";
import test from "node:test";

import {
  hasExcludedPathSegment,
  isBinary,
  isLikelyMinified,
  isMigrationPath,
  isMigrationSymbol,
  isTestPath,
  shouldIndexFile
} from "./fileFilter.js";

/**
 * `fileFilter` decides what enters the graph at all, so every wrong answer here is either a
 * silently unindexed file or a parser fed something it cannot read. It is also pure — bytes and a
 * path in, a decision out — which makes it the cheapest place in this server to pin behaviour.
 *
 * These are the first `src/**\/*.test.ts` unit tests in `codebase-index-mcp` (S-39). Everything
 * before them was an integration harness under `scripts/test/` that needs a build and a database.
 */

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

test("isBinary: a null byte inside the first 512 bytes means binary", () => {
  assert.equal(isBinary(new Uint8Array([0x48, 0x00, 0x49])), true);
  assert.equal(isBinary(bytes("plain text")), false);
  assert.equal(isBinary(new Uint8Array(0)), false);
});

test("isBinary: only the first 512 bytes are sampled", () => {
  // Deliberate: a null byte past the window is NOT detected. Cheap sniffing is the trade, and a
  // test that documents the limit stops someone "fixing" a non-bug by scanning whole files.
  //
  // Note the explicit fill: `new Uint8Array(n)` is zero-filled, so an unfilled buffer is already
  // "binary" at byte 0 and would make both halves of this test pass for the wrong reason.
  const withNullAt = (index: number): Uint8Array => {
    const buffer = new Uint8Array(1000).fill(0x41);
    buffer[index] = 0;
    return buffer;
  };

  assert.equal(isBinary(withNullAt(900)), false, "past the 512-byte window");
  assert.equal(isBinary(withNullAt(511)), true, "last byte inside the window");
  assert.equal(isBinary(withNullAt(512)), false, "first byte outside it");
});

test("isTestPath: recognizes test layouts across the languages this server indexes", () => {
  for (const path of [
    "src/__tests__/thing.ts",
    "src/tests/thing.ts",
    "src/test/thing.ts",
    "src/thing.test.ts",
    "src/thing.spec.js",
    "app/test_module.py",
    "app/module_test.py",
    "Api/OrderServiceTests.cs"
  ]) {
    assert.equal(isTestPath(path), true, `expected test path: ${path}`);
  }
  for (const path of ["src/thing.ts", "src/latest.ts", "src/contest/thing.ts"]) {
    assert.equal(isTestPath(path), false, `expected NOT a test path: ${path}`);
  }
});

test("isTestPath: backslash paths are normalized, so Windows input behaves the same", () => {
  assert.equal(isTestPath("src\\__tests__\\thing.ts"), true);
  assert.equal(hasExcludedPathSegment("repo\\node_modules\\pkg\\index.js"), true);
});

test("isMigrationPath: EF migration folders, whole segment only (MCP-ISSUE-049)", () => {
  for (const path of [
    "src/Infrastructure/Migrations/20260731_AddSenderEmail.cs",
    "Migrations/20260731_AddSenderEmail.cs",
    "src/Infrastructure/Migration/One.cs"
  ]) {
    assert.equal(isMigrationPath(path), true, `expected migration path: ${path}`);
  }
  // A substring must not match: "migrationsHelper" is ordinary code, and demoting it would hide a
  // real answer — the same whole-segment discipline `hasExcludedPathSegment` follows.
  for (const path of ["src/migrationsHelper.ts", "src/Services/Migrator.cs", "src/thing.cs"]) {
    assert.equal(isMigrationPath(path), false, `expected NOT a migration path: ${path}`);
  }
  assert.equal(isMigrationPath("src\\Migrations\\One.cs"), true, "backslashes normalized");
});

test("isMigrationSymbol: Up/Down only count inside a migration shape (MCP-ISSUE-049)", () => {
  // In the folder → demoted regardless of member name.
  assert.equal(isMigrationSymbol("src/Migrations/One.cs", "Up", "AddSenderEmail"), true);
  // Outside the folder, Up/Down still demote when the enclosing type looks like a migration —
  // EF allows the file to live anywhere.
  assert.equal(isMigrationSymbol("src/Data/One.cs", "Down", "20260731_AddSenderEmail"), true);
  assert.equal(isMigrationSymbol("src/Data/One.cs", "Up", "AddSenderEmailMigration"), true);
  // A hand-written Up() in ordinary code is NOT a migration — this is the false positive the
  // parentName check exists to prevent.
  assert.equal(isMigrationSymbol("src/Ui/Scroller.cs", "Up", "ScrollController"), false);
  assert.equal(isMigrationSymbol("src/Ui/Scroller.cs", "Up", null), false);
  assert.equal(isMigrationSymbol("src/Notify/Notifier.cs", "NotifyAsync", "Notifier"), false);
});

test("hasExcludedPathSegment: matches whole segments, not substrings", () => {
  assert.equal(hasExcludedPathSegment("a/node_modules/b.ts"), true);
  assert.equal(hasExcludedPathSegment("a/bin/b.cs"), true);
  assert.equal(hasExcludedPathSegment("a/obj/b.cs"), true);
  // `binary/` contains "bin" but is not it — a substring match here would silently drop real code.
  assert.equal(hasExcludedPathSegment("a/binary/b.ts"), false);
  assert.equal(hasExcludedPathSegment("a/distributed/b.ts"), false);
});

test("isLikelyMinified: needs more than 10KB before it will judge at all", () => {
  const oneLongLine = "x".repeat(9_000);
  assert.equal(isLikelyMinified(bytes(oneLongLine)), false, "under 10KB is never minified");

  const bigMinified = "x".repeat(20_000);
  assert.equal(isLikelyMinified(bytes(bigMinified)), true);

  const bigNormal = `${"const a = 1;\n".repeat(2_000)}`;
  assert.equal(isLikelyMinified(bytes(bigNormal)), false);
});

test("shouldIndexFile: maps a known extension to its language", () => {
  const decision = shouldIndexFile("src/app.ts", bytes("export const a = 1;"));
  assert.deepEqual(decision, { include: true, reason: "extension_match", language: "typescript" });
});

test("shouldIndexFile: every TypeScript extension maps to the typescript tag", () => {
  // `.tsx` shares the tag with `.ts` deliberately — the JSX grammar is chosen per file, not per
  // language tag, so `files.language` stays joinable. `.mts`/`.cts` were missing entirely and were
  // skipped as unknown_extension.
  for (const path of ["src/app.ts", "src/App.tsx", "src/app.mts", "src/app.cts"]) {
    const decision = shouldIndexFile(path, bytes("export const a = 1;"));
    assert.deepEqual(
      decision,
      { include: true, reason: "extension_match", language: "typescript" },
      `expected ${path} to be indexed as typescript`
    );
  }
});

test("shouldIndexFile: declaration files are excluded before the extension match", () => {
  // extname("types.d.ts") is ".ts", so without an explicit check these were indexed as ordinary
  // TypeScript and only ever yielded a module symbol plus names that polluted search ranking.
  for (const path of ["src/types.d.ts", "src/env.d.mts", "src/global.d.cts"]) {
    const decision = shouldIndexFile(path, bytes("export declare const a: number;"));
    assert.equal(decision.include, false, `expected ${path} to be excluded`);
    assert.equal(decision.reason, "declaration_file");
    assert.equal(decision.language, null);
  }

  // A file that merely has a `d` segment in its name is not a declaration file.
  assert.equal(shouldIndexFile("src/d.ts", bytes("export const a = 1;")).include, true);
  assert.equal(shouldIndexFile("src/models.ts", bytes("export const a = 1;")).include, true);
});

test("shouldIndexFile: an unknown extension is excluded, not guessed", () => {
  const decision = shouldIndexFile("src/app.zzz", bytes("whatever"));
  assert.equal(decision.include, false);
  assert.equal(decision.reason, "unknown_extension");
  assert.equal(decision.language, null);
});

test("shouldIndexFile: the exclusion order is path, then generated, then extension", () => {
  // Path wins over everything, so a .ts inside dist/ is excluded for the path reason rather than
  // being indexed as TypeScript.
  assert.equal(shouldIndexFile("dist/app.ts", bytes("x")).reason, "excluded_path");
  assert.equal(shouldIndexFile("src/photo.png", bytes("x")).reason, "excluded_extension");
});

test("shouldIndexFile: EF Core Designer.cs snapshots are excluded as generated", () => {
  // Auto-generated, large, and slow to parse. The condition needs BOTH a /migrations/ segment and
  // the .designer.cs suffix, so each half is pinned separately.
  assert.equal(
    shouldIndexFile("Api/Migrations/20240101_Init.Designer.cs", bytes("class X {}")).reason,
    "excluded_generated"
  );
  assert.equal(
    shouldIndexFile("Api/Data/Thing.Designer.cs", bytes("class X {}")).reason,
    "extension_match",
    "outside /migrations/ it is ordinary C#"
  );
});

test("shouldIndexFile: README is excluded as a filename, but README.md is indexed as docs", () => {
  // The carve-out that a refactor breaks silently: EXCLUDED_FILENAMES would drop documentation
  // too, so it is skipped for markdown. Both halves matter.
  assert.equal(shouldIndexFile("README", bytes("hello")).reason, "excluded_filename");
  const md = shouldIndexFile("README.md", bytes("# hello"));
  assert.equal(md.include, true);
  assert.equal(md.language, "markdown");
});

test("shouldIndexFile: size cap is respected and configurable", () => {
  const big = bytes("x".repeat(2_000));
  assert.equal(shouldIndexFile("src/app.ts", big, 1_000).reason, "file_too_large");
  assert.equal(shouldIndexFile("src/app.ts", big, 10_000).include, true);
});

test("shouldIndexFile: binary content is rejected even with an indexable extension", () => {
  const decision = shouldIndexFile("src/app.ts", new Uint8Array([0x61, 0x00, 0x62]));
  assert.equal(decision.include, false);
  assert.equal(decision.reason, "binary_file");
});
