import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** Extensions (and bare names) that are text in this repo. Binary formats are simply not listed. */
const TEXT_EXT = new Set([
  ".md", ".ts", ".mjs", ".js", ".cjs", ".json", ".yml", ".yaml", ".txt", ".sh", ".example",
  ".gitignore", ".gitattributes", ".code-workspace", ".sql", ".cs", ".css", ".html", ".toml",
]);
const TEXT_NAMES = new Set(["CODEOWNERS"]);

export function isTextPath(file) {
  const base = path.basename(file);
  return TEXT_EXT.has(path.extname(file).toLowerCase()) || TEXT_NAMES.has(base) || TEXT_EXT.has(base);
}

/** Returns null when the bytes are clean strict UTF-8 with no BOM, else `{ offset, reason }`. */
export function checkUtf8(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { offset: 0, reason: "starts with a UTF-8 BOM" };
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    decoder.decode(buf);
    return null;
  } catch {
    return { offset: firstBadOffset(buf), reason: "not valid UTF-8" };
  }
}

/** Offset of the first byte that breaks strict UTF-8 (overlongs, surrogates and > U+10FFFF included). */
function firstBadOffset(buf) {
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b < 0x80) { i += 1; continue; }
    let need = 0;
    let min = 0x80;
    let cp = 0;
    if (b >= 0xc2 && b <= 0xdf) { need = 1; cp = b & 0x1f; }
    else if (b >= 0xe0 && b <= 0xef) { need = 2; cp = b & 0x0f; min = 0x800; }
    else if (b >= 0xf0 && b <= 0xf4) { need = 3; cp = b & 0x07; min = 0x10000; }
    else return i;
    if (i + need >= buf.length) return i; // truncated sequence at end of file
    for (let k = 1; k <= need; k++) {
      if ((buf[i + k] & 0xc0) !== 0x80) return i;
      cp = (cp << 6) | (buf[i + k] & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return i;
    i += need + 1;
  }
  return buf.length;
}

/** Tracked text files under `root` that fail `checkUtf8`: `[{ file, offset, reason }]`. */
export function findEncodingViolations(root) {
  const listed = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
  const out = [];
  for (const file of listed.split("\0").filter(Boolean).filter(isTextPath).sort()) {
    const abs = path.join(root, file);
    if (!fs.existsSync(abs)) continue; // tracked but deleted in the working tree
    const bad = checkUtf8(fs.readFileSync(abs));
    if (bad) out.push({ file, ...bad });
  }
  return out;
}
