/**
 * The heavy lock's RAM budget (row H-6b, 2026-11-05; spec "H-6b FROZEN" with wec.be, owner-approved).
 * Pure rules, no lock state: what a run declares, whether it is exclusive or a harness suite, and
 * whether it fits beside the runs already holding the lock. `heavyLock.mjs` asks these questions under
 * its admission mutex; `heavyLockHistory.mjs` re-exports the history reader and class naming from here
 * (this module imports nothing of the lock's, so the deploy copy has no import cycle).
 *
 * P1 budget  = free RAM now + Σ holders' measured working set − 8192 MB, recomputed on every poll; a
 *            holder's working set counts at most its declared MB (a holder over its declaration has
 *            already taken that RAM out of "free"; adding it back would admit against RAM in use).
 *            Admit while Σ declared MB of the holders + own ≤ budget.
 * P2 declared MB = `--ram-mb` | class p95 × 1.5 after ≥ 3 measured runs (floor 512, 4000 for a dotnet
 *            class) | fallback 8000 dotnet, 1500 other. Dotnet = class `wecbe-build:` / `wecbe-test:`,
 *            or class / command containing `dotnet`.
 * P3 exclusive (waits for all, blocks all): `--cost large`, a .sln build, a Release publish, a Docker
 *            build, verify:all, a codebase-index run of wec.be.
 * P4 at most 2 harness suites at once (mcp-local run-tests / run-servers test / verify-*); per-repo cap 1
 *            for `wecbe-build:` / `wecbe-test:` whatever the budget.
 */

import fs from "node:fs";
import os from "node:os";
import process from "node:process";

export const RESERVE_MB = 8192;
/** A later waiter may pass the FIFO head only while the head has waited less than this (P1). */
export const BYPASS_MS = 10 * 60_000;
export const HARNESS_CAP = 2;
export const P95_FACTOR = 1.5;
export const MIN_MEASURED_RUNS = 3;
export const FLOOR_MB = Object.freeze({ dotnet: 4000, other: 512 });
export const FALLBACK_MB = Object.freeze({ dotnet: 8000, other: 1500 });

/**
 * The class a run is filed under when the caller names none: its repo and its command, each path-like
 * token cut to its basename (a scratch csproj path becomes `aliasprobe.csproj`), at most 160 chars.
 */
export function defaultClass(cmd, repo) {
  const words = String(cmd ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/^["']|["']$/g, ""))
    .map((w) => (/[\\/]/.test(w) ? (w.split(/[\\/]/).filter(Boolean).at(-1) ?? w) : w));
  return `${repo ?? "unknown"}/${words.join(" ")}`.slice(0, 160);
}

/** Every parseable row of the history at `file` (its rotated `.1.jsonl` first), oldest first. */
export function readHistoryRows(file) {
  const rows = [];
  for (const f of [file.replace(/\.jsonl$/, ".1.jsonl"), file]) {
    let text = "";
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const row = JSON.parse(line);
        if (row !== null && typeof row === "object") rows.push(row);
      } catch {
        // a torn line: skipped
      }
    }
  }
  return rows;
}

/** Nearest-rank percentile of sorted numbers, `null` for none. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const WECBE_CAPPED = /^wecbe-(build|test):/;

export function isDotnet(klass, cmd) {
  return WECBE_CAPPED.test(String(klass ?? "")) || /dotnet/i.test(String(klass ?? "")) || /dotnet/i.test(String(cmd ?? ""));
}

/** The per-repo cap key (P4): `wec.be` for its build/test classes, else `null` (no cap). */
export function capKey(klass) {
  return WECBE_CAPPED.test(String(klass ?? "")) ? "wec.be" : null;
}

/** Why a run is exclusive (P3), or `null`. */
export function exclusiveReason({ cost, klass, cmd }) {
  const text = `${String(klass ?? "")} ${String(cmd ?? "")}`;
  if (cost === "large") return "--cost large";
  if (/\.slnx?\b/i.test(String(cmd ?? ""))) return ".sln build";
  if (/\bpublish\b/i.test(text) && /(\s-c|--configuration)[\s=:]*release\b|configuration=release\b/i.test(text)) return "Release publish";
  if (/\bdocker(-compose)?(\.exe)?\b.*\b(build|buildx)\b/i.test(text)) return "Docker build";
  if (/\bverify:all\b/.test(text)) return "verify:all";
  if (/codebase-index/i.test(text) && /wec[.\-_]?be\b/i.test(text)) return "codebase-index run of wec.be";
  return null;
}

/** A harness suite (P4): mcp-local's run-tests, run-servers test, verify-* / verify:* (verify:all is exclusive). */
export function isHarness(klass, cmd) {
  const text = `${String(klass ?? "")} ${String(cmd ?? "")}`;
  return /\brun-tests(\.mjs)?\b/.test(text) || /\brun-servers(\.mjs)?\s+test\b/.test(text) || /\bverify[:-][\w:-]+/.test(text);
}

