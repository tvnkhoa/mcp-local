// Colored console helpers + a readline prompt. Shared by all root MCP scripts.
// Extracted/generalized from codebase-index-mcp/scripts/setup.mjs.

import readline from "node:readline";

export const C = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
};

export function log(msg, color = C.reset) {
  console.log(`${color}${msg}${C.reset}`);
}

export function section(title) {
  console.log();
  log("=".repeat(64), C.cyan);
  log(`  ${title}`, C.bright + C.cyan);
  log("=".repeat(64), C.cyan);
  console.log();
}

export function banner(title) {
  const width = 64;
  const pad = Math.max(0, width - 2 - title.length);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  console.log();
  log("╔" + "═".repeat(width - 2) + "╗", C.bright + C.cyan);
  log("║" + " ".repeat(left) + title + " ".repeat(right) + "║", C.bright + C.cyan);
  log("╚" + "═".repeat(width - 2) + "╝", C.bright + C.cyan);
  console.log();
}

export function ok(msg) { log(`✓ ${msg}`, C.green); }
export function warn(msg) { log(`⚠ ${msg}`, C.yellow); }
export function err(msg) { log(`✗ ${msg}`, C.red); }
export function info(msg) { log(`ℹ ${msg}`, C.blue); }
export function step(msg) { log(`→ ${msg}`, C.dim); }

// Prompt with a default. When `yes` is true, skips the prompt and returns the default.
export async function ask(question, defaultVal, yes = false) {
  if (yes) {
    info(`${question} → ${defaultVal || "(empty)"} (--yes)`);
    return defaultVal;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const hint = defaultVal ? ` [${defaultVal}]` : "";
    rl.question(`${C.cyan}${question}${C.reset}${hint} `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultVal || "");
    });
  });
}
