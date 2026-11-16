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
 *            Admit while Σ declared MB of the holders + own ≤ budget. Amendment (owner, 5 Nov): the FIFO
 *            head with no other holder is admitted when free ≥ its declared MB + 2048, reserve or not.
 * P2 declared MB = `--ram-mb` | class p95 × 1.5 after ≥ 3 measured runs (floor 512, 2000 for a dotnet
 *            class) | fallback 8000 dotnet, 1500 other. Dotnet = class `wecbe-build:` / `wecbe-test:`,
 *            or class / command containing `dotnet`.
 *            Containers (row P2, 16 Nov): a CONTAINER class — one with an unshared measured run whose WSL2 VM
 *            grew ≥ CONTAINER_CLASS_MIN_MB (`containerMb`, heavyLockHistory.mjs) — takes its p95 over its
 *            unshared runs only (`p95-solo`) once it has ≥ 3: a run that overlapped another holder records
 *            its tree peak alone (owner, 10 Nov), and those rows would pull the p95 down. With < 3 unshared
 *            runs, `--container-mb N` (a declaration, like --ram-mb) adds N to the tree p95 × 1.5 (≥ 3
 *            measured runs, `tree-p95+container-mb`) or to the fallback (`fallback+container-mb`); without
 *            it the rule is as before. A class that never grew the VM keeps exactly its old value.
 * P3 exclusive (waits for all, blocks all): `--cost large`, a .sln build, a Release publish, a Docker
 *            build, verify:all, a codebase-index run of wec.be.
 * P4 at most 2 harness suites at once (mcp-local run-tests / run-servers test / verify-*); per-repo cap 1
 *            for `wecbe-build:` / `wecbe-test:`, and for a dotnet run whose repo is wec.be (review M3),
 *            whatever the budget.
 */

import fs from "node:fs";
import os from "node:os";
import process from "node:process";

export const RESERVE_MB = 8192;
/** P1 amendment (owner, 5 Nov): the FIFO head alone, with no other holder, needs only its declared MB + this free. */
export const LONE_HEAD_MARGIN_MB = 2048;
/** A later waiter may pass the FIFO head only while the head has waited less than this (P1). */
export const BYPASS_MS = 10 * 60_000;
export const HARNESS_CAP = 2;
export const P95_FACTOR = 1.5;
export const MIN_MEASURED_RUNS = 3;
export const FLOOR_MB = Object.freeze({ dotnet: 2000, other: 512 });
export const FALLBACK_MB = Object.freeze({ dotnet: 8000, other: 1500 });
/** VM growth (MB) in one unshared run that makes its class a container class; below it is noise (≤ 11 MB seen for runs without containers). */
export const CONTAINER_CLASS_MIN_MB = 128;

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

/**
 * The per-repo cap key (P4): `wec.be` for its build/test classes, and for any run in the wec.be repo whose
 * class or command names dotnet (dotnet-build-safe.ps1 without the prefix); else `null` (no cap).
 */
