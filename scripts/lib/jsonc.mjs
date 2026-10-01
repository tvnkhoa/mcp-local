// Minimal JSONC (JSON-with-comments) support + path normalization.
// Extracted verbatim from codebase-index-mcp/scripts/setup.mjs.

import fs from "node:fs";

// Strip // and /* */ comments, respecting string literals.
export function stripJsoncComments(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      out.push(text[i++]);
      while (i < text.length) {
        const c = text[i++];
        out.push(c);
        if (c === "\\") { if (i < text.length) out.push(text[i++]); }
        else if (c === '"') break;
      }
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (text[i] === "/" && text[i + 1] === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; continue; }
    out.push(text[i++]);
  }
  return out.join("");
}

// Remove trailing commas before } or ] (common in VS Code settings.json /
// opencode.jsonc). String-aware so commas inside string values are preserved.
export function stripTrailingCommas(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      out.push(c); i++;
      while (i < text.length) {
        const d = text[i]; out.push(d); i++;
        if (d === "\\") { if (i < text.length) { out.push(text[i]); i++; } }
        else if (d === '"') break;
      }
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (j < text.length && (text[j] === "}" || text[j] === "]")) { i++; continue; } // drop trailing comma
    }
    out.push(c); i++;
  }
  return out.join("");
}

export function readJsonc(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  try { return JSON.parse(raw); }
  catch { return JSON.parse(stripTrailingCommas(stripJsoncComments(raw))); }
}

/**
 * Write `content` to `filePath` via a sibling temp file and a rename.
 *
 * The files this tooling writes are ones another process reads while it runs: `~/.claude.json` is
 * Claude Code's live state file (tens of KB holding every project's history, not only MCP config),
 * and a skill file is re-read by a running agent. A plain `writeFileSync` truncates first, so a
 * crash, a full disk or a concurrent read in that window leaves a half-written file — for
 * `~/.claude.json`, one Claude Code then fails to parse. A rename within one directory replaces the
 * file in a single step on every platform Node supports.
 *
 * Falls back to a direct write when the rename is refused (Windows reports EPERM/EBUSY while
 * another process holds the target open without share-delete), so a locked file degrades to the
 * previous behaviour instead of failing the install.
 */
export function writeFileAtomic(filePath, content) {
  const tmp = `${filePath}.${String(process.pid)}.${String(Date.now())}.tmp`;
  fs.writeFileSync(tmp, content, "utf-8");
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    if (e?.code !== "EPERM" && e?.code !== "EBUSY" && e?.code !== "EACCES") throw e;
    fs.writeFileSync(filePath, content, "utf-8");
  }
}

// ---------------------------------------------------------------------------------------------
// Comment-preserving edits (P4c).
//
// VS Code's settings.json is JSONC, and people keep comments in it. Parsing it and writing
// `JSON.stringify` back deletes every one of them — the installer was doing exactly that. The
// helpers below edit the TEXT instead: they locate the span of one member and splice a new value
// in, insert a member, or cut one out, leaving every other byte (comments, ordering, indentation)
// as it was.
//
// This is deliberately not a general JSONC library. It knows objects, arrays, strings and bare
// literals, which is all JSON has; anything it cannot parse makes it return null. The caller
// (`agents.mjs`) also re-parses the edited text and compares it with the structural result it
// intended, and refuses to write on any difference — so a bug here costs a warning, not a file.
// ---------------------------------------------------------------------------------------------

/** True when `text` holds a `//` or block comment outside string literals. */
export function hasJsoncComments(text) {
  return stripJsoncComments(text) !== text;
}

function skipTrivia(text, i) {
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "﻿") { i++; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new Error("unterminated comment");
      i = end + 2;
      continue;
    }
    break;
  }
  return i;
}

function scanString(text, i) {
  // text[i] === '"'; returns the index just past the closing quote.
  let j = i + 1;
  while (j < text.length) {
    const c = text[j++];
    if (c === "\\") j++;
    else if (c === '"') return j;
  }
  throw new Error("unterminated string");
}

