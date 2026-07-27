/**
 * Source scanning.
 *
 * Deliberately dependency-free: a regex import extractor over a directory walk.
 * A full parser would be more precise, but a guard's job is to make violations
 * visible, and a false positive here is a two-second read — whereas a new
 * runtime dependency in the tooling tier is permanent.
 */

import fs from "node:fs";
import path from "node:path";

import { toPosixPath } from "@mcp/core";

const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  ".git",
  "coverage",
  ".cache",
  "build"
]);

export interface SourceFile {
  /** Absolute path, POSIX separators. */
  readonly absolutePath: string;
  /** Path relative to the workspace root, POSIX separators. */
  readonly relativePath: string;
  readonly content: string;
  readonly lineCount: number;
  readonly isTest: boolean;
}

export function listSourceFiles(rootDir: string, workspaceRoot: string, extensions = [".ts", ".mts"]): SourceFile[] {
  const files: SourceFile[] = [];

  const walk = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) {
          walk(full);
        }
        continue;
      }
      if (!extensions.some((extension) => entry.name.endsWith(extension))) {
        continue;
      }
      if (entry.name.endsWith(".d.ts")) {
        continue;
      }

      let content: string;
      try {
        content = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }

      files.push({
        absolutePath: toPosixPath(full),
        relativePath: toPosixPath(path.relative(workspaceRoot, full)),
        content,
        lineCount: content.split(/\r?\n/).length,
        isTest: /\.test\.[cm]?ts$/.test(entry.name)
      });
    }
  };

  if (fs.existsSync(rootDir)) {
    walk(rootDir);
  }
  return files;
}

/**
 * Patterns that only apply on a line whose code begins with an import/export
 * keyword (or a `}` / `*` continuing a multi-line import clause). Gating on the
 * line start is what stops import-like text *inside a string literal* — very
 * common in this repo's own test fixtures — from being read as a real import.
 */
const STATEMENT_PATTERNS: readonly RegExp[] = [
  /\bfrom\s+["']([^"']+)["']/g,
  /^\s*import\s+["']([^"']+)["']/g
];

/** Patterns valid anywhere on a line, since these are expressions. */
const EXPRESSION_PATTERNS: readonly RegExp[] = [
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g
];

const STATEMENT_LINE_START = /^(import|export)\b|^[}*]/;

/** A real module specifier never contains whitespace or template syntax. */
const IMPLAUSIBLE_SPECIFIER = /[$\s{}`]/;

export interface ImportRef {
  readonly specifier: string;
  readonly line: number;
}

/** Blank out comments, preserving line numbering and character offsets. */
export function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_match, prefix: string) => prefix);
}

/**
 * Extract module specifiers.
 *
 * Regex-based by design (see the module note). The gating below keeps it honest
 * on this codebase: comments are stripped, quoted fixture lines are skipped,
 * and specifiers that cannot be module names are discarded.
 */
export function extractImports(content: string): ImportRef[] {
  const lines = stripComments(content).split(/\r?\n/);
  const refs: ImportRef[] = [];

  lines.forEach((lineText, index) => {
    const trimmed = lineText.trim();
    if (trimmed === "") {
      return;
    }
    // A line whose code starts with a quote is string data, not an import.
    const isQuotedData = trimmed.startsWith("'") || trimmed.startsWith('"') || trimmed.startsWith("`");
    if (isQuotedData) {
      return;
    }

    const applicable = STATEMENT_LINE_START.test(trimmed)
      ? [...STATEMENT_PATTERNS, ...EXPRESSION_PATTERNS]
      : EXPRESSION_PATTERNS;

    for (const pattern of applicable) {
      pattern.lastIndex = 0;
      let match = pattern.exec(lineText);
      while (match !== null) {
        const specifier = match[1];
        if (specifier !== undefined && specifier !== "" && !IMPLAUSIBLE_SPECIFIER.test(specifier)) {
          refs.push({ specifier, line: index + 1 });
        }
        match = pattern.exec(lineText);
      }
    }
  });

  return refs;
}

/** Reduce a specifier to its package name ("@scope/name" or "name"). */
export function packageNameOf(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) {
    return undefined;
  }
  const segments = specifier.split("/");
  if (specifier.startsWith("@")) {
    const scope = segments[0];
    const name = segments[1];
    return scope !== undefined && name !== undefined ? `${scope}/${name}` : undefined;
  }
  return segments[0];
}

/** True when the specifier reaches past a package's public entry point. */
export function isDeepImport(specifier: string): boolean {
  const name = packageNameOf(specifier);
  if (name === undefined || !name.startsWith("@mcp/")) {
    return false;
  }
  const remainder = specifier.slice(name.length);
  return remainder.startsWith("/src") || remainder.startsWith("/dist");
}

export interface WorkspacePackage {
  readonly name: string;
  readonly dir: string;
  readonly relativeDir: string;
  readonly manifest: Record<string, unknown>;
  readonly dependencies: ReadonlySet<string>;
}

export function readWorkspacePackages(workspaceRoot: string, parentDir = "packages"): WorkspacePackage[] {
  const base = path.join(workspaceRoot, parentDir);
  if (!fs.existsSync(base)) {
    return [];
  }

  const packages: WorkspacePackage[] = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = path.join(base, entry.name);
    const manifestPath = path.join(dir, "package.json");
    if (!fs.existsSync(manifestPath)) {
      continue;
    }
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const deps = {
      ...((manifest["dependencies"] as Record<string, string> | undefined) ?? {}),
      ...((manifest["devDependencies"] as Record<string, string> | undefined) ?? {}),
      ...((manifest["peerDependencies"] as Record<string, string> | undefined) ?? {})
    };
    packages.push({
      name: typeof manifest["name"] === "string" ? manifest["name"] : entry.name,
      dir: toPosixPath(dir),
      relativeDir: toPosixPath(path.relative(workspaceRoot, dir)),
      manifest,
      dependencies: new Set(Object.keys(deps))
    });
  }
  return packages;
}

/** Walk upward from `start` until a package.json declaring workspaces is found. */
export function findWorkspaceRoot(start: string = process.cwd()): string {
  let current = path.resolve(start);
  for (let depth = 0; depth < 10; depth += 1) {
    const manifestPath = path.join(current, "package.json");
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
        if (Array.isArray(manifest["workspaces"])) {
          return current;
        }
      } catch {
        // keep walking
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return path.resolve(start);
}
