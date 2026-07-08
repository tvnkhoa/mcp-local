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

// Normalize a filesystem path for JSON configs: forward slashes, preserve drive letter.
export function toConfigPath(p) {
  return p.replace(/\\/g, "/");
}
