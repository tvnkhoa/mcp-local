/**
 * Structured logging.
 *
 * Hard platform rule: logs go to **stderr only**. stdout is the MCP transport —
 * a single stray write there corrupts the protocol stream. The default sink
 * resolves `process.stderr` lazily so this module has no import-time side
 * effects and stays trivially testable.
 */

import type { Redactor } from "./redaction.js";
import { createRedactor } from "./redaction.js";

export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Derive a logger that merges `fields` into every record. */
  child(fields: LogFields): Logger;
  readonly level: LogLevel;
}

export type LogSink = (line: string) => void;

export interface LoggerOptions {
  /** Logical source name, emitted as `name`. */
  readonly name: string;
  readonly level?: LogLevel;
  /** Where a formatted line goes. Defaults to stderr. */
  readonly sink?: LogSink;
  /** Redactor applied to every field bag. Defaults to the standard redactor. */
  readonly redactor?: Redactor;
  /** Injectable for deterministic tests. */
  readonly clock?: () => Date;
  readonly baseFields?: LogFields;
}

function defaultSink(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

export function parseLogLevel(value: unknown, fallback: LogLevel = "info"): LogLevel {
  return isLogLevel(value) ? value : fallback;
}

export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? "info";
  const sink = options.sink ?? defaultSink;
  const redactor = options.redactor ?? createRedactor();
  const clock = options.clock ?? (() => new Date());
  const baseFields = options.baseFields ?? {};
  const threshold = LEVEL_RANK[level];

  const emit = (recordLevel: Exclude<LogLevel, "silent">, message: string, fields?: LogFields): void => {
    if (LEVEL_RANK[recordLevel] < threshold) {
      return;
    }
    const merged: Record<string, unknown> = { ...baseFields, ...(fields ?? {}) };
    const record: Record<string, unknown> = {
      ts: clock().toISOString(),
      level: recordLevel,
      name: options.name,
      msg: message
    };
    if (Object.keys(merged).length > 0) {
      record["fields"] = redactor(merged);
    }
    try {
      sink(JSON.stringify(record));
    } catch {
      // Logging must never take the process down.
      sink(JSON.stringify({ ts: record["ts"], level: "error", name: options.name, msg: "log_serialization_failed" }));
    }
  };

  const logger: Logger = {
    level,
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) =>
      createLogger({
        name: options.name,
        level,
        sink,
        redactor,
        clock,
        baseFields: { ...baseFields, ...fields }
      })
  };

  return logger;
}

/** A logger that discards everything. Useful as a default parameter. */
export function createNullLogger(name = "null"): Logger {
  return createLogger({ name, level: "silent", sink: () => undefined });
}
