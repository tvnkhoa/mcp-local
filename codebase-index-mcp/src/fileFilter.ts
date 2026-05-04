import { extname } from "node:path";

export type FilterDecision = {
  include: boolean;
  reason: string;
  language: string | null;
  classifierLabel: string | null;
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
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".java": "java",
  ".cs": "csharp",
  ".rb": "ruby",
  ".rs": "rust",
  ".php": "php"
};

const LANGUAGE_BY_MAGIKA_LABEL: Record<string, string> = {
  javascript: "javascript",
  jsx: "javascript",
  typescript: "typescript",
  tsx: "typescript",
  python: "python",
  go: "go",
  java: "java",
  cs: "csharp",
  csharp: "csharp",
  ruby: "ruby",
  rust: "rust",
  php: "php",
  json: "json",
  markdown: "markdown",
  yaml: "yaml",
  toml: "toml"
};

type MagikaLike = {
  identifyBytes(bytes: Uint8Array): Promise<{ prediction: { output: { label: string; is_text: boolean } } }>;
};

let magikaInstancePromise: Promise<MagikaLike> | null = null;
const classificationCache = new Map<string, FilterDecision>();

export async function shouldIndexFile(filePath: string, bytes: Uint8Array): Promise<FilterDecision> {
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/");

  if (segments.some((segment) => EXCLUDED_PATH_SEGMENTS.has(segment))) {
    return { include: false, reason: "excluded_path", language: null, classifierLabel: null };
  }

  const extension = extname(filePath).toLowerCase();
  const basename = segments[segments.length - 1] || "";
  const basenameNoExt = basename.replace(extension, "");

  // Exclude by extension
  if (EXCLUDED_EXTENSIONS.has(extension)) {
    return { include: false, reason: "excluded_extension", language: null, classifierLabel: null };
  }

  // Exclude by filename
  if (EXCLUDED_FILENAMES.has(basename) || EXCLUDED_FILENAMES.has(basenameNoExt)) {
    return { include: false, reason: "excluded_filename", language: null, classifierLabel: null };
  }

  // Skip files too large (likely minified or generated)
  const MAX_FILE_SIZE = 500_000; // 500KB
  if (bytes.length > MAX_FILE_SIZE) {
    return { include: false, reason: "file_too_large", language: null, classifierLabel: null };
  }

  // Detect minified files (long lines without breaks)
  if (bytes.length > 10_000) {
    const sample = bytes.slice(0, 10_000);
    const text = new TextDecoder().decode(sample);
    const lines = text.split("\n");
    const avgLineLength = text.length / lines.length;
    if (avgLineLength > 500) {
      return { include: false, reason: "likely_minified", language: null, classifierLabel: null };
    }
  }
  
  // Fast path: check extension first
  const knownLanguage = LANGUAGE_BY_EXTENSION[extension];
  if (knownLanguage) {
    return { include: true, reason: "extension_match", language: knownLanguage, classifierLabel: null };
  }

  // TEMPORARY: Skip Magika for now, just reject unknown extensions
  return { include: false, reason: "unknown_extension", language: null, classifierLabel: null };

  /* MAGIKA DISABLED FOR TESTING
  // Cache check
  const cacheKey = `${extension}:${bytes.length}`;
  const cached = classificationCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const classifier = await getMagika();
    const result = await classifier.identifyBytes(bytes);
    const label = String(result.prediction.output.label);

    const isText = result.prediction.output.is_text;
    const fromClassifier = LANGUAGE_BY_MAGIKA_LABEL[label] ?? null;
    const fromExtension = LANGUAGE_BY_EXTENSION[extension] ?? null;
    const language = fromClassifier ?? fromExtension;

    if (!isText && !language) {
      const decision = { include: false, reason: "classifier_denied", language: null, classifierLabel: label };
      classificationCache.set(cacheKey, decision);
      return decision;
    }

    if (!language) {
      const decision = { include: false, reason: "unsupported_language", language: null, classifierLabel: label };
      classificationCache.set(cacheKey, decision);
      return decision;
    }

    const decision = { include: true, reason: "allowed", language, classifierLabel: label };
    classificationCache.set(cacheKey, decision);
    return decision;
  } catch {
    const fallbackLanguage = LANGUAGE_BY_EXTENSION[extension] ?? null;
    if (!fallbackLanguage) {
      return { include: false, reason: "classifier_error_unsupported_extension", language: null, classifierLabel: null };
    }

    return {
      include: true,
      reason: "classifier_error_extension_fallback",
      language: fallbackLanguage,
      classifierLabel: null
    };
  }
  */
}

async function getMagika(): Promise<MagikaLike> {
  if (!magikaInstancePromise) {
    magikaInstancePromise = (async () => {
      process.stdout.write("[Magika] Loading file classifier module...\n");
      const module = await import("magika");
      process.stdout.write("[Magika] Creating classifier instance (downloading model if needed)...\n");
      const instance = await module.Magika.create();
      process.stdout.write("[Magika] Classifier ready!\n");
      return instance;
    })();
  }

  return await magikaInstancePromise;
}
