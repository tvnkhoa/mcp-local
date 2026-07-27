import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { runConventionGuard } from "./guards/conventionGuard.js";
import { runDependencyGuard } from "./guards/dependencyGuard.js";
import { TIER_RULES, isNodeBuiltin, ruleFor } from "./guards/rules.js";
import { countBySeverity } from "./guards/types.js";
import { exitCodeFor, renderReport, renderSummary } from "./report.js";
import { extractImports, findWorkspaceRoot, isDeepImport, packageNameOf, readWorkspacePackages } from "./scan.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = findWorkspaceRoot(here);

// --- scanning -------------------------------------------------------------

test("scan: import specifiers are extracted from every syntax form", () => {
  const source = [
    'import { a } from "@mcp/core";',
    'import type { B } from "./local.js";',
    'export { c } from "@mcp/sdk";',
    'const d = await import("node:fs");',
    'const e = require("zod");'
  ].join("\n");

  const specifiers = extractImports(source).map((ref) => ref.specifier);
  assert.equal(specifiers.includes("@mcp/core"), true);
  assert.equal(specifiers.includes("./local.js"), true);
  assert.equal(specifiers.includes("@mcp/sdk"), true);
  assert.equal(specifiers.includes("node:fs"), true);
  assert.equal(specifiers.includes("zod"), true);
});

test("scan: commented-out imports are ignored", () => {
  const source = ['// import { x } from "@mcp/forbidden";', '/* import "@mcp/also-forbidden"; */', 'import { y } from "@mcp/core";'].join("\n");
  const specifiers = extractImports(source).map((ref) => ref.specifier);
  assert.deepEqual(specifiers, ["@mcp/core"]);
});

test("scan: line numbers are reported", () => {
  const refs = extractImports('\n\nimport { a } from "@mcp/core";');
  assert.equal(refs[0]?.line, 3);
});

test("scan: package names are derived from specifiers", () => {
  assert.equal(packageNameOf("@mcp/core"), "@mcp/core");
  assert.equal(packageNameOf("@mcp/core/sub"), "@mcp/core");
  assert.equal(packageNameOf("zod"), "zod");
  assert.equal(packageNameOf("./local.js"), undefined);
  assert.equal(packageNameOf("node:fs"), undefined);
});

test("scan: deep imports into a platform package are detected", () => {
  assert.equal(isDeepImport("@mcp/core/src/env.js"), true);
  assert.equal(isDeepImport("@mcp/core/dist/env.js"), true);
  assert.equal(isDeepImport("@mcp/core"), false);
  assert.equal(isDeepImport("@modelcontextprotocol/sdk/server/index.js"), false);
});

test("scan: the workspace root and its packages are discoverable", () => {
  const packages = readWorkspacePackages(workspaceRoot);
  const names = packages.map((pkg) => pkg.name).sort();
  assert.deepEqual(names, ["@mcp/cli", "@mcp/core", "@mcp/sdk", "@mcp/shared", "@mcp/testing"]);
});

// --- rules ----------------------------------------------------------------

test("rules: every package in the matrix has a strictly ordered tier", () => {
  for (const rule of TIER_RULES) {
    for (const allowed of rule.mayImport) {
      const target = ruleFor(allowed);
      assert.notEqual(target, undefined, `${allowed} must be in the matrix`);
      assert.equal(
        (target?.tier ?? Number.MAX_SAFE_INTEGER) < rule.tier,
        true,
        `${rule.name} (tier ${rule.tier}) may not import ${allowed}`
      );
    }
  }
});

test("rules: core is declared zero-dependency", () => {
  const core = ruleFor("@mcp/core");
  assert.deepEqual(core?.mayImport, []);
  assert.deepEqual(core?.allowedExternal, []);
  assert.equal(isNodeBuiltin("node:crypto"), true);
  assert.equal(isNodeBuiltin("zod"), false);
});

// --- guards, run against this very workspace ------------------------------

test("dependency guard: the platform foundation has zero violations", () => {
  const report = runDependencyGuard({ workspaceRoot });
  const { errors } = countBySeverity(report.findings);
  assert.equal(
    errors,
    0,
    `expected no dependency errors, got:\n${renderReport(report)}`
  );
  assert.equal(report.filesScanned > 0, true);
});

test("convention guard: the platform foundation has zero errors", () => {
  const report = runConventionGuard({ workspaceRoot });
  const { errors } = countBySeverity(report.findings);
  assert.equal(
    errors,
    0,
    `expected no convention errors, got:\n${renderReport(report)}`
  );
});

// --- reporting ------------------------------------------------------------

test("report: exit code is 0 for warnings unless strict", () => {
  const report = {
    guard: "demo",
    filesScanned: 1,
    findings: [{ rule: "r", severity: "warning" as const, file: "a.ts", message: "m" }]
  };
  assert.equal(exitCodeFor([report]), 0);
  assert.equal(exitCodeFor([report], { strict: true }), 1);
});

test("report: exit code is 1 whenever an error is present", () => {
  const report = {
    guard: "demo",
    filesScanned: 1,
    findings: [{ rule: "r", severity: "error" as const, file: "a.ts", line: 3, message: "m" }]
  };
  assert.equal(exitCodeFor([report]), 1);
  assert.equal(renderReport(report).includes("a.ts:3"), true);
  assert.equal(renderSummary([report]).includes("1 error(s)"), true);
});

test("report: a clean report says so", () => {
  const rendered = renderReport({ guard: "demo", filesScanned: 5, findings: [] });
  assert.equal(rendered.includes("no findings"), true);
});
