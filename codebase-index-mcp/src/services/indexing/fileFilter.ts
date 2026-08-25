import { extname } from "node:path";

export type FilterDecision = {
  include: boolean;
  reason: string;
  language: string | null;
};

// Glob ignore set shared by the indexer (indexPipeline.ts) and the scanAll path of
// search_regex (regexSearch.ts) so both agree on what "the repo" excludes. Keep this the
// single source — do not re-declare the array elsewhere.
export const INDEX_IGNORE_GLOBS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.git/**",
  "**/coverage/**",
  "**/*.log",
  "**/*.lock",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml"
];

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
  // MCP-ISSUE-060 follow-up: added when `dot: true` was turned on for the file walk. Before that,
  // node-glob's default silently skipped every dot-directory and this list never had to name them.
  // Measured the moment it did: `wec.rag` went from 140 indexed files to 9159, of which 9156 were
  // `.venv/**` — 110,513 of its 111,454 symbols came from a Python virtualenv. A dependency tree is
  // not this repo's code, and `node_modules` was already excluded for exactly this reason.
  ".venv",
  "venv",
  "site-packages",
  ".tox",
  ".nox",
  ".eggs",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".ipynb_checkpoints",
  ".gradle",
  ".terraform",
  ".svn",
  ".hg",
  ".yarn",
  ".pnpm-store",
  ".parcel-cache",
  ".nx",
  ".angular",
  ".cache",
  ".nuget",
  ".conda",
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

/**
 * MCP-ISSUE-060 follow-up: files whose whole purpose is to hold a secret.
 *
 * Turning on `dot: true` made `.env` reachable by `search_regex(scanAll: true)`, which reads from
 * disk rather than from the index — so "it has no language mapping, the indexer skips it" was no
 * longer the whole answer. `wec.rag` has a real `.env` at its root. Nothing was ever written into
 * the graph (verified: zero rows across all nine repos, zero extracted literals), but a tool that
 * can grep a credentials file on request is a leak waiting for the right question.
 *
 * `.env.example` / `.sample` / `.template` are deliberately NOT excluded: they are documentation of
 * which variables exist, carry no values, and are what `generate:env` maintains.
 */
export function isSecretBearingFile(basename: string): boolean {
  const name = basename.toLowerCase();
  if (/\.(example|sample|template|dist)$/.test(name)) return false;
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (SECRET_FILENAMES.has(name)) return true;
  return /\.(pem|pfx|p12|jks|keystore|asc|ppk)$/.test(name) || /(^|\.)id_(rsa|dsa|ecdsa|ed25519)$/.test(name);
}

