import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  findStaleRunningServers,
  newestBuildTime,
  parsePosixProcesses,
  parseWindowsProcesses
} from "./runningServers.mjs";

/**
 * The check that catches a server process still running an older build than `dist/`.
 *
 * Driven with injected process lists rather than real ones — the platform query is the one part
 * that cannot be asserted portably, so it is the one part kept outside these tests. Everything
 * that decides *stale or not* is pure and is pinned here.
 */

function tempDist(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rs-"));
  for (const [rel, mtimeMs] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "//");
    fs.utimesSync(full, mtimeMs / 1000, mtimeMs / 1000);
  }
  return root;
}

test("newestBuildTime takes the newest .js anywhere under dist", () => {
  const older = Date.UTC(2026, 7, 3, 10, 0, 0);
  const newer = Date.UTC(2026, 7, 3, 12, 0, 0);
  // The nested file is the newer one: the incident that motivated this check was a *worker*
  // module moving, while the entry point was not the most recently written file.
  const dist = tempDist({ "index.js": older, "services/extractors/extractionWorker.js": newer });
  assert.equal(newestBuildTime(dist), newer);
  fs.rmSync(dist, { recursive: true });
});

test("newestBuildTime returns null when there is no build", () => {
  assert.equal(newestBuildTime(path.join(os.tmpdir(), "rs-does-not-exist-9f2a")), null);
});

test("a process started before the build is reported stale", () => {
  const builtAt = Date.UTC(2026, 7, 3, 12, 0, 0);
  const dist = tempDist({ "index.js": builtAt });
  const entry = path.join(dist, "index.js");

  const stale = findStaleRunningServers(entry, dist, [
    { pid: 111, commandLine: `node ${entry}`, startedAt: builtAt - 600_000 }
  ]);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].pid, 111);
  assert.equal(stale[0].behindMs, 600_000);

  const fresh = findStaleRunningServers(entry, dist, [
    { pid: 222, commandLine: `node ${entry}`, startedAt: builtAt + 1000 }
  ]);
  assert.deepEqual(fresh, []);

  fs.rmSync(dist, { recursive: true });
});

test("only processes running THIS entry point are considered", () => {
  const builtAt = Date.UTC(2026, 7, 3, 12, 0, 0);
  const dist = tempDist({ "index.js": builtAt });
  const entry = path.join(dist, "index.js");

  const stale = findStaleRunningServers(entry, dist, [
    { pid: 333, commandLine: "node /some/other-server/dist/index.js", startedAt: builtAt - 60_000 }
  ]);
  assert.deepEqual(stale, [], "a different server's process must not be attributed to this one");
  fs.rmSync(dist, { recursive: true });
});

test("entry matching is case- and separator-insensitive", () => {
  // Windows: drive-letter casing is not stable and the agent config may use either separator.
  const builtAt = Date.UTC(2026, 7, 3, 12, 0, 0);
  const dist = tempDist({ "index.js": builtAt });
  const entry = path.join(dist, "index.js");
  const shouted = entry.toUpperCase().replace(/\//g, "\\");

  const stale = findStaleRunningServers(entry, dist, [
    { pid: 444, commandLine: `node "${shouted}"`, startedAt: builtAt - 1000 }
  ]);
  assert.equal(stale.length, 1);
  fs.rmSync(dist, { recursive: true });
});

test("an unavailable process list is null, not empty", () => {
  const builtAt = Date.UTC(2026, 7, 3, 12, 0, 0);
  const dist = tempDist({ "index.js": builtAt });
  // "Could not check" must be distinguishable from "checked and clean" — reporting the former as
  // the latter is precisely the blind spot this module exists to close.
  assert.equal(findStaleRunningServers(path.join(dist, "index.js"), dist, null), null);
  fs.rmSync(dist, { recursive: true });
});

test("parseWindowsProcesses handles the single-match bare object", () => {
  // ConvertTo-Json emits an object, not a one-element array, when exactly one process matches.
  const one = parseWindowsProcesses(JSON.stringify({
    ProcessId: 900, CommandLine: "node x.js", CreationDate: "2026-08-03T12:00:00.0000000+07:00"
  }));
  assert.equal(one.length, 1);
  assert.equal(one[0].pid, 900);

  const many = parseWindowsProcesses(JSON.stringify([
    { ProcessId: 1, CommandLine: "node a.js", CreationDate: "2026-08-03T12:00:00Z" },
    { ProcessId: 2, CommandLine: "node b.js", CreationDate: "/Date(1754222400000)/" }
  ]));
  assert.equal(many.length, 2);
  assert.equal(many[1].startedAt, 1754222400000);
});

test("parseWindowsProcesses drops rows it cannot use rather than throwing", () => {
  assert.deepEqual(parseWindowsProcesses("not json"), []);
  assert.deepEqual(parseWindowsProcesses(JSON.stringify([{ ProcessId: 3, CommandLine: "" }])), []);
  assert.deepEqual(
    parseWindowsProcesses(JSON.stringify([{ ProcessId: 4, CommandLine: "node a.js", CreationDate: "nope" }])),
    []
  );
});

test("parsePosixProcesses reads pid, lstart and the command", () => {
  const rows = parsePosixProcesses(
    "  123 Sun Aug  3 12:14:35 2026 node /srv/dist/index.js --flag\n" +
    "  456 Mon Aug  4 01:02:03 2026 /usr/bin/node /other/index.js\n" +
    "garbage line\n"
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].pid, 123);
  assert.equal(rows[0].commandLine, "node /srv/dist/index.js --flag");
  assert.equal(rows[0].startedAt, Date.parse("Sun Aug  3 12:14:35 2026"));
});