export function capKey(klass, { repo = null, cmd = "" } = {}) {
  if (WECBE_CAPPED.test(String(klass ?? ""))) return "wec.be";
  if (/^wec[._-]?be$/i.test(String(repo ?? "")) && (/dotnet/i.test(String(klass ?? "")) || /dotnet/i.test(String(cmd ?? "")))) return "wec.be";
  return null;
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

/** A run that held the lock alone at every sample (its VM growth is in its `peakMb`). Rows before row 10 count as unshared. */
export const isUnshared = (row) => row.containerShared !== true;

/** Measured rows that make a class a container class (P2): unshared, VM growth ≥ CONTAINER_CLASS_MIN_MB. */
export function isContainerClass(measuredRows) {
  return measuredRows.some((r) => isUnshared(r) && Number(r.containerMb) >= CONTAINER_CLASS_MIN_MB);
}

/**
 * The MB a run declares (P2): `{ mb, from, runs, p95 }`, `from` one of `--ram-mb`, `p95`, `p95-solo`,
 * `tree-p95+container-mb`, `fallback`, `fallback+container-mb`. `rows` are history rows; only this
 * class's measured ones count. `containerMb` is the caller's `--container-mb` (used only while the class
 * has < 3 unshared measured runs).
 */
export function declaredMb({ ramMb = null, containerMb = null, klass, cmd, rows = [] }) {
  const dotnet = isDotnet(klass, cmd);
  const floor = dotnet ? FLOOR_MB.dotnet : FLOOR_MB.other;
  if (Number.isInteger(ramMb) && ramMb > 0) return { mb: ramMb, from: "--ram-mb", runs: null, p95: null };
  const mine = rows.filter((r) => r.class === klass && Number.isFinite(r.peakMb));
  const unshared = mine.filter(isUnshared);
  const sorted = (values) => values.sort((a, b) => a - b);
  if (unshared.length >= MIN_MEASURED_RUNS && isContainerClass(mine)) {
    const p95 = percentile(sorted(unshared.map((r) => r.peakMb)), 95);
    return { mb: Math.max(floor, Math.ceil(p95 * P95_FACTOR)), from: "p95-solo", runs: unshared.length, p95 };
  }
  const declaredContainer = Number.isInteger(containerMb) && containerMb > 0 && unshared.length < MIN_MEASURED_RUNS;
  if (mine.length >= MIN_MEASURED_RUNS) {
    if (declaredContainer) {
      // The tree alone: a solo run's peakMb may already hold VM growth, and N is the declared container share.
      const p95 = percentile(sorted(mine.map((r) => (Number.isFinite(r.treePeakMb) ? r.treePeakMb : r.peakMb))), 95);
      return { mb: Math.max(floor, Math.ceil(p95 * P95_FACTOR) + containerMb), from: "tree-p95+container-mb", runs: mine.length, p95 };
    }
    const p95 = percentile(sorted(mine.map((r) => r.peakMb)), 95);
    return { mb: Math.max(floor, Math.ceil(p95 * P95_FACTOR)), from: "p95", runs: mine.length, p95 };
  }
  const fallback = dotnet ? FALLBACK_MB.dotnet : FALLBACK_MB.other;
  if (declaredContainer) return { mb: fallback + containerMb, from: "fallback+container-mb", runs: mine.length, p95: null };
  return { mb: fallback, from: "fallback", runs: mine.length, p95: null };
}

/** Everything admission needs to know about one run. */
export function buildRequest({ cmd, klass, cost = null, ramMb = null, containerMb = null, rows = [], repo = null }) {
  const declared = declaredMb({ ramMb, containerMb, klass, cmd, rows });
  const exclusiveWhy = exclusiveReason({ cost, klass, cmd });
  return {
    class: klass,
    cost,
    declaredMb: declared.mb,
    declaredFrom: declared.from,
    exclusive: exclusiveWhy !== null,
    exclusiveWhy,
    harness: exclusiveWhy === null && isHarness(klass, cmd),
    capKey: capKey(klass, { repo, cmd })
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
 * older version (which knows no budget, so it counts as exclusive). `head`: the request is the FIFO head —
 * alone (no holder at all) it is admitted when free RAM ≥ its declared MB + 2048, even below the 8192
 * reserve (P1 amendment, owner 5 Nov); beside any holder the reserve applies as before.
 */
export function admit(request, holders, { freeMb, legacyOccupied = false, reserveMb = RESERVE_MB, head = false }) {
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
  if (head && holders.length === 0) {
    const need = request.declaredMb + LONE_HEAD_MARGIN_MB;
    if (freeMb >= need) return { ok: true, reason: null, sumMb, budgetMb, lone: true };
    return no(`alone: needs ${String(need)} MB (${String(request.declaredMb)} declared + ${String(LONE_HEAD_MARGIN_MB)}), free ${String(freeMb)} MB`);
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
