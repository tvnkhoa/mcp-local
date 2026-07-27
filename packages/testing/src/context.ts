/**
 * Test doubles for the ambient dependencies a tool receives.
 *
 * Deterministic by construction: fixed clock, fixed request id, in-memory log
 * sink. A tool test should never depend on wall-clock time or on stderr.
 */

import type { LogFields, Logger, ResponseProfile } from "@mcp/core";
import { createLogger } from "@mcp/core";
import type { ToolContext } from "@mcp/sdk";

export interface LogRecord {
  readonly level: string;
  readonly name: string;
  readonly msg: string;
  readonly fields?: Record<string, unknown>;
}

export interface MemoryLogger {
  readonly logger: Logger;
  /** Every record emitted so far, in order. */
  readonly records: readonly LogRecord[];
  /** Records at one level. */
  at(level: string): readonly LogRecord[];
  /** True when any record's message equals `msg`. */
  saw(msg: string): boolean;
  clear(): void;
}

/** A logger that captures structured records instead of writing anywhere. */
export function createMemoryLogger(name = "test", level: "debug" | "info" | "warn" | "error" = "debug"): MemoryLogger {
  const records: LogRecord[] = [];

  const logger = createLogger({
    name,
    level,
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
    sink: (line) => {
      try {
        records.push(JSON.parse(line) as LogRecord);
      } catch {
        records.push({ level: "error", name, msg: "unparseable_log_line" });
      }
    }
  });

  return {
    logger,
    get records() {
      return records;
    },
    at: (wanted) => records.filter((record) => record.level === wanted),
    saw: (msg) => records.some((record) => record.msg === msg),
    clear: () => {
      records.length = 0;
    }
  };
}

export interface TestContextOptions {
  readonly profile?: ResponseProfile;
  readonly requestId?: string;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
  readonly baseFields?: LogFields;
}

/** Build a ToolContext suitable for calling a handler directly. */
export function createTestToolContext(options: TestContextOptions = {}): ToolContext {
  const logger = options.logger ?? createMemoryLogger().logger;
  return {
    logger: options.baseFields === undefined ? logger : logger.child(options.baseFields),
    profile: options.profile ?? "compact",
    requestId: options.requestId ?? "req-test",
    ...(options.signal === undefined ? {} : { signal: options.signal })
  };
}
