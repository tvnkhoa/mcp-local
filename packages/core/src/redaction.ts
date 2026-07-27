/**
 * Secret redaction.
 *
 * Every value that could reach a log line or a config echo passes through here.
 * The platform rule is absolute: no secret, token, password, or connection
 * string is ever emitted in full.
 */

const DEFAULT_SECRET_KEY_PATTERN =
  /(pass|pwd|secret|token|key|auth|credential|connection|conn_?str|dsn|cookie|session|signature|bearer|private)/i;

/** Values that look like a secret regardless of the key they are stored under. */
const VALUE_SHAPED_LIKE_SECRET = /^(Bearer\s+\S+|Basic\s+\S+|ey[A-Za-z0-9_-]{10,}\.|ATATT[A-Za-z0-9_-]{10,})/;

/**
 * Credentials embedded in a URI: `scheme://user:password@host`.
 *
 * Matched anywhere in a string, not just at the start, because these arrive
 * inside free-text messages as often as under a `url` key — e.g.
 * "failed to connect using postgresql://u:p4ssw0rd@host/db".
 */
const URI_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;

/**
 * Replace the password component of any embedded URI credential.
 *
 * The scheme, user, and host survive: masking the whole URL would destroy the
 * diagnostic value of a connection error, and the password is the only part
 * that is actually a secret.
 */
export function maskUriCredentials(value: string): string {
  return value.replace(URI_CREDENTIALS, (_match, scheme: string, user: string) => `${scheme}${user}:***@`);
}

export interface MaskOptions {
  /** Characters kept at the start. Default 2. */
  readonly keepStart?: number;
  /** Characters kept at the end. Default 2. */
  readonly keepEnd?: number;
  /** Replacement run. Default "***". */
  readonly mask?: string;
}

/**
 * Mask a single secret value. Short values are fully masked — revealing 2 of 4
 * characters is not a meaningful trade.
 */
export function maskSecret(value: string | undefined | null, options: MaskOptions = {}): string {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  const keepStart = options.keepStart ?? 2;
  const keepEnd = options.keepEnd ?? 2;
  const mask = options.mask ?? "***";
  if (value.length <= keepStart + keepEnd + 2) {
    return mask;
  }
  return `${value.slice(0, keepStart)}${mask}${value.slice(value.length - keepEnd)}`;
}

export interface RedactOptions {
  /** Keys matching this pattern have their values masked. */
  readonly secretKeyPattern?: RegExp;
  /** Maximum depth to walk before replacing with "[depth-limit]". Default 8. */
  readonly maxDepth?: number;
  /** Maximum string length retained before truncation. Default 512. */
  readonly maxStringLength?: number;
  readonly mask?: MaskOptions;
}

interface ResolvedRedactOptions {
  readonly secretKeyPattern: RegExp;
  readonly maxDepth: number;
  readonly maxStringLength: number;
  readonly mask: MaskOptions;
}

function resolve(options: RedactOptions): ResolvedRedactOptions {
  return {
    secretKeyPattern: options.secretKeyPattern ?? DEFAULT_SECRET_KEY_PATTERN,
    maxDepth: options.maxDepth ?? 8,
    maxStringLength: options.maxStringLength ?? 512,
    mask: options.mask ?? {}
  };
}

export function isSecretKey(key: string, pattern: RegExp = DEFAULT_SECRET_KEY_PATTERN): boolean {
  return pattern.test(key);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[+${value.length - max}]`;
}

function redactNode(
  value: unknown,
  key: string | undefined,
  depth: number,
  seen: WeakSet<object>,
  opts: ResolvedRedactOptions
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    if (key !== undefined && isSecretKey(key, opts.secretKeyPattern)) {
      return maskSecret(value, opts.mask);
    }
    if (VALUE_SHAPED_LIKE_SECRET.test(value)) {
      return maskSecret(value, opts.mask);
    }
    // Applies to every string, under any key: an embedded URI password is a
    // secret wherever it appears.
    return truncate(maskUriCredentials(value), opts.maxStringLength);
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value;
  }

  if (typeof value === "function" || typeof value === "symbol") {
    return `[${typeof value}]`;
  }

  if (value instanceof Error) {
    return { name: value.name, message: truncate(value.message, opts.maxStringLength) };
  }

  if (depth >= opts.maxDepth) {
    return "[depth-limit]";
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[circular]";
    }
    seen.add(value);

    try {
      if (Array.isArray(value)) {
        return value.map((entry) => redactNode(entry, key, depth + 1, seen, opts));
      }

      const output: Record<string, unknown> = {};
      for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
        output[entryKey] = redactNode(entryValue, entryKey, depth + 1, seen, opts);
      }
      return output;
    } finally {
      // See the matching note in json.ts: `seen` must track ancestors, not
      // every object encountered, or a log record mentioning the same object
      // twice loses its second occurrence during an incident.
      seen.delete(value);
    }
  }

  return String(value);
}

/** Deep-redact an arbitrary value. Cycle-safe and depth-bounded. */
export function redactValue(value: unknown, options: RedactOptions = {}): unknown {
  return redactNode(value, undefined, 0, new WeakSet<object>(), resolve(options));
}

/** Deep-redact a record. Convenience wrapper around {@link redactValue}. */
export function redactObject(
  input: Readonly<Record<string, unknown>>,
  options: RedactOptions = {}
): Record<string, unknown> {
  const redacted = redactValue(input, options);
  return typeof redacted === "object" && redacted !== null && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : {};
}

export type Redactor = (value: unknown) => unknown;

export function createRedactor(options: RedactOptions = {}): Redactor {
  const resolved = resolve(options);
  return (value: unknown) => redactNode(value, undefined, 0, new WeakSet<object>(), resolved);
}
