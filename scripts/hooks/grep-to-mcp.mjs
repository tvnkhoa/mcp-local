#!/usr/bin/env node
/**
 * PreToolUse hook template: when an agent greps for something the codebase-index MCP answers
 * better, add a one-line suggestion to its context. NON-BLOCKING: it never denies, never sets a
 * permission decision, and exits 0 on every path, so the grep runs exactly as it would have.
 *
 * Why (wec.aria adoption plan, R12b): 170 transcripts held ~10 000 greps and ~28 MCP calls. The
 * most-grepped shapes were snake_case names, markdown headings/rows and `sed -n` line ranges of docs,
 * all of which one MCP call now answers. Install only once the index refreshes itself (R1), or the
 * suggestion points at stale answers and agents learn to ignore it.
 *
 * Register it in the PROJECT's .claude/settings.json (the project owner's decision — this file does
 * not install itself):
 *
 *   "hooks": { "PreToolUse": [
 *     { "matcher": "Grep",            "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/grep-to-mcp.mjs\"", "timeout": 5 }] },
 *     { "matcher": "Bash|PowerShell", "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/grep-to-mcp.mjs\"", "timeout": 5 }] }
 *   ] }
 *
 * Env: GREP_TO_MCP_REPO_ID — the repoId to name in suggestions (default: the folder name of
 * CLAUDE_PROJECT_DIR, then of the event cwd).
 *      GREP_TO_MCP_MAX — suggestions per session before it goes quiet (default 5).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shell-ish split into segments of tokens. Quote-aware, so the `|` in `grep '^| 737 '` stays part of
 * the pattern instead of reading as a pipe. Bash keeps `\` in "..." except before $ ` " \.
 */
function segments(s) {
  const segs = [[]];
  let cur = "";
  let q = null;
  const flush = () => { if (cur) { segs[segs.length - 1].push(cur); cur = ""; } };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < s.length && '$`"\\'.includes(s[i + 1])) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === "|" || c === ";" || c === "&" || c === "\n") { flush(); if (segs[segs.length - 1].length) segs.push([]); continue; }
    if (/\s/.test(c)) { flush(); continue; }
    cur += c;
  }
  flush();
  return segs.filter((t) => t.length > 0);
}

/** The first grep/rg/sed segment of a shell command, as { tool, pattern, paths, filesOnly }. */
export function parseShellSearch(command) {
  for (const t of segments(String(command))) {
    const tool = t[0];
    if (tool === "sed") {
      const range = t.find((x) => /^\d+,\d+p$/.test(x));
      const file = t.slice(1).reverse().find((x) => !x.startsWith("-") && x !== range);
      if (range && file) return { tool, pattern: null, paths: [file], filesOnly: false, range };
      continue;
    }
    if (tool !== "grep" && tool !== "rg") continue;
    let pattern = null;
    const paths = [];
    let filesOnly = false;
    for (let i = 1; i < t.length; i++) {
      const a = t[i];
      if (a === "-e" || a === "--regexp") { pattern ??= t[++i] ?? null; continue; }
      if (/^-(?:[ABCmg]|-include|-exclude|-glob|t|-type)$/.test(a)) { i++; continue; }
      if (a.startsWith("-")) { if (/^-[a-zA-Z]*l/.test(a) || a === "--files-with-matches") filesOnly = true; continue; }
      if (pattern === null) pattern = a;
      else paths.push(a);
    }
    if (pattern) return { tool, pattern, paths, filesOnly };
  }
  return null;
}

const NOT_INDEXED = /\.(jsonl?|log|txt|csv|lock)$|node_modules|scratchpad|[\\/]Temp[\\/]|\.claude[\\/]projects/i;

/**
 * What to suggest for one search, or null to stay quiet. Quiet is the default: a hook that comments
 * on every grep is a hook agents learn to skip past.
 */
export function suggestionFor(search, repoId) {
  if (!search) return null;
  if (search.paths.some((p) => NOT_INDEXED.test(p))) return null;
  const mdPath = search.paths.find((p) => /\.mdx?$/i.test(p));

  if (search.tool === "sed") {
    if (!mdPath) return null;
    return `codebase-index: read a doc section by heading, not by line range — query_docs(repoId: "${repoId}", mode: "section", filePath: "${mdPath}", headingPrefix: "<heading>", maxTokens: 2000). A heading survives edits above it; a line number does not.`;
  }

  const p = search.pattern;
  if (/^\^?\\?#{1,6}\s|^\^?\\?\|\s*#?\d|\*\*Status\*\*|§/.test(p) || (mdPath && !/[a-z]+_[a-z0-9_]+|[a-z][A-Z]/.test(p))) {
    return `codebase-index: for a heading use query_docs(repoId: "${repoId}", mode: "section", filePath: "${mdPath ?? "<doc>.md"}", headingPrefix: "<heading>"); for text across docs use query_docs(repoId: "${repoId}", mode: "search", query: "<words>").`;
  }

  const ident = p.replace(/\\b/g, "").match(/^[A-Za-z_][A-Za-z0-9_]*$/)?.[0];
  if (search.filesOnly) {
    return `codebase-index: "which files mention X" is one call — search_regex(repoId: "${repoId}", pattern: ${JSON.stringify(p)}, outputMode: "files").`;
  }
  if (ident && (/_/.test(ident) || /[a-z][A-Z]|^[A-Z][a-z]+[A-Z]/.test(ident))) {
    return `codebase-index: for the identifier ${ident} try search_symbols(repoId: "${repoId}", query: "${ident}", strategy: "name") for its definition, or search_regex(repoId: "${repoId}", pattern: "\\\\b${ident}\\\\b") for every use with its enclosing symbol.`;
  }
  return null;
}

/** At most `max` suggestions per session, so the note stays a nudge. */
function underBudget(sessionId, max) {
  const file = path.join(os.tmpdir(), `grep-to-mcp-${String(sessionId).replace(/[^\w-]/g, "_")}.json`);
  let n = 0;
  try { n = JSON.parse(fs.readFileSync(file, "utf8")).n ?? 0; } catch { /* first one */ }
  if (n >= max) return false;
  try { fs.writeFileSync(file, JSON.stringify({ n: n + 1 })); } catch { /* best-effort */ }
  return true;
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let event;
  try { event = JSON.parse(raw); } catch { return; }
  const input = event.tool_input ?? {};
  const search =
    event.tool_name === "Grep"
      ? { tool: "Grep", pattern: String(input.pattern ?? ""), paths: input.path ? [String(input.path)] : input.glob ? [String(input.glob)] : [], filesOnly: input.output_mode === "files_with_matches" }
      : event.tool_name === "Bash" || event.tool_name === "PowerShell"
        ? parseShellSearch(input.command ?? "")
        : null;
  // The project root, not the session cwd: a session working in packages/core would otherwise name
  // repoId "core" (wec.aria's install of R12, 3e11fe68).
  const repoId = process.env.GREP_TO_MCP_REPO_ID || path.basename(process.env.CLAUDE_PROJECT_DIR || event.cwd || process.cwd());
  const note = suggestionFor(search, repoId);
  if (!note || !underBudget(event.session_id ?? "unknown", Number(process.env.GREP_TO_MCP_MAX) || 5)) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: note } }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Never fail the tool call: any error here is swallowed and the hook exits 0 with no output.
  main().catch(() => {}).finally(() => process.exit(0));
}
