import { extname } from "node:path";

export type FilterDecision = {
  include: boolean;
  reason: string;
  language: string | null;
};

// Glob ignore set shared by the indexer (indexPipeline.ts) and the scanAll path of
// search_regex (regexSearch.ts) so both agree on what "the repo" excludes. Keep this the
// single source — do not re-declare the array elsewhere.
/**
 * Directory names that hold a dependency tree or a tool cache — never this repository's own code.
 *
 * MCP-ISSUE-060 follow-up. These feed BOTH the glob ignore list and the path-segment filter, and
 * that is the point: the first attempt at this fix added the dot-spelled entries to the segment
 * filter only. The filter runs AFTER the glob and after `maxFiles` truncates it, so `.venv` was
 * still walked, still sorted ahead of the real files, and still consumed the entire 20 000-file
 * budget — the re-index reported `filesIndexed: 3, filesSkipped: 19997`, and because a truncated
 * scan correctly refuses to prune, the 9 156 stale rows from the previous run survived. Excluding a
 * tree has to happen where the walk happens.
 */
const VENDOR_DIR_SEGMENTS = [
  "node_modules",
  "dist",
  "build",
  "coverage",
  "out",
  "target",
  "bin",
  "obj",
  "artifacts",
  "__pycache__",
  // Dot-spelled equivalents. Invisible to node-glob's default until `dot: true` was turned on so
  // that `.claude/` and `.github/` could be searched at all, at which point a 62 311-file Python
  // virtualenv walked straight in.
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
  ".yarn",
  ".pnpm-store",
  ".parcel-cache",
  ".nx",
  ".angular",
  ".cache",
  ".nuget",
  ".conda",
  ".next",
  ".turbo",
  // IDE state (MCP-ISSUE-066). Same failure as `.venv` above, found again: `.vs`/`.idea` sat in
  // the segment filter only, and Visual Studio's `.vs/CopilotSnapshots` (25 194 files in
  // wec.social-ads) sorts ahead of `src/`, so a full run reported `filesIndexed: 1,
  // filesSkipped: 19999`. `.vscode` stays segment-only: it is small and `search_regex` may want it.
  ".vs",
  ".idea"
];

export const INDEX_IGNORE_GLOBS = [
  ...VENDOR_DIR_SEGMENTS.map((dir) => `**/${dir}/**`),
  "**/.git/**",
  "**/.svn/**",
  "**/.hg/**",
  "**/*.log",
  "**/*.lock",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml"
];

const EXCLUDED_PATH_SEGMENTS = new Set([
  ...VENDOR_DIR_SEGMENTS,
  ".git",
  ".svn",
  ".hg",
  ".vscode",
  "wwwroot",
  "public",
  "static",
  "assets",
  "logs"
]);

/**
 * MCP-ISSUE-078: build-output directory names that are ALSO ordinary source-folder names. `bin/` is
 * where a Node package keeps its CLI entry (wec.aria `packages/dep-lint/bin/depcruise-guarded.mjs`), and
 * `build/` / `out/` / `target/` hold scripts as often as output. In a git repo the ignore rules are
 * the authority (MCP-ISSUE-070): a file under one of these that git tracks, or would track, is the
 * repo's own, and is excluded only when its language is not source. .NET `bin/`/`obj/` are ignored by
 * every .NET ignore template, so a C# repo loses nothing. Outside git (or with
 * `CODEBASE_INDEX_RESPECT_GITIGNORE=false`) the segment rule stands as before. They stay in the glob
 * ignore list either way: the git-cleared files are added from git's own list (`fileScan.ts`), so a
 * 30 000-file `obj/` tree is still never walked.
 */
const GIT_DEFERRED_BUILD_SEGMENTS = new Set(["bin", "obj", "build", "out", "target"]);

/**
 * MCP-ISSUE-077: asset directories an `.svg` asset node may live in. Every other file type under them
 * stays excluded (`assets/` is where bundled vendor CSS/JS and generated sprites accumulate); an svg
 * becomes a module-only node that imports and template `src` attributes resolve to.
 */
const SVG_ASSET_SEGMENTS = new Set(["assets", "public", "static"]);

/** Languages that are code: a git-cleared file under a build-named segment is indexed only in one of these. */
const SOURCE_LANGUAGES = new Set(["typescript", "javascript", "vue", "python", "csharp", "proto", "css", "html", "sql"]);

export type PathExclusionOptions = {
  /**
   * The scan proved the file visible to git (tracked, or untracked and not ignored). Lets a
   * build-named segment (`bin`, `obj`, …) defer to git — see GIT_DEFERRED_BUILD_SEGMENTS.
   */
  gitCleared?: boolean;
};

/**
 * True when the only excluded directory segments of `filePath` are build-named ones a git-aware scan
 * may clear (`bin/`, `obj/`, …) — the candidates `fileScan.ts` adds back from git's file list.
 */
