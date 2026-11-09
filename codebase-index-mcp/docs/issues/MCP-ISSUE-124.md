## MCP-ISSUE-124 — start-up under CPU load took 28 s: Node resolving 613 modules one by one

- **Status:** FIXED 2026-11-09 (row 7 phase 2): the server is served from an esbuild bundle, `dist/bundle/index.js`.
  Loaded after-runs pending a leader-scheduled slot.
- **Scenario:** follow-up #3 of MCP-ISSUE-123. A served or stdio server restarted while the machine is busy (other
  sessions' builds, test suites, indexers) takes tens of seconds to answer `tools/list`, and the session sees the
  server as down.
- **Tool/query attempted:** none, start-up itself. Measured spawn → `tools/list` answered over stdio with a scratch DB
  (`~/.claude/handover/briefs/2026-11-09-mcp-local-startup-load-measure.mjs`).
- **Expected vs actual:** expected a start-up of about a second, about the same under load. Actual: 2.4 s solo and 28 s
  (24.5–30.3 s) under 16 CPU burners plus 8 git loopers. A CPU profile shows about 66% of solo start-up in per-module
  filesystem resolution (`getPackageScopeConfig`, fs open, `getNearestParentPackageJSON`). The 613 modules break down
  as dist 176, zod 159, ajv 66, zod-to-json-schema 39 and postcss 29. Nothing synchronous of ours matters (DB open,
  config and tool build take under 0.5 s, even under load). The same cause shows in MCP-ISSUE-110's profile: module
  count × fs syscall cost.
- **Impact:** a restart or a `/mcp` reconnect during a busy period looks like an outage. On 9 Nov a 16-burner trial
  coincided with a wec.aria read stall.
- **Workaround used:** none.
- **Fix:**
  - `scripts/bundle.mjs` runs after `tsc` in `npm run build`. It bundles four entries flat into `dist/bundle/`: `index`,
    `refreshWorker`, `extractionWorker` and `fieldWorker`. Native addons and the lazily `createRequire`d packages
    (typescript, `@vue/*`, `@volar/*`) stay external. Each worker client spawns `new URL("./<worker>.js", import.meta.url)`,
    which resolves beside the entry it was bundled into, so the source line is unchanged.
  - Two sites that assumed the tsc layout now hold for both layouts: `health_check.server.buildAt`
    (`runningEntryPath`) and the package.json lookup behind the server version (`nearestPackageJson`).
  - The manifest's codebase-index entry is `dist/bundle/index.js`, and `serve-http.mjs`' deploy serves the manifest
    entry. The unbundled `dist/` stays, because the harnesses import it by path.
- **Before/after (solo, median of 3, probe preload on, `-bundle-raw/`):** unbundled 2614 ms (613 modules); bundled
  600 ms (57 modules). `tools/list` hash e309fd5f4fd1125e is identical (46 tools). Phase 1 prototype under load:
  28.2 s → 2.1 s.
- **Evidence:** `~/.claude/handover/briefs/2026-11-09-mcp-local-startup-load-evidence.md` (diagnosis);
  `~/.claude/handover/briefs/2026-11-09-mcp-local-bundle-evidence.md` (fix).
- **Enhancement proposal:** if the loaded after-runs still show seconds, lazy-import the indexing and extractor chain
  on the server thread (about 90 modules), which phase 1 measured at ~15% under load.