// Returns { start, end, members? } where `end` is exclusive and `members` is set for objects:
// [{ key, keyStart, valueStart, value }].
function scanValue(text, i) {
  i = skipTrivia(text, i);
  const start = i;
  const c = text[i];
  if (c === '"') return { start, end: scanString(text, i) };
  if (c === "{" || c === "[") {
    const isObj = c === "{";
    const close = isObj ? "}" : "]";
    const members = [];
    i++;
    for (;;) {
      i = skipTrivia(text, i);
      if (text[i] === close) return { start, end: i + 1, members: isObj ? members : undefined };
      if (isObj) {
        if (text[i] !== '"') throw new Error(`expected a key at ${String(i)}`);
        const keyStart = i;
        const keyEnd = scanString(text, i);
        const key = JSON.parse(text.slice(keyStart, keyEnd));
        i = skipTrivia(text, keyEnd);
        if (text[i] !== ":") throw new Error(`expected ':' at ${String(i)}`);
        const value = scanValue(text, i + 1);
        members.push({ key, keyStart, valueStart: value.start, value });
        i = value.end;
      } else {
        i = scanValue(text, i).end;
      }
      i = skipTrivia(text, i);
      if (text[i] === ",") { i++; continue; } // a trailing comma falls through to `close` above
      if (text[i] !== close) throw new Error(`expected ',' or '${close}' at ${String(i)}`);
    }
  }
  const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 64));
  if (!m) throw new Error(`unexpected token at ${String(i)}`);
  return { start, end: i + m[0].length };
}

function lineIndent(text, pos) {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))[0];
}

function indentUnit(text) {
  const m = /\n([ \t]+)"/.exec(text);
  return m ? m[1] : "  ";
}

function formatValue(value, indent, unit) {
  return JSON.stringify(value, null, unit).replace(/\n/g, `\n${indent}`);
}

/**
 * Apply `edits` to JSONC `text` without touching anything else. Each edit is
 * `{ path: string[], value }` (set, creating missing parent objects) or `{ path, remove: true }`.
 * Returns the new text, or null when the text cannot be scanned or a path crosses a non-object.
 */
export function editJsoncText(text, edits) {
  let out = text;
  for (const edit of edits) {
    const next = edit.remove ? removeMember(out, edit.path) : setMember(out, edit.path, edit.value);
    if (next === null) return null;
    out = next;
  }
  return out;
}

function setMember(text, keys, value) {
  let node;
  try { node = scanValue(text, 0); } catch { return null; }
  const unit = indentUnit(text);
  for (let d = 0; d < keys.length; d++) {
    if (!node.members) return null;
    const hit = node.members.find((m) => m.key === keys[d]);
    if (hit && d === keys.length - 1) {
      const v = formatValue(value, lineIndent(text, hit.keyStart), unit);
      return text.slice(0, hit.valueStart) + v + text.slice(hit.value.end);
    }
    if (hit) { node = hit.value; continue; }
    // Missing from here down: insert one member holding the rest of the path, as the first member.
    let rest = value;
    for (let k = keys.length - 1; k > d; k--) rest = { [keys[k]]: rest };
    const outer = lineIndent(text, node.start);
    const inner = node.members.length ? lineIndent(text, node.members[0].keyStart) : outer + unit;
    const member = `\n${inner}${JSON.stringify(keys[d])}: ${formatValue(rest, inner, unit)}`;
    const at = node.start + 1;
    return text.slice(0, at) + member + (node.members.length ? "," : `\n${outer}`) + text.slice(at);
  }
  return null;
}

function removeMember(text, keys) {
  let node;
  try { node = scanValue(text, 0); } catch { return null; }
  for (let d = 0; d < keys.length; d++) {
    if (!node.members) return null;
    const idx = node.members.findIndex((m) => m.key === keys[d]);
    if (idx === -1) return text; // nothing to remove
    const hit = node.members[idx];
    if (d < keys.length - 1) { node = hit.value; continue; }

    let from = hit.keyStart;
    let to = hit.value.end;
    let j = to;
    while (text[j] === " " || text[j] === "\t") j++;
    if (text[j] === ",") {
      to = j + 1;
    } else if (idx > 0) {
      // Last member: take the comma that separated it from the previous one instead.
      let p = node.members[idx - 1].value.end;
      while (text[p] === " " || text[p] === "\t" || text[p] === "\n" || text[p] === "\r") p++;
      if (text[p] === ",") {
        return text.slice(0, p) + text.slice(p + 1, from).replace(/[ \t]*\r?\n[ \t]*$/, "") + text.slice(to);
      }
    }
    // Drop the member's whole line when nothing else shares it.
    const lineStart = text.lastIndexOf("\n", from - 1) + 1;
    if (/^[ \t]*$/.test(text.slice(lineStart, from))) {
      const tail = /^[ \t]*\r?\n/.exec(text.slice(to));
      if (tail) { from = lineStart; to += tail[0].length; }
    }
    return text.slice(0, from) + text.slice(to);
  }
  return null;
}

// Normalize a filesystem path for JSON configs: forward slashes, preserve drive letter.
export function toConfigPath(p) {
  return p.replace(/\\/g, "/");
}