/**
 * The MB a run declares (P2): `{ mb, from, runs, p95 }`, `from` one of `--ram-mb`, `p95`, `fallback`.
 * `rows` are history rows; only this class's measured ones count.
 */
export function declaredMb({ ramMb = null, klass, cmd, rows = [] }) {
  const dotnet = isDotnet(klass, cmd);
  if (Number.isInteger(ramMb) && ramMb > 0) return { mb: ramMb, from: "--ram-mb", runs: null, p95: null };
  const peaks = rows
    .filter((r) => r.class === klass && Number.isFinite(r.peakMb))
    .map((r) => r.peakMb)
    .sort((a, b) => a - b);
  if (peaks.length >= MIN_MEASURED_RUNS) {
    const p95 = percentile(peaks, 95);
    return { mb: Math.max(dotnet ? FLOOR_MB.dotnet : FLOOR_MB.other, Math.ceil(p95 * P95_FACTOR)), from: "p95", runs: peaks.length, p95 };
  }
  return { mb: dotnet ? FALLBACK_MB.dotnet : FALLBACK_MB.other, from: "fallback", runs: peaks.length, p95: null };
}

/** Everything admission needs to know about one run. */
export function buildRequest({ cmd, klass, cost = null, ramMb = null, rows = [] }) {
  const declared = declaredMb({ ramMb, klass, cmd, rows });
  const exclusiveWhy = exclusiveReason({ cost, klass, cmd });
  return {
    class: klass,
    cost,
    declaredMb: declared.mb,
    declaredFrom: declared.from,
    exclusive: exclusiveWhy !== null,
    exclusiveWhy,
    harness: exclusiveWhy === null && isHarness(klass, cmd),
    capKey: capKey(klass)
  };
}

/**
 * Σ and budget for `holders` (`[{declaredMb, wsMb}]`): `{ sumMb, budgetMb }` (P1). A holder's measured
 * working set counts at most its declaration; unmeasured counts 0 (the conservative side).
 */
export function budgetOf(holders, { freeMb, reserveMb = RESERVE_MB }) {
  let sumMb = 0;
  let back = 0;
  for (const h of holders) {
    const declared = Number(h.declaredMb) || 0;
    sumMb += declared;
    back += Math.min(Math.max(0, Number(h.wsMb) || 0), declared);
  }
  return { sumMb, budgetMb: Math.floor(freeMb + back - reserveMb) };
}

/**
 * Does `request` fit beside `holders` now? `{ ok, reason, sumMb, budgetMb }`; `sumMb` includes the
 * request. `legacyOccupied`: the lock's single name is held by an exclusive holder or by a caller of an
 * older version (which knows no budget, so it counts as exclusive).
 */
export function admit(request, holders, { freeMb, legacyOccupied = false, reserveMb = RESERVE_MB }) {
  const { sumMb: held, budgetMb } = budgetOf(holders, { freeMb, reserveMb });
  const sumMb = held + request.declaredMb;
  const no = (reason) => ({ ok: false, reason, sumMb, budgetMb });
  if (legacyOccupied) return no("held by an exclusive run or a caller of an older version");
  const exclusive = holders.find((h) => h.exclusive);
  if (exclusive !== undefined) return no(`exclusive run pid ${String(exclusive.pid)} holds the lock`);
  if (request.exclusive) {
    if (holders.length > 0) return no(`exclusive (${String(request.exclusiveWhy)}): waits for ${String(holders.length)} holder${holders.length === 1 ? "" : "s"}`);
  } else {
    if (request.harness && holders.filter((h) => h.harness).length >= HARNESS_CAP) return no(`${String(HARNESS_CAP)} harness suites already run`);
    if (request.capKey !== null && holders.some((h) => h.capKey === request.capKey)) return no(`one ${request.capKey} build/test at a time`);
  }
  if (sumMb > budgetMb) return no(`Σ ${String(sumMb)} MB > budget ${String(budgetMb)} MB`);
  return { ok: true, reason: null, sumMb, budgetMb };
}

/** The latest sampled working set (MB) in a sampler summary file, `null` when none yet or unreadable. */
export function readCurrentMb(file) {
  if (typeof file !== "string" || file === "") return null;
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")).currentMb;
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** Free physical RAM in MB. `MCP_HEAVY_LOCK_TEST_FREE_MB` replaces the reading — tests only. */
export function readFreeMb(env = process.env) {
  const forced = Number(env.MCP_HEAVY_LOCK_TEST_FREE_MB);
  if (env.MCP_HEAVY_LOCK_TEST_FREE_MB !== undefined && env.MCP_HEAVY_LOCK_TEST_FREE_MB !== "" && Number.isFinite(forced)) return forced;
  return Math.floor(os.freemem() / 1048576);
}
