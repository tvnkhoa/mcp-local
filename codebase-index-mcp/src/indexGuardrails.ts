import path from "node:path";

const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z-_]{35}/g,
  /-----BEGIN (?:RSA|EC|DSA|OPENSSH) PRIVATE KEY-----[\s\S]*?-----END (?:RSA|EC|DSA|OPENSSH) PRIVATE KEY-----/g,
  /(api[_-]?key|token|secret|password)\s*[:=]\s*[\"'][^\"']+[\"']/gi
];

export function parseAllowedRoots(raw: string | undefined): string[] {
  const input = raw?.trim();
  if (!input) {
    return [];
  }

  return input
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => normalizePath(x));
}

export function assertPathAllowed(repoPath: string, allowedRoots: string[]): void {
  const normalizedRepoPath = normalizePath(repoPath);

  if (allowedRoots.length === 0) {
    throw new Error("CODEBASE_INDEX_ALLOWED_ROOTS must be configured.");
  }

  const isAllowed = allowedRoots.some((root) => {
    const normalizedRoot = normalizePath(root);
    return normalizedRepoPath === normalizedRoot || normalizedRepoPath.startsWith(`${normalizedRoot}${path.sep}`);
  });

  if (!isAllowed) {
    throw new Error("repoPath is outside allowed roots.");
  }
}

export function redactSensitive(input: string): string {
  let value = input;
  for (const pattern of SECRET_PATTERNS) {
    value = value.replace(pattern, "[REDACTED]");
  }
  return value;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizePath(value: string): string {
  return path.resolve(value);
}
