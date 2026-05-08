import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(__dirname, "../src");

const bannedImportMatchers = [
  /from\s+["']openai["']/i,
  /from\s+["']anthropic["']/i,
  /from\s+["']langchain/i,
  /from\s+["']@azure\/openai["']/i,
  /from\s+["']azure\/openai["']/i,
  /from\s+["'][^"']*\/inference["']/i,
  /from\s+["'][^"']*llm[^"']*["']/i,
  /require\(\s*["']openai["']\s*\)/i,
  /require\(\s*["']anthropic["']\s*\)/i,
  /require\(\s*["']langchain[^"']*["']\s*\)/i,
  /require\(\s*["']@azure\/openai["']\s*\)/i,
  /require\(\s*["']azure\/openai["']\s*\)/i,
  /require\(\s*["'][^"']*\/inference["']\s*\)/i,
  /require\(\s*["'][^"']*llm[^"']*["']\s*\)/i
];

const bannedRuntimeCallMatchers = [
  /api\.openai\.com/i,
  /api\.anthropic\.com/i,
  /new\s+OpenAI\s*\(/i,
  /new\s+Anthropic\s*\(/i
];

function listTsFiles(dirPath) {
  const out = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(abs));
      continue;
    }
    if (entry.isFile() && /\.(ts|tsx|mts|cts)$/i.test(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

function findMatches(content, filePath, matcher, reason) {
  const lines = content.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (matcher.test(lines[i])) {
      hits.push({ filePath, line: i + 1, reason, excerpt: lines[i].trim() });
    }
  }
  return hits;
}

const violations = [];
for (const abs of listTsFiles(srcRoot)) {
  const rel = path.relative(path.resolve(__dirname, ".."), abs).replace(/\\/g, "/");
  const content = fs.readFileSync(abs, "utf8");

  for (const matcher of bannedImportMatchers) {
    violations.push(...findMatches(content, rel, matcher, "banned model/inference import"));
  }
  for (const matcher of bannedRuntimeCallMatchers) {
    violations.push(...findMatches(content, rel, matcher, "banned external model runtime call"));
  }
}

if (violations.length > 0) {
  console.error("[guard-no-llm-runtime] violations found:");
  for (const v of violations) {
    console.error(`- ${v.filePath}:${v.line} | ${v.reason} | ${v.excerpt}`);
  }
  process.exit(1);
}

console.log("[guard-no-llm-runtime] passed: no model provider imports/calls detected in runtime source.");
