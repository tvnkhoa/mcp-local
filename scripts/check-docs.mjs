#!/usr/bin/env node
/**
 * The documentation gate. Five checks, each closing a failure mode that produced a real defect:
 *
 *   links      every relative markdown link and `#anchor` resolves
 *   tool-args  every documented `tool_name({ prop: … })` matches the tool's inputSchema
 *   tool-names every tool-shaped name cited in a doc exists in a contract
 *   claims     prose lists that claim a capability ("tools with profile support") match the contract
 *   env-names  a deprecated env alias is never used as the operative name
 *
 * Why each exists — all four were found by hand, none by a gate:
 *   - a skill template shipped `find_impact_files(changedFiles:)`, which `.strict()` rejects
 *   - `postgres-mcp`'s skill named `PG_WRITE_ENABLED` for three weeks after S-43 renamed it
 *   - an always-on rule file named two tools that never existed
 *   - `codebase-index-mcp/README.md` claimed `profile` support for 6 tools that have none
 *
 * Enumerates tracked AND untracked-not-ignored files: the archive's own index was invisible to an
 * earlier `git ls-files`-only check for exactly this reason.
 *
 * Historical documents (`docs/archive/**`, CHANGELOG, the issue registries) are exempt from every
 * check except `links`: they describe a past state by design, and an archived audit that documents
 * `find_impact_files(changedFiles:)` as a defect must not be reported as committing it.
 *
 *   node scripts/check-docs.mjs [--quiet]
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

import { SERVERS, WORKSPACE_ROOT } from "./lib/manifest.mjs";
import { C, err, log, ok, warn } from "./lib/log.mjs";

const QUIET = process.argv.includes("--quiet");
const R = WORKSPACE_ROOT;

// `@mcp/core` compiles to a gitignored dist/, so a bare static import would give a fresh clone a raw
// ERR_MODULE_NOT_FOUND — the same trap `lib/manifest.mjs` documents. Dynamic import is the only
// construct that can intercept it.
let ERROR_CODES;
try {
  ({ ERROR_CODES } = await import("@mcp/core"));
} catch (cause) {
  if (cause?.code === "ERR_MODULE_NOT_FOUND") {
    throw new Error(
      "@mcp/core is not built yet. Run `npm run build:packages` from the workspace root, then retry.",
      { cause }
    );
  }
  throw cause;
}

/** Tracked + untracked-not-ignored markdown. Both, deliberately — see the header. */
function markdownFiles() {
  const run = (cmd) =>
    execSync(cmd, { cwd: R, encoding: "utf8" }).split("\n").map((s) => s.trim()).filter(Boolean);
  const tracked = run('git ls-files "*.md"');
  const untracked = run('git ls-files --others --exclude-standard "*.md"');
  return [...new Set([...tracked, ...untracked])].sort();
}

const HISTORICAL = (f) =>
  f.startsWith("docs/archive/") || f === "CHANGELOG.md" || f.includes("issue-registry");

/** Blank out fenced blocks and inline code, preserving offsets so line numbers stay true. */
function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
}

