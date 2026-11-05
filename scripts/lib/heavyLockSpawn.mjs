/**
 * Run the command `heavy-lock.mjs` wraps with every argument reaching it literally (row H-7, 2026-11-05).
 *
 * Before this, Windows ran the command with `shell: true` and quoted only arguments holding whitespace or
 * a quote, so cmd.exe interpreted `> & | ( ) ^ % !` in any argument (`node -e "()=>{}"` became a redirect to
 * a file named `{}`) and a command[0] with spaces split. Now:
 *
 * - A command resolved to an `.exe` / `.com` (PATH + PATHEXT, as cmd resolves it) is spawned directly, no
 *   shell: Node quotes each argument for the program's own parser, and nothing is a metacharacter.
 * - A `.cmd` / `.bat` (npm, npx, most shims) cannot run without cmd.exe, and an unresolved name may be a
 *   cmd builtin, so those go through `cmd.exe /d /s /c "<line>"` with verbatim arguments. Each argument is
 *   quoted for the program's parser (backslashes doubled before a quote, quotes escaped), then every cmd
 *   metacharacter is caret-escaped — twice for a batch file, whose `%*` is parsed by cmd once more — and
 *   command[0] is caret-escaped. A caret inside `%VAR^%` breaks the variable name, so `%` stays literal.
 *   This is the scheme of the `cross-spawn` package, which npm itself relies on.
 *
 * Elsewhere the command is spawned directly, as before. Builtins only (it is copied by the H-5 deploy).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** An argument quoted for the MSVCRT / CommandLineToArgvW parser, then caret-escaped for cmd (twice for a batch file). */
export function escapeCmdArgument(arg, { batch = false } = {}) {
  let quoted = String(arg)
    // Backslashes before a quote are doubled, and the quote escaped.
    .replace(/(\\*)"/g, '$1$1\\"')
    // Backslashes before the closing quote are doubled.
    .replace(/(\\*)$/, "$1$1");
  quoted = `"${quoted}"`;
  quoted = quoted.replace(CMD_META, "^$1");
  if (batch) quoted = quoted.replace(CMD_META, "^$1");
  return quoted;
}

/** command[0] caret-escaped for cmd (it is not quoted, so a path with spaces keeps them escaped). */
export function escapeCmdCommand(command) {
  return String(command).replace(CMD_META, "^$1");
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Where cmd.exe would find `name`: the cwd, then each PATH entry; a name without one of PATHEXT's
 * extensions is tried with each in turn (so `npm` is `npm.cmd`, never the extensionless sh script beside
 * it). A name with a directory part is tried only there. `null` when nothing matches (maybe a builtin).
 */
export function resolveWindowsCommand(name, { env = process.env, cwd = process.cwd() } = {}) {
  const exts = String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((e) => e.toLowerCase());
  const hasExt = exts.includes(path.extname(name).toLowerCase());
  const candidates = (base) => (hasExt ? [base] : exts.map((e) => base + e));
  const dirs = /[\\/]/.test(name) || path.isAbsolute(name) ? [""] : [cwd, ...String(env.PATH ?? env.Path ?? "").split(";").filter(Boolean)];
  for (const dir of dirs) {
    for (const file of candidates(dir === "" ? path.resolve(cwd, name) : path.join(dir.replace(/^"|"$/g, ""), name))) {
      if (isFile(file)) return file;
    }
  }
  return null;
}

/**
 * How `command` (argv: [program, ...args]) is spawned on `platform`: `{ file, args, options, via }` where
 * `via` is `direct` (no shell) or `cmd` (cmd.exe, escaped). Exported for tests.
 */
export function planCommand(command, { env = process.env, cwd = process.cwd(), platform = process.platform } = {}) {
  const [program, ...rest] = command;
  if (platform !== "win32") return { file: program, args: rest, options: {}, via: "direct" };
  const resolved = resolveWindowsCommand(program, { env, cwd });
  if (resolved !== null && /\.(exe|com)$/i.test(resolved)) return { file: resolved, args: rest, options: {}, via: "direct" };
  const batch = resolved !== null && /\.(cmd|bat)$/i.test(resolved);
  const line = [escapeCmdCommand(resolved ?? program), ...rest.map((a) => escapeCmdArgument(a, { batch }))].join(" ");
  return {
    file: env.ComSpec || env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true },
    via: "cmd"
  };
}

/** spawnSync the wrapped command with inherited stdio; its arguments reach it literally. */
export function runCommand(command, { env = process.env, cwd = process.cwd() } = {}) {
  const plan = planCommand(command, { env, cwd });
  return spawnSync(plan.file, plan.args, { stdio: "inherit", env, cwd, ...plan.options });
}