export function hasOnlyGitDeferredSegments(filePath: string): boolean {
  const dirs = filePath.replace(/\\/g, "/").split("/").slice(0, -1);
  const excluded = dirs.filter((seg) => EXCLUDED_PATH_SEGMENTS.has(seg));
  return excluded.length > 0 && excluded.every((seg) => GIT_DEFERRED_BUILD_SEGMENTS.has(seg));
}

/**
 * The path-segment rule the INDEXER applies. `hasExcludedPathSegment` is the strict form, still used
 * by `search_regex(scanAll)`. Two exceptions to "any excluded segment excludes":
 *  - an `.svg` under `assets/`, `public/` or `static/` (an asset node, MCP-ISSUE-077);
 *  - a source file under a build-named directory that git cleared (MCP-ISSUE-078).
 */
export function isExcludedByPath(filePath: string, options: PathExclusionOptions = {}): boolean {
  const segments = filePath.replace(/\\/g, "/").split("/");
  const basename = segments[segments.length - 1] ?? "";
  // A FILE named like an excluded directory (`logs`, `build`) keeps the old rule.
  if (EXCLUDED_PATH_SEGMENTS.has(basename)) return true;
  const isSvg = /\.svg$/i.test(basename);
  const language = languageForPath(basename);
  const sourceClearedByGit = options.gitCleared === true && language !== null && SOURCE_LANGUAGES.has(language);
  for (const seg of segments.slice(0, -1)) {
    if (!EXCLUDED_PATH_SEGMENTS.has(seg)) continue;
    if (isSvg && SVG_ASSET_SEGMENTS.has(seg)) continue;
    if (sourceClearedByGit && GIT_DEFERRED_BUILD_SEGMENTS.has(seg)) continue;
    return true;
  }
  return false;
}

/**
 * Binary assets: never text, never a graph node. Reported as `binary_asset` (MCP-ISSUE-077), so the
 * skip report says WHY a `.png` is absent. `.svg` is not here — it is text, and an asset node
 * (language `svg`).
 */
const BINARY_ASSET_EXTENSIONS = new Set([
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".jpg", ".jpeg", ".png", ".gif", ".ico", ".webp", ".avif", ".bmp", ".tif", ".tiff",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg",
  ".zip", ".tar", ".gz", ".tgz", ".7z",
  ".bin", ".exe", ".dll", ".so", ".dylib", ".wasm"
]);

/** True for a binary asset by extension (`.png`, `.pdf`, `.woff2`, …) — reported as `binary_asset`. */
export function isBinaryAssetPath(filePath: string): boolean {
  return BINARY_ASSET_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/**
 * Text that is never worth a node. Dotfile names (`.env`, `.gitignore`) used to be listed here too,
 * but `extname(".env")` is "" and `extname(".env.local")` is ".local", so those entries never matched:
 * the secret check (`isSecretBearingFile`) is what keeps credentials out, and the dotfile configs are
 * plain text now (TEXT_FILENAMES).
 */
const EXCLUDED_EXTENSIONS = new Set([".lock", ".log"]);

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
  // A saved login session (wec.aria `*.session`, a browser storage state) is a bearer credential.
  if (name.endsWith(".session")) return true;
  return /\.(pem|pfx|p12|jks|keystore|asc|ppk|key|p8)$/.test(name) || /(^|\.)id_(rsa|dsa|ecdsa|ed25519)$/.test(name);
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
  // Vue single-file components (MCP-ISSUE-074). Their own tag, not `typescript`: a `.vue` file is
  // template + script + style, `files.language` is what search_regex / dead_code_scan filter on, and a
  // caller asking for "the Vue components" must be able to say so. The script blocks still go through
  // the TypeScript lane (vueExtractor.ts).
  ".vue": "vue",
  // Python (FastAPI route extraction)
  ".py": "python",
  // .NET / C# (wec.communication-hub)
  ".cs": "csharp",
  ".csproj": "csproj",
  ".sln": "sln",
  ".slnx": "sln",
  // Protocol Buffers / gRPC
  ".proto": "proto",
  // Stylesheets (MCP-ISSUE-075) — postcss lane, not tree-sitter. SCSS/Less are a different grammar.
  ".css": "css",
  // PostgreSQL (MCP-ISSUE-082) — sqlExtractor.ts: pgsql-ast-parser plus token readers, not tree-sitter.
  ".sql": "sql",
  // JSON (MCP-ISSUE-076): package.json and tsconfig*.json get edges (jsonExtractor.ts); every other
  // .json is text level — a module symbol, and its string values in the literal lane.
  ".json": "json",
  // Plain text (MCP-ISSUE-076, plainTextExtractor.ts): in the index, so search_regex finds it without
  // scanAll and search_literals finds its strings. A module symbol and no other symbol.
  ".jsonl": "text",
  ".ndjson": "text",
  ".yaml": "text",
  ".yml": "text",
  ".toml": "text",
  ".sh": "text",
  ".bash": "text",
  ".envsh": "text",
  ".conf": "text",
  ".template": "text",
  ".txt": "text",
  ".example": "text",
  ".sample": "text",
  ".code-workspace": "text",
  ".dockerfile": "text",
  ".mk": "text",
  // HTML (MCP-ISSUE-077): <script src> / <link href> / <img src> become IMPORTS edges.
  ".html": "html",
  ".htm": "html",
  // SVG asset nodes (MCP-ISSUE-077): a module symbol that imports and template src attributes resolve to.
  ".svg": "svg"
};

