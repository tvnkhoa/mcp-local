import { extname } from "node:path";

export type FilterDecision = {
  include: boolean;
  reason: string;
  language: string | null;
};

const EXCLUDED_PATH_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "out",
  "target",
  "bin",
  "obj",
  "artifacts",
  ".vscode",
  ".vs",
  ".idea",
  "__pycache__",
  "wwwroot",
  "public",
  "static",
  "assets",
  "logs"
]);

const EXCLUDED_EXTENSIONS = new Set([
  ".txt",
  ".pdf",
  ".doc",
  ".docx",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".svg",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp4",
  ".mp3",
  ".wav",
  ".zip",
  ".tar",
  ".gz",
  ".lock",
  ".log",
  ".env",
  ".env.local",
  ".env.production",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".prettierrc",
  ".eslintrc",
  ".babelrc"
]);

const EXCLUDED_FILENAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "LICENSE",
  "CHANGELOG",
  "README",
  "CONTRIBUTING",
  "CODE_OF_CONDUCT",
  ".DS_Store",
  "Thumbs.db",
  "global.json",
  "NuGet.config"
]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  // Documentation
  ".md": "markdown",
  ".mdx": "markdown",
  // JavaScript / TypeScript (codebase-index-mcp)
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  // .NET / C# (wec.communication-hub)
  ".cs": "csharp",
  ".csproj": "csproj",
  ".sln": "sln",
  ".slnx": "sln"
};

/** Returns true if the first 512 bytes contain a null byte — reliable binary file indicator. */
function isBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 512);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

export function shouldIndexFile(filePath: string, bytes: Uint8Array): FilterDecision {
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/");

  if (segments.some((seg) => EXCLUDED_PATH_SEGMENTS.has(seg))) {
    return { include: false, reason: "excluded_path", language: null };
  }

  const extension = extname(filePath).toLowerCase();
  const basename = segments[segments.length - 1] || "";
  const basenameNoExt = basename.slice(0, basename.length - extension.length);

  if (EXCLUDED_EXTENSIONS.has(extension)) {
    return { include: false, reason: "excluded_extension", language: null };
  }

  // Detect language early to make filename exclusion language-aware
  const knownLanguage = LANGUAGE_BY_EXTENSION[extension];

  // Only exclude README/CHANGELOG/etc for non-markdown files (allow markdown docs)
  if (
    knownLanguage !== "markdown" &&
    (EXCLUDED_FILENAMES.has(basename) || EXCLUDED_FILENAMES.has(basenameNoExt))
  ) {
    return { include: false, reason: "excluded_filename", language: null };
  }

  const MAX_FILE_SIZE = 500_000; // 500KB
  if (bytes.length > MAX_FILE_SIZE) {
    return { include: false, reason: "file_too_large", language: null };
  }

  if (isBinary(bytes)) {
    return { include: false, reason: "binary_file", language: null };
  }

  // Detect minified files (very long lines)
  if (bytes.length > 10_000) {
    const sample = bytes.slice(0, 10_000);
    const text = new TextDecoder().decode(sample);
    const lines = text.split("\n");
    const avgLineLength = text.length / lines.length;
    if (avgLineLength > 500) {
      return { include: false, reason: "likely_minified", language: null };
    }
  }

  if (knownLanguage) {
    return { include: true, reason: "extension_match", language: knownLanguage };
  }

  return { include: false, reason: "unknown_extension", language: null };
}
