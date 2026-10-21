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
  // Each segment remembers whether a single `|` led into it: such a segment reads the previous
  // command's output (`node --test x | grep -E "^# pass"`), not files. `||` is an OR, not a pipe.
  const segs = [{ tokens: [], piped: false }];
  let cur = "";
  let q = null;
  const flush = () => { if (cur) { segs[segs.length - 1].tokens.push(cur); cur = ""; } };
  const split = (piped) => { flush(); if (segs[segs.length - 1].tokens.length) segs.push({ tokens: [], piped }); else segs[segs.length - 1].piped = piped; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < s.length && '$`"\\'.includes(s[i + 1])) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === "|") {
      const orOperator = s[i + 1] === "|";
      if (orOperator) i++;
      split(!orOperator);
      continue;
    }
    if (c === ";" || c === "&" || c === "\n" || c === "(" || c === ")") { split(false); continue; }
    if (/\s/.test(c)) { flush(); continue; }
    cur += c;
  }
  flush();
  return segs.filter((t) => t.tokens.length > 0);
}

/** Directory-changing commands whose first argument is the new working directory. */
const CD = new Set(["cd", "pushd", "Set-Location", "sl", "chdir"]);

/**
 * The first grep/rg/sed segment of a shell command, as { tool, pattern, paths, filesOnly, cd }.
 * `cd` lists every directory the command changed into before that segment, in order.
 */
export function parseShellSearch(command) {
  const cd = [];
  for (const { tokens: t, piped } of segments(String(command))) {
    const tool = t[0];
    if (CD.has(tool)) {
      const dir = t.slice(1).find((x) => !x.startsWith("-"));
      if (dir) cd.push(dir);
      continue;
    }
    if (tool === "sed") {
      const range = t.find((x) => /^\d+,\d+p$/.test(x));
      const file = t.slice(1).reverse().find((x) => !x.startsWith("-") && x !== range);
      if (range && file) return { tool, pattern: null, paths: [file], filesOnly: false, range, cd };
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
    // After a `|` with no path, grep filters the previous command's output: not a repo search.
    if (piped && paths.length === 0) continue;
    if (pattern) return { tool, pattern, paths, filesOnly, cd };
  }
  return null;
}

const NOT_INDEXED = /\.(jsonl?|log|txt|csv|lock)$|node_modules|scratchpad|[\\/]Temp[\\/]|\.claude[\\/]projects/i;

/** A shell glob: the path names many files, so it cannot be a query_docs `filePath`. */
const GLOB = /[*?[{]/;

/**
 * `p` as a comparable absolute path, resolved against `base`: forward slashes, `~` / `$HOME` /
 * `$CLAUDE_PROJECT_DIR` expanded, Git Bash's `/d/...` read as `d:/...`, and lower-cased when it
 * carries a drive letter (Windows paths are case-insensitive and the drive's case is not stable).
 * Returns null when `p` starts with a variable it cannot expand — unknown, so not judged.
 */
function resolveLoose(p, base, env = process.env) {
  let s = String(p).replace(/\\/g, "/");
  const home = (env.HOME || env.USERPROFILE || os.homedir()).replace(/\\/g, "/");
  s = s.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
  if (env.CLAUDE_PROJECT_DIR) s = s.replace(/^\$\{?CLAUDE_PROJECT_DIR\}?(?=\/|$)/, env.CLAUDE_PROJECT_DIR.replace(/\\/g, "/"));
  if (s.startsWith("$")) return null;
  s = s.replace(/^\/([a-zA-Z])(?=\/|$)/, "$1:");
  const absolute = /^[a-zA-Z]:\//.test(s) || /^[a-zA-Z]:$/.test(s) || s.startsWith("/");
  if (!absolute) {
    if (!base) return null;
    s = `${base.replace(/\/+$/, "")}/${s}`;
  }
  s = path.posix.normalize(s.replace(/^([a-zA-Z]):(?!\/)/, "$1:/")).replace(/\/+$/, "");
  return /^[a-zA-Z]:/.test(s) ? s.toLowerCase() : s;
}

function isInside(child, parent) {
  return child === parent || child.startsWith(`${parent}/`);
}

/**
 * True when the search reads outside the project, so a suggestion naming the project's repoId
 * would point at files the index does not hold: a `cd` that leaves the project (or one whose target
 * cannot be resolved), or a target path that resolves outside it.
 *
 * `where.projectDir` is CLAUDE_PROJECT_DIR, or the event cwd when that is absent; `where.cwd` is the
 * event cwd (what relative paths are relative to). Without a projectDir there is nothing to judge
 * against, and the search is treated as inside — the hook's behaviour before this check existed.
 */
export function readsOutsideProject(search, where = {}) {
  const env = where.env ?? process.env;
  const project = where.projectDir ? resolveLoose(where.projectDir, null, env) : null;
  if (!project) return false;
  let cwd = (where.cwd ? resolveLoose(where.cwd, null, env) : null) ?? project;
  for (const dir of search.cd ?? []) {
    const next = resolveLoose(dir, cwd, env);
    if (next === null || !isInside(next, project)) return true;
    cwd = next;
  }
  return search.paths.some((p) => {
    const abs = resolveLoose(p, cwd, env);
    return abs !== null && !isInside(abs, project);
  });
}

/**
 * What to suggest for one search, or null to stay quiet. Quiet is the default: a hook that comments
 * on every grep is a hook agents learn to skip past.
 *
 * `where` ({ projectDir, cwd }) enables the location check: quiet when the search reads outside the
 * project (see readsOutsideProject). Quiet, too, for a glob path — `*\/SKILL.md` is not a filePath.
 */
export function suggestionFor(search, repoId, where) {
  if (!search) return null;
  if (search.paths.some((p) => NOT_INDEXED.test(p))) return null;
  if (search.paths.some((p) => GLOB.test(p))) return null;
  if (where && readsOutsideProject(search, where)) return null;
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
  // Outside the project (a `cd ~/.claude/skills && grep …`, a path under the home directory) the
  // index named by repoId does not hold the files, so a suggestion would point at nothing.
  const where = { projectDir: process.env.CLAUDE_PROJECT_DIR || event.cwd, cwd: event.cwd || process.env.CLAUDE_PROJECT_DIR };
  const note = suggestionFor(search, repoId, where);
  if (!note || !underBudget(event.session_id ?? "unknown", Number(process.env.GREP_TO_MCP_MAX) || 5)) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: note } }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Never fail the tool call: any error here is swallowed and the hook exits 0 with no output.
  main().catch(() => {}).finally(() => process.exit(0));
}