function headingSlugs(absPath) {
  const out = new Set();
  for (const m of fs.readFileSync(absPath, "utf8").matchAll(/^#{1,6}\s+(.*)$/gm)) {
    out.add(m[1].toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-"));
  }
  return out;
}

/** name -> { props:Set, servers:string[] } unioned across contracts (health_check exists in all four). */
function toolIndex() {
  const tools = new Map();
  for (const server of SERVERS) {
    const file = path.join(R, "contracts", `${server.key}.json`);
    if (!fs.existsSync(file)) continue;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const tool of parsed.tools ?? parsed) {
      if (!tools.has(tool.name)) tools.set(tool.name, { props: new Set(), servers: [] });
      const entry = tools.get(tool.name);
      entry.servers.push(server.key);
      for (const prop of Object.keys(tool.inputSchema?.properties ?? {})) entry.props.add(prop);
    }
  }
  return tools;
}

/** Deprecated alias -> canonical name, from the manifest's env specs. */
function envAliases() {
  const aliases = new Map();
  const canonical = new Set();
  for (const server of SERVERS) {
    for (const field of server.env) {
      canonical.add(field.name.replace(/\*$/, ""));
      for (const alias of field.deprecatedAliases ?? []) {
        aliases.set(alias.replace(/\*$/, ""), field.name);
      }
    }
  }
  return { aliases, canonical };
}

const findings = [];
const add = (check, file, line, message) => findings.push({ check, file, line, message });

const files = markdownFiles();
const tools = toolIndex();
const { aliases, canonical } = envAliases();

// Names that match the tool grammar but are not tools. Error codes come from `@mcp/core` so the
// list cannot fall behind; the rest are baseline tooling and naming conventions.
const NOT_TOOLS = new Set([
  ...ERROR_CODES,
  "read_file", "grep_search", "file_search", "codebase_search", "semantic_search",
  "snake_case", "kebab_case", "camel_case", "pascal_case", "record_struct",
  // Owner-prover rule names (B-13). They are response *values* — `ownerResolver.ts` reports which
  // rule decided a site — and read as tool-shaped only because they are snake_case in backticks.
  "enclosing_type_fallback", "static_type_receiver", "receiver_member_type", "declaration_site",
  "initializer_type_match", "qualified_type_receiver", "base_type_receiver", "implicit_this",
  "receiver_type_match", "receiver_type_not_in_scope", "receiver_path_unresolved",
  "receiver_not_identifier", "site_not_an_identifier", "parse_unavailable",
]);

// A line may name a non-existent tool in order to say it does not exist. Exempt the disclaimer, not
// the name — denylisting the name would blind the gate to someone reintroducing it as real guidance.
const DISCLAIMS =
  /(n?ever|not) existed|not real tool names|do(es)? not exist|no such tool|wrong names/i;

for (const file of files) {
  const abs = path.join(R, file);
  const text = fs.readFileSync(abs, "utf8");
  const bare = stripCode(text);
  const lines = text.split("\n");
  const bareLines = bare.split("\n");

  // 1. links + anchors
  bareLines.forEach((line, i) => {
    for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const [rel, anchor] = target.split("#");
      if (!rel) continue;
      const resolved = path.resolve(path.dirname(abs), rel);
      if (!fs.existsSync(resolved)) {
        add("links", file, i + 1, `${target} does not exist`);
      } else if (anchor && resolved.endsWith(".md") && !headingSlugs(resolved).has(decodeURIComponent(anchor).toLowerCase())) {
        add("links", file, i + 1, `${target} — no such heading`);
      }
    }
  });

  // 2. tool arguments, and 3. tool names.
  // Historical records quote past defects on purpose — an archived audit that documents
  // `find_impact_files(changedFiles:)` as a finding must not be reported as committing it.
  if (!HISTORICAL(file)) lines.forEach((line, i) => {
    for (const m of line.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*\(\s*\{?([^)]{0,400})/g)) {
      const info = tools.get(m[1]);
      if (!info) continue;
      const body = m[2].replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
      for (const prop of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
        if (info.props.has(prop[1])) continue;
        add("tool-args", file, i + 1, `${m[1]}({ ${prop[1]}: … }) — not in inputSchema (${[...info.props].sort().join(", ")})`);
      }
    }
    for (const m of line.matchAll(/`(?:mcp__[a-z-]+__)?([a-z][a-z0-9]*(?:_[a-z0-9]+){1,4})`/g)) {
      const name = m[1];
      if (tools.has(name) || NOT_TOOLS.has(name)) continue;
      if (!/\b(tool|call)\b/i.test(line) && !line.includes("mcp__")) continue;
      // Disclaimers wrap across lines — "…named `get_module_flow` … , neither\n of which ever
      // existed." A single-line test misses the second half, so check a two-line window.
      if (DISCLAIMS.test(`${line} ${lines[i + 1] ?? ""}`)) continue;
      add("tool-names", file, i + 1, `\`${name}\` is not declared in any contract`);
    }
  });

  // 4. capability claims — a prose list that asserts which tools support a parameter
  if (!HISTORICAL(file)) {
    lines.forEach((line, i) => {
      const claim = /tools?\s+(?:with|that\s+(?:support|accept))\s+`?(\w+)`?\s+(?:support|accept)?/i.exec(line);
      if (!claim) return;
      const prop = claim[1];
      const named = [...line.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((m) => m[1]).filter((n) => tools.has(n));
      for (const name of named) {
        if (!tools.get(name).props.has(prop)) {
          add("claims", file, i + 1, `claims \`${name}\` accepts \`${prop}\`, but its schema does not`);
        }
      }
    });
  }

  // 5. deprecated env alias used as the operative name
  if (!HISTORICAL(file)) {
    lines.forEach((line, i) => {
      // "renamed — still accepts X", "(was X)", "pre-S-43 name X", "cũ: X" are annotations, not instructions
      if (/still accepts|\(was |pre-S-43|formerly|renamed|deprecat|legacy|alias|old \*?prefix|cũ:|outbound contract/i.test(line)) return;
      for (const m of line.matchAll(/`([A-Z][A-Z0-9_]{3,})(?:=[^`]*)?`/g)) {
        const canonicalName = aliases.get(m[1]);
        if (!canonicalName || canonical.has(m[1])) continue;
        add("env-names", file, i + 1, `\`${m[1]}\` is a deprecated alias — use \`${canonicalName}\``);
      }
    });
  }
}

const CHECKS = ["links", "tool-args", "tool-names", "claims", "env-names"];
const counts = Object.fromEntries(CHECKS.map((c) => [c, findings.filter((f) => f.check === c).length]));

if (!QUIET) {
  for (const check of CHECKS) {
    const n = counts[check];
    if (n === 0) log(`  ${C.green}✓${C.reset} ${check.padEnd(11)} clean`);
    else log(`  ${C.red}✗${C.reset} ${check.padEnd(11)} ${n} finding${n === 1 ? "" : "s"}`, C.red);
  }
  console.log();
}

for (const f of findings) err(`${f.file}:${f.line}  [${f.check}] ${f.message}`);

if (findings.length > 0) {
  console.log();
  err(`docs:check — ${findings.length} finding(s) across ${files.length} markdown files`);
  process.exit(1);
}
ok(`docs:check — ${files.length} markdown files, all five checks clean`);
