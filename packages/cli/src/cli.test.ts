import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { EXEMPTABLE_RULES, parseExemptions, runConventionGuard } from "./guards/conventionGuard.js";
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

// --- convention exemptions ------------------------------------------------

test("exemptions: parsed from a line comment and from a JSDoc continuation", () => {
  // Both fixtures are single-line string literals rather than a multi-line template, so that
  // no line of THIS file begins with a comment marker followed by the pragma. Written as a
  // template, the JSDoc form below is a live exemption of cli.test.ts — which is how the
  // stale-exemption warning first fired.
  const lineCommentForm = "// @convention-exempt size/hard-cap: it is a façade";
  const jsdocForm = " * @convention-exempt size/soft-cap: generated";
  const found = parseExemptions([lineCommentForm, jsdocForm].join("\n"));
  assert.deepEqual(
    found.map((e) => [e.rule, e.reason, e.line]),
    [
      ["size/hard-cap", "it is a façade", 1],
      ["size/soft-cap", "generated", 2]
    ]
  );
});

test("exemptions: a pragma quoted inside a string is not an exemption", () => {
  // This is not hypothetical — the guard's own hint text quotes the syntax, and on the first
  // run it exempted conventionGuard.ts from its own hard cap.
  const source = `const hint = "Write: // @convention-exempt size/hard-cap: reason";
const x = 1;`;
  assert.deepEqual(parseExemptions(source), []);
});

test("exemptions: a reason-less pragma is parsed, so it can be reported rather than ignored", () => {
  const found = parseExemptions("// @convention-exempt size/hard-cap");
  assert.equal(found.length, 1);
  assert.equal(found[0]?.reason, "");
});

test("exemptions: only the size caps are exemptable", () => {
  // A line count is a proxy for complexity and can measure the wrong thing. The other rules
  // catch actual defects — console.log writes to the MCP transport — and must not be waivable.
  assert.deepEqual([...EXEMPTABLE_RULES].sort(), ["size/hard-cap", "size/soft-cap"]);
  assert.equal(EXEMPTABLE_RULES.includes("logging/console-log"), false);
  assert.equal(EXEMPTABLE_RULES.includes("package/required-file"), false);
});

test("convention guard: an accepted exemption is reported as info, not silence", () => {
  const report = runConventionGuard({ workspaceRoot, extraDirs: ["codebase-index-mcp/src"] });
  const exempted = report.findings.filter((f) => f.rule.startsWith("exemption/size/"));
  assert.equal(exempted.length > 0, true, "expected at least the graphStore.ts façade exemption");
  for (const finding of exempted) {
    assert.equal(finding.severity, "info", `${finding.file} exemption must not be blocking`);
    // The reason travels with the finding, so a reader never has to open the file to see it.
    assert.equal(finding.message.includes(" — "), true, `${finding.file} exemption lost its reason`);
    assert.equal(typeof finding.line, "number");
  }
  // And the exempted file no longer reports the underlying violation.
  const stillFlagged = report.findings.filter(
    (f) => f.rule === "size/hard-cap" && exempted.some((e) => e.file === f.file)
  );
  assert.deepEqual(stillFlagged, []);
});

test("convention guard: no stale or malformed exemptions anywhere in the workspace", () => {
  const report = runConventionGuard({ workspaceRoot, extraDirs: ["codebase-index-mcp/src"] });
  const bad = report.findings.filter(
    (f) => f.rule === "exemption/stale" || f.rule === "exemption/no-reason" || f.rule === "exemption/not-exemptable"
  );
  assert.deepEqual(bad, [], `unexpected exemption findings:
${renderReport(report)}`);
});

test("report: info findings never block, even under --strict", () => {
  // The whole point of the severity: an accepted exemption must survive S-41 flipping guards
  // to enforce. If info counted as a warning, --strict would fail on it.
  const report = {
    guard: "demo",
    filesScanned: 1,
    findings: [{ rule: "exemption/size/hard-cap", severity: "info" as const, file: "a.ts", message: "m — why" }]
  };
  const { errors, warnings, infos } = countBySeverity(report.findings);
  assert.deepEqual({ errors, warnings, infos }, { errors: 0, warnings: 0, infos: 1 });
  assert.equal(exitCodeFor([report]), 0);
  assert.equal(exitCodeFor([report], { strict: true }), 0);
  assert.equal(renderSummary([report]).includes("1 accepted exemption(s)"), true);
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
