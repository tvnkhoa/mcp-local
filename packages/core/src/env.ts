/**
 * Environment reading.
 *
 * This module is the ONLY place in the platform permitted to touch
 * `process.env` (dependency rule 10) — apart from each server's `config.ts`,
 * which is expected to call `defaultEnvSource()` once at startup and pass the
 * snapshot down. Nothing here reads the environment at import time.
 */

import type { PlatformError } from "./errors.js";
import { configError } from "./errors.js";
import type { Result } from "./result.js";
import { err, ok } from "./result.js";

export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Snapshot `process.env`. Called explicitly — never at module load. */
export function defaultEnvSource(): EnvSource {
  return { ...process.env };
}

const TRUE_VALUES: ReadonlySet<string> = new Set(["1", "true", "yes", "on", "y"]);
const FALSE_VALUES: ReadonlySet<string> = new Set(["0", "false", "no", "off", "n", ""]);

export interface NumberOptions {
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
}

export interface EnvReader {
  /** Raw value with surrounding whitespace trimmed, or undefined when unset/empty. */
  raw(name: string): string | undefined;
  string(name: string, fallback: string): string;
  optionalString(name: string): string | undefined;
  requireString(name: string): Result<string, PlatformError>;
  number(name: string, fallback: number, options?: NumberOptions): number;
  boolean(name: string, fallback: boolean): boolean;
  /** Comma-separated list; empty entries dropped. */
  list(name: string, fallback?: readonly string[]): string[];
  /** Names of all set, non-empty variables matching an optional prefix. */
  presentKeys(prefix?: string): string[];
  /** True when at least one variable in the group has a value. */
  anyPresent(names: readonly string[]): boolean;
}

export function createEnvReader(source: EnvSource): EnvReader {
  const raw = (name: string): string | undefined => {
    const value = source[name];
    if (value === undefined) {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  };

  const clamp = (value: number, options: NumberOptions): number => {
    let next = value;
    if (options.integer === true) {
      next = Math.trunc(next);
    }
    if (options.min !== undefined && next < options.min) {
      next = options.min;
    }
    if (options.max !== undefined && next > options.max) {
      next = options.max;
    }
    return next;
  };

  return {
    raw,

    string(name, fallback) {
      return raw(name) ?? fallback;
    },

    optionalString(name) {
      return raw(name);
    },

    requireString(name) {
      const value = raw(name);
      if (value === undefined) {
        return err(
          configError(`Required environment variable ${name} is not set.`, { variable: name })
        );
      }
      return ok(value);
    },

    number(name, fallback, options = {}) {
      const value = raw(name);
      if (value === undefined) {
        return clamp(fallback, options);
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        return clamp(fallback, options);
      }
      return clamp(parsed, options);
    },

    boolean(name, fallback) {
      const value = raw(name)?.toLowerCase();
      if (value === undefined) {
        return fallback;
      }
      if (TRUE_VALUES.has(value)) {
        return true;
      }
      if (FALSE_VALUES.has(value)) {
        return false;
      }
      return fallback;
    },

    list(name, fallback = []) {
      const value = raw(name);
      if (value === undefined) {
        return [...fallback];
      }
      return value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
    },

    presentKeys(prefix) {
      const keys: string[] = [];
      for (const name of Object.keys(source)) {
        if (prefix !== undefined && !name.startsWith(prefix)) {
          continue;
        }
        if (raw(name) !== undefined) {
          keys.push(name);
        }
      }
      return keys.sort();
    },

    anyPresent(names) {
      return names.some((name) => raw(name) !== undefined);
    }
  };
}
