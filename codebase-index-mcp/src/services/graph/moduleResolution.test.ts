import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readTsconfigAliases, resolveModuleSpecifier, looksLikeModulePath } from "./moduleResolution.js";

const FILES = new Set([
  "src/index.ts",
  "src/config/envConfig.ts",
  "src/db/pool.ts",
  "src/services/index.ts",
  "src/services/user.mts",
  "src/legacy/thing.cts",
  "src/ui/Widget.tsx",
  "scripts/benchmark.mjs"
]);

test("an ESM relative specifier resolves through the .js -> .ts rewrite", () => {
  // Under `"type": "module"` a relative import MUST carry the .js extension even when the source is
  // .ts, so this is the normal shape in the target stack, not an edge case.
  assert.equal(resolveModuleSpecifier("src/index.ts", "./config/envConfig.js", FILES), "src/config/envConfig.ts");
  assert.equal(resolveModuleSpecifier("src/db/pool.ts", "../config/envConfig.js", FILES), "src/config/envConfig.ts");
});

test("extensionless and directory-index specifiers resolve", () => {
  assert.equal(resolveModuleSpecifier("src/index.ts", "./config/envConfig", FILES), "src/config/envConfig.ts");
  assert.equal(resolveModuleSpecifier("src/index.ts", "./services", FILES), "src/services/index.ts");
});

test("the TypeScript extensions that used to be skipped entirely now resolve", () => {
  assert.equal(resolveModuleSpecifier("src/index.ts", "./services/user.mjs", FILES), "src/services/user.mts");
  assert.equal(resolveModuleSpecifier("src/index.ts", "./legacy/thing.cjs", FILES), "src/legacy/thing.cts");
  assert.equal(resolveModuleSpecifier("src/index.ts", "./ui/Widget.js", FILES), "src/ui/Widget.tsx");
});

test("a package specifier resolves to nothing rather than to a lookalike file", () => {
  assert.equal(resolveModuleSpecifier("src/index.ts", "zod", FILES), null);
  assert.equal(resolveModuleSpecifier("src/index.ts", "node:path", FILES), null);
  assert.equal(resolveModuleSpecifier("src/index.ts", "@anthropic-ai/sdk", FILES), null);
});

test("looksLikeModulePath separates an alias from a C# namespace", () => {
  // This predicate is what keeps `@/db/pool.js` out of the import resolver's C# namespace branch,
  // where it used to be sent purely because it is non-relative and contains a dot.
  assert.equal(looksLikeModulePath("@/db/pool.js"), true);
  assert.equal(looksLikeModulePath("~/lib/x"), true);
  assert.equal(looksLikeModulePath("db/pool.js"), true);
  assert.equal(looksLikeModulePath("CRM.Marketing.Model"), false);
  assert.equal(looksLikeModulePath("System.Text.Json"), false);
});

function withTempRepo(tsconfig: unknown, run: (repoPath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbi-tsconfig-"));
  try {
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify(tsconfig), "utf8");
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("tsconfig paths expand an alias to a repo file", () => {
  withTempRepo({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }, (repoPath) => {
    const aliases = readTsconfigAliases(repoPath);
    assert.equal(resolveModuleSpecifier("src/index.ts", "@/db/pool.js", FILES, aliases), "src/db/pool.ts");
    assert.equal(resolveModuleSpecifier("src/index.ts", "@/config/envConfig", FILES, aliases), "src/config/envConfig.ts");
  });
});

test("a longer alias prefix wins over a catch-all", () => {
  withTempRepo(
    { compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"], "@/db/*": ["src/db/*"] } } },
    (repoPath) => {
      const aliases = readTsconfigAliases(repoPath);
      assert.equal(aliases.entries[0]?.prefix, "@/db/", "the more specific prefix must be tried first");
      assert.equal(resolveModuleSpecifier("src/index.ts", "@/db/pool.js", FILES, aliases), "src/db/pool.ts");
    }
  );
});

test("a tsconfig with comments and trailing commas still parses", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbi-tsconfig-"));
  try {
    // Both are legal in a tsconfig and both make JSON.parse throw, so the text is stripped first.
    fs.writeFileSync(
      path.join(dir, "tsconfig.json"),
      '{\n  // the compiler options\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": { "@/*": ["src/*"] },\n  }\n}\n',
      "utf8"
    );
    const aliases = readTsconfigAliases(dir);
    assert.equal(resolveModuleSpecifier("src/index.ts", "@/db/pool.js", FILES, aliases), "src/db/pool.ts");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an include glob does not destroy the config", () => {
  // `"@/*"` contains `/*` and `"src/**/*.ts"` contains `*` followed by `/`, so a regex block-comment
  // pass treats everything between them as one comment and deletes it — leaving JSON that will not
  // parse, and therefore no aliases at all, silently. A tsconfig with both is the ordinary case.
  withTempRepo(
    {
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
      include: ["src/**/*.ts"],
      exclude: ["**/*.spec.ts"]
    },
    (repoPath) => {
      const aliases = readTsconfigAliases(repoPath);
      assert.equal(aliases.entries.length, 1, "the alias survives an include glob");
      assert.equal(resolveModuleSpecifier("src/index.ts", "@/db/pool.js", FILES, aliases), "src/db/pool.ts");
    }
  );
});

test("a URL inside a string is not mistaken for a comment", () => {
  withTempRepo(
    { compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } }, $schema: "https://json.schemastore.org/tsconfig" },
    (repoPath) => {
      const aliases = readTsconfigAliases(repoPath);
      assert.equal(resolveModuleSpecifier("src/index.ts", "@/db/pool.js", FILES, aliases), "src/db/pool.ts");
    }
  );
});

test('baseUrl "." at the repo root still resolves a bare path specifier', () => {
  // `path.relative(repoPath, repoPath)` is `""`, a legitimate baseUrl meaning the repo root — and a
  // falsy one, which made the branch that exists for this exact case never fire.
  withTempRepo({ compilerOptions: { baseUrl: "." } }, (repoPath) => {
    const aliases = readTsconfigAliases(repoPath);
    assert.equal(aliases.baseUrl, "", "the repo root is an empty relative path, not absent");
    assert.equal(resolveModuleSpecifier("src/index.ts", "src/db/pool.js", FILES, aliases), "src/db/pool.ts");
  });
});

test("no baseUrl means bare specifiers are not path-resolved at all", () => {
  withTempRepo({ compilerOptions: { paths: { "@/*": ["src/*"] } } }, (repoPath) => {
    const aliases = readTsconfigAliases(repoPath);
    assert.equal(aliases.baseUrl, null);
    assert.equal(resolveModuleSpecifier("src/index.ts", "src/db/pool.js", FILES, aliases), null);
  });
});

test("a repo with no tsconfig yields empty aliases rather than throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbi-tsconfig-"));
  try {
    const aliases = readTsconfigAliases(dir);
    assert.deepEqual(aliases.entries, []);
    assert.equal(aliases.baseUrl, null);
    assert.equal(resolveModuleSpecifier("src/index.ts", "@/db/pool.js", FILES, aliases), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