const SECRET_FILENAMES = new Set([
  ".npmrc",
  ".netrc",
  "_netrc",
  ".pypirc",
  ".dockercfg",
  ".git-credentials",
  "credentials",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
  "id_rsa",
  "id_ed25519"
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
  // `.tsx` keeps the `typescript` tag on purpose — the JSX dialect is chosen per file in
  // `getOrCreateParserForLanguage`, so the tag stays joinable in `files.language`.
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  // Python (FastAPI route extraction)
  ".py": "python",
  // .NET / C# (wec.communication-hub)
  ".cs": "csharp",
  ".csproj": "csproj",
  ".sln": "sln",
  ".slnx": "sln",
  // Protocol Buffers / gRPC
  ".proto": "proto"
};

// ISSUE-024: shared test-path classifier — dùng chung cho link_tests_to_source và
// search_symbols (rank penalty / excludeTests). Giữ một regex duy nhất để 2 nơi không drift.
const TEST_PATH_REGEX = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[^.]+$|(^|\/)test_[^/]+\.py$|_test\.py$|Tests\.cs$/i;

export function isTestPath(filePath: string): boolean {
  return TEST_PATH_REGEX.test(filePath.replace(/\\/g, "/"));
}

/**
 * MCP-ISSUE-049: EF Core migration files, the sibling of `isTestPath` for ranking purposes.
 *
 * A migration class name carries the vocabulary of every schema change ever made
 * (`AddSenderEmailToCrmRefs`, `AddOutboundConfirmTrackingConsolidated`), so an intent query like
 * "send outbound email via crm callback" matches migrations on more tokens than it matches the code
 * that actually does the work. Combined with `Up`/`Down` being the shortest method names in any EF
 * repo — and name length being the tie-break — migrations won the top of every business-phrase
 * search. They are a historical record, almost never the answer to "where does this happen".
 *
 * Kept as one regex here for the same reason `TEST_PATH_REGEX` is: so callers cannot drift.
 */
const MIGRATION_PATH_REGEX = /(^|\/)migrations?\//i;

export function isMigrationPath(filePath: string): boolean {
  return MIGRATION_PATH_REGEX.test(filePath.replace(/\\/g, "/"));
}

/**
 * The two method names EF generates for every migration. Checked together with the enclosing type
 * so a hand-written `Up()` outside a migration folder is not demoted — `isMigrationPath` alone is
 * enough for the folder case, and this covers a migration parked outside the conventional folder.
 */
const MIGRATION_MEMBER_NAMES = new Set(["up", "down"]);

export function isMigrationSymbol(filePath: string, name: string, parentName?: string | null): boolean {
  if (isMigrationPath(filePath)) return true;
  if (!MIGRATION_MEMBER_NAMES.has(name.toLowerCase())) return false;
  // A timestamped or `Migration`-suffixed enclosing type is the EF convention when the folder is not.
  return /^\d{8,}_|migration/i.test(parentName ?? "");
}

/** Returns true if the first 512 bytes contain a null byte — reliable binary file indicator. */
export function isBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 512);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/** Returns true if any path segment is an excluded build/tooling directory (bin, obj, .vs, …). */
export function hasExcludedPathSegment(filePath: string): boolean {
  return filePath.replace(/\\/g, "/").split("/").some((seg) => EXCLUDED_PATH_SEGMENTS.has(seg));
}

/** Returns true if the file looks minified (avg line length > 500 over the first 10KB). */
export function isLikelyMinified(bytes: Uint8Array): boolean {
  if (bytes.length <= 10_000) return false;
  const sample = bytes.slice(0, 10_000);
  const text = new TextDecoder().decode(sample);
  const lines = text.split("\n");
  return text.length / lines.length > 500;
}

export function shouldIndexFile(filePath: string, bytes: Uint8Array, maxFileSizeBytes = 500_000): FilterDecision {
  const normalized = filePath.replace(/\\/g, "/");
  const normalizedLower = normalized.toLowerCase();
  const segments = normalized.split("/");

  if (hasExcludedPathSegment(normalized)) {
    return { include: false, reason: "excluded_path", language: null };
  }

  // Skip EF Core migration Designer.cs snapshots — auto-generated, large, slow to parse
  if (normalizedLower.includes("/migrations/") && normalizedLower.endsWith(".designer.cs")) {
    return { include: false, reason: "excluded_generated", language: null };
  }

  // TypeScript declaration files carry no implementation: they are `function_signature` /
  // `property_signature` / `module` nodes, none of which the extractor walks, so a `.d.ts` used to
  // contribute a module symbol plus a few interfaces and nothing else — while its names competed
  // with real code in `search_symbols` ranking. `extname()` reports ".ts" for "x.d.ts", so this has
  // to be matched on the full name.
  if (/\.d\.(ts|mts|cts)$/.test(normalizedLower)) {
    return { include: false, reason: "declaration_file", language: null };
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

  if (isSecretBearingFile(basename)) {
    return { include: false, reason: "excluded_filename", language: null };
  }

  const MAX_FILE_SIZE = maxFileSizeBytes;
  if (bytes.length > MAX_FILE_SIZE) {
    return { include: false, reason: "file_too_large", language: null };
  }

  if (isBinary(bytes)) {
    return { include: false, reason: "binary_file", language: null };
  }

  // Detect minified files (very long lines)
  if (isLikelyMinified(bytes)) {
    return { include: false, reason: "likely_minified", language: null };
  }

  if (knownLanguage) {
    return { include: true, reason: "extension_match", language: knownLanguage };
  }

  return { include: false, reason: "unknown_extension", language: null };
}