/**
 * Files whose NAME is the type: no extension, or a dotfile, which `extname` reports as "". Plain text.
 * `.npmrc` is deliberately absent: it carries registry auth tokens and is secret-bearing.
 */
const TEXT_FILENAMES = new Set([
  "dockerfile",
  "containerfile",
  "makefile",
  "gnumakefile",
  "jenkinsfile",
  "procfile",
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".gitmodules",
  ".dockerignore",
  ".npmignore",
  ".prettierignore",
  ".eslintignore",
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  ".prettierrc",
  ".eslintrc",
  ".babelrc",
  ".browserslistrc",
  ".stylelintrc"
]);

/** The language a path would be indexed as, from its extension or its whole name; null when unmapped. */
export function languageForPath(filePath: string): string | null {
  const basename = (filePath.replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase();
  const byExtension = LANGUAGE_BY_EXTENSION[extname(basename)];
  if (byExtension) return byExtension;
  if (TEXT_FILENAMES.has(basename)) return "text";
  // `Dockerfile.dev`, `Makefile.local`: the name, then a variant suffix.
  if (/^(dockerfile|containerfile|makefile)\./.test(basename)) return "text";
  return null;
}

/** Text formats whose one-line form is normal, so the minified heuristic does not apply. */
const MINIFIED_EXEMPT_EXTENSIONS = new Set([".json", ".jsonl", ".ndjson", ".svg"]);

/** True for a path the `likely_minified` rule does not apply to (one-line JSON, JSONL, SVG). Shared with search_regex. */
export function isMinifiedCheckExempt(filePath: string): boolean {
  return MINIFIED_EXEMPT_EXTENSIONS.has(extname(filePath).toLowerCase());
}

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

/**
 * Markdown gets its own size cap. The docs lane splits a document by section, so a large one costs
 * nothing per query; rejecting it whole is what hurt. On wec.aria, `docs/15-decision-log.md` (1.41 MB,
 * the most-linked document in the repo and the target of ~380 greps) was over the shared 500 KB cap
 * and absent from every docs mode. Env: `CODEBASE_INDEX_MAX_MARKDOWN_BYTES`.
 */
export const DEFAULT_MAX_MARKDOWN_BYTES = 4_000_000;

/**
 * Build output that is text but never source: source maps and TypeScript's incremental build info.
 * Reported as `excluded_generated` rather than `unknown_extension`, so the skip report names them.
 */
const GENERATED_EXTENSIONS = new Set([".map", ".tsbuildinfo"]);

export function shouldIndexFile(
  filePath: string,
  bytes: Uint8Array,
  maxFileSizeBytes = 500_000,
  maxMarkdownBytes = DEFAULT_MAX_MARKDOWN_BYTES,
  pathOptions: PathExclusionOptions = {}
): FilterDecision {
  const normalized = filePath.replace(/\\/g, "/");
  const normalizedLower = normalized.toLowerCase();
  const segments = normalized.split("/");

  // A binary asset is named as one wherever it sits (`assets/photo.png` too): the reason a .png is not
  // in the graph is that it is binary, not which folder it is in (MCP-ISSUE-077).
  if (isBinaryAssetPath(normalized)) {
    return { include: false, reason: "binary_asset", language: null };
  }

  if (isExcludedByPath(normalized, pathOptions)) {
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

  if (GENERATED_EXTENSIONS.has(extension)) {
    return { include: false, reason: "excluded_generated", language: null };
  }

  // Detect language early to make filename exclusion language-aware
  const knownLanguage = languageForPath(normalized);

  // Only exclude README/CHANGELOG/etc for non-markdown files (allow markdown docs)
  if (
    knownLanguage !== "markdown" &&
    (EXCLUDED_FILENAMES.has(basename) || EXCLUDED_FILENAMES.has(basenameNoExt))
  ) {
    return { include: false, reason: "excluded_filename", language: null };
  }

  // Its own reason (MCP-ISSUE-076), so the skip report names what was refused as a credential.
  if (isSecretBearingFile(basename)) {
    return { include: false, reason: "secret_file", language: null };
  }

  const MAX_FILE_SIZE = knownLanguage === "markdown" ? maxMarkdownBytes : maxFileSizeBytes;
  if (bytes.length > MAX_FILE_SIZE) {
    return { include: false, reason: "file_too_large", language: null };
  }

  if (isBinary(bytes)) {
    return { include: false, reason: "binary_file", language: null };
  }

  // Detect minified files (very long lines)
  if (!MINIFIED_EXEMPT_EXTENSIONS.has(extension) && isLikelyMinified(bytes)) {
    return { include: false, reason: "likely_minified", language: null };
  }

  if (knownLanguage) {
    return { include: true, reason: "extension_match", language: knownLanguage };
  }

  return { include: false, reason: "unknown_extension", language: null };
}
