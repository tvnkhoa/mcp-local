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
  ".vscode",
  ".idea",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "vendor",
  "public",
  "static",
  "assets"
]);

const EXCLUDED_EXTENSIONS = new Set([
  ".md",
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
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "composer.lock",
  "LICENSE",
  "CHANGELOG",
  "README",
  "CONTRIBUTING",
  "CODE_OF_CONDUCT",
  ".DS_Store",
  "Thumbs.db"
]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  // Web / scripting
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".java": "java",
  ".rb": "ruby",
  ".rs": "rust",
  ".php": "php",
  // .NET / C#
  ".cs": "csharp",
  ".razor": "razor",
  ".cshtml": "razor",
  ".csproj": "csproj",
  ".sln": "sln",
  ".props": "xml",
  ".targets": "xml",
  // Config / data
  ".xml": "xml",
  ".config": "xml",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".sql": "sql"
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

  if (EXCLUDED_FILENAMES.has(basename) || EXCLUDED_FILENAMES.has(basenameNoExt)) {
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

  const knownLanguage = LANGUAGE_BY_EXTENSION[extension];
  if (knownLanguage) {
    return { include: true, reason: "extension_match", language: knownLanguage };
  }

  return { include: false, reason: "unknown_extension", language: null };
}
