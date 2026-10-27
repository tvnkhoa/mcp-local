## MCP-ISSUE-101 — every query on a dirty tree re-ran the refresh

- **Status:** 🟡 PART 1 FIXED 2026-10-27 (wec.aria request, C2a); PART 2 FIXED 2026-10-27 (C2b, retargeted to the
  scoped mention resolve by measurement, owner-approved); PART 3 FIXED 2026-10-27 (C2c: a row shift re-points ids
  instead of re-extracting dependents); PART 4 FIXED 2026-10-27 (C2d: ties break on the path, so a shift cannot
  flip them across files; `INDEX_VERSION` v15). Open: a query during a full re-index reads a half-written index.
- **Scenario:** live on wec.aria (~3,000 files), every read query on a dirty tree started a dirty run (~7.4 s:
  extract 4.3 s, resolve 3.0 s) and answered from the old index; the next query did it again. The gate's covered
  key was HEAD + each dirty file's size and mtime, held in one process's memory, so:
  - a touch without a content change re-ran it;
  - every other server process (one per Claude session) on the same DB never saw it and ran its own.

  The watcher did a whole-repo `incremental` run per batch.
- **Fix (part 1):**
  - **Content key.** The key is HEAD + the sorted dirty paths + a sha256 of each dirty file's bytes (`deleted` when
    gone; a file above the index size cap is keyed by its size). Only dirty files are hashed; there is no mtime
    pre-check (removed on purpose for correctness, see `incremental-indexing`).
    Review follow-up: hashing runs at most 16 files at a time, and a hash is reused in-process while the file's
    (size, mtime, ctime) is unchanged. ctime moves on any write, even one that sets mtime back. Only ENOENT /
    ENOTDIR mean `deleted`; any other read error (EMFILE, EACCES) gives `unreadable`, which the key never vouches for.
  - **Persisted, shared.** `index_runs.tree_key` (runGraphMigrations) is set on a successful run's record by the
    gate (on the server thread, after the refresh worker's result), by `index_repository` and by the watcher.
    Every process reads the LATEST run's key: a later run that recorded none (failed, cancelled, an older build)
    vouches for nothing, so the next check runs.
  - **Narrow dirty run.** At the key's HEAD, a gate run re-indexes only the files the key does not vouch for:
    dirty files new or changed since, plus key files no longer dirty (reverted or deleted). Without a key at this
    HEAD, every dirty file, as before.
  - **Watcher.** A batch hands its changed and deleted paths, plus the dirty files the key does not vouch for, to
    a `dirty` run as `knownDirtyPaths`; the run removes deleted files itself, with their dependents in scope. A
    batch that dropped events at `maxQueuedEvents` says so (`overflowed`) and falls back to `incremental`,
    pruning first, as before.
    Review follow-up (`watcherRunPlan`): the batch runs `dirty` only at the HEAD the index holds. When HEAD moved
    since the latest run's commit, or the stored key is at another HEAD, it runs `incremental`. Example: a
    `git pull` with no watcher running, then one edit — the files the commit changed are in neither list, and the
    run would have recorded the new HEAD with a key that vouched for them. A dirty run handed its paths takes the
    ones it re-read out of the dirty ledger, so a reverted file the watcher re-indexed costs no extra gate run.
  - **Honest outcome.** A refresh run that ends `failed` or `cancelled` answers `state: "stale"` with that status
    in `reason`, and records no key.
- **Guarded:** `freshness.test.ts` (unchanged dirty tree → fresh, no run; touch → no run; same size and mtime,
  new content → one run; a second gate on the same key store → fresh, no run; narrowed dirty paths; cancelled →
  stale, no key; `unreadable` never vouched; `watcherRunPlan`; HEAD moved by a commit to X, then a batch naming
  only Y → incremental, and X's new symbol is indexed (real runner); ledger cleared for re-read paths), `watchManager.test.ts` (batch paths, no pre-prune; overflow fallback), `runStore.test.ts`
  (latest run's key only), `test:query-refresh` §7 (a second server process on the same dirty tree: fresh and
  `latestRun.runId` unchanged; touch → no run; content change → one dirty run, then fresh).
- **Part 2 — measured first.** Setup: a scratch clone of wec.aria at 6e011462 (2,994 files indexed) and a scratch
  DB. The edit inserts 3 blank lines above each file, the conformance procedure's row-shift edit, so every id in
  the file re-mints.

  | | 1 file (`usage-period.ts`) | 6 files |
  |---|---|---|
  | dirty run, before | 10.1 s (extract 6.1, resolve 3.3) | 26.1 s (extract 14.3, resolve 10.9) |
  | scoped mention resolve, before | 2,121 ms | 9,148 ms |
  | the 4 briefed passes (call ctx + calls + imports + types + properties) | 0.5 s | 1.0 s |
  | full run's whole resolve phase | 3.0 s | 3.8 s |

  The cost was not where the request assumed: the call-context / import / type / property passes cost ≤1 s. The
  scoped mention resolve cost more than a full run's whole resolve phase. Re-extracting the dependents (203 / 568
  files whose resolved edges point into re-minted ids) costs the rest.
- **Fix (part 2):** `resolveMentionsImpl` (`docsStore.ts`). The scoped select's docs subquery read
  `repo_id = doc_mentions.repo_id`, which made it CORRELATED: it re-ran once per unbound mention (17,690 on
  wec.aria). In isolation it took 4,189 ms; with `repo_id` bound as a parameter it takes 37 ms and returns the same
  8,764 rows. The per-row bind/clear UPDATEs needed no batching: the whole scoped resolve is now 733 ms (6 files).
- **After** (same edits, same machine; extract times vary ±30% with machine load):

  | | 1 file | 6 files |
  |---|---|---|
  | dirty run | 9.7 s (extract 7.4, resolve **1.7**) | 21.0 s (extract 17.4, resolve **2.8**) |
  | scoped mention resolve | — | **733 ms** (was 9,148) |

- **Conformance** (`incremental-indexing` procedure, stricter form): every row of `files`, `symbols`, `edges`,
  `doc_mentions`, `string_literals`, `code_comments` and `routes`, plus S1–S3, compared for dirty (B′) and
  incremental (B) against a full run (C) on the same edited tree. Both before and after the fix, for 1 file and
  6 files: equal, I1 = 0, I2 empty → **ready**.
- **Not done, on purpose:** scoping the four briefed passes (≤1 s of the run) — backlog, not worth the
  conformance risk today.
- **Part 3 — measured first** (same clone, 1-file shift of `usage-period.ts`, 204 files, extract 8.1 s). The
  main-thread profile: tree-sitter parse and walk of the 203 dependents ~4.5 s (files under 256 KiB parse inline,
  not in workers), write transactions 0.8 s, WAL pragma 0.6 s, per-file FTS 0.3 s. Nothing there to tune; the
  re-extraction itself had to go.
- **Fix (part 3):** `queueDependentFiles` (`indexPipeline.ts`) and `scopedRunStore.ts`. No id format or
  `INDEX_VERSION` change.
  - **Pairing** (`pairShiftedSymbols`): a written file's rows before and after pair by logical key (the parent
    chain plus kind, name and signature), in (line, id) order. These stay unpaired and keep their names in K, as
    before: a different count per key, two equal keys on one line, or a parent that does not map. A rename, a
    removal or a signature change is therefore unpaired.
  - **Re-point** (`remapSymbolIds`): each paired old id becomes the new one in every row outside the written files,
    through a temp map in one statement per column, so a swap (old A = new B) is applied once. The columns are
    `edges.to_id` / `from_id`, `symbols.parent_symbol_id`, `routes.controller_symbol_id` / `handler_symbol_id`,
    `string_literals.enclosing_symbol_id`, `cross_repo_deps` both sides (through a sentinel, it has a primary key),
    and `doc_mentions.candidate_ids`. Exempt, with the reason in `SYMBOL_ID_COLUMNS_EXEMPT`: `symbols.symbol_id`,
    `symbols_fts`, `vec_symbol_map`, and `doc_mentions.symbol_id` (unbound by `oldIds` and re-resolved).
  - **Guard (b), within the file:** resolvers take the first in (line, id) order among one name (EF members,
    overrides, the canonical candidate lists) and among a file's component / module symbols. When a shift changes
    that order, the pair's names go to K.
  - **Guard (a), across the repo:** `pickBestNamedCandidate` and the first-row lookups break ties on
    `symbol_id`, so a re-minted id that passes a same-family namesake's id changes a full run's answer.
    `idsAtRiskFromIdOrder` returns the shifted ids whose order flipped and the namesakes they flipped against. The
    files with resolved edges into those ids are re-extracted. Kind families: the type kinds (class, struct,
    record, interface, type) form one, and every other kind stands alone, because the pick ranks each allowed
    kind apart.
- **Review follow-up (part 3).**
  - Guard (a) skipped unmoved pairs. A moved id can pass the id of an unmoved namesake in the same file, e.g.
    `class B { get() }` pushed past `class A { get() }`, which turns an `o.get()` by-name tie into a different
    edge. Every pair now takes part, the unmoved ones as fixed participants.
  - The re-point ran in its own transaction after the batch commit. A crash or cancel in between left other
    files' edges into ids that were gone, behind a content hash that was already current. It now runs inside the
    write's transaction, file by file. (A later run that writes anything still sweeps dangling edges repo-wide
    through `findDanglingEdgeSourceFiles`.)
  - `interfaceSiblings.ts` orders by id across names under a cap (`IMPLEMENTOR_CAP`, `limit 10`), but only at
    query time. Its callers are the impact and context-pack tools, never the index run. It reads the stored
    graph, and conformance proves that graph equal to a full run's, so it answers the same. The index-time
    fan-out caps (`MAX_INTERFACE_DISPATCH_FANOUT`, `MAX_SUBCLASS_DISPATCH_FANOUT`) cut lists ordered by
    `file_path`, which a shift does not move.
  - **Not covered, pre-existing:** a run cancelled after its batch commit but before `queueDependentFiles`
    never re-extracts the K-name dependents (no dangling edge marks them). That was true before part 3 too.
- **After** (same clone and machine; before = 2f26f46 on the same edit):

  | edit | dependents before → after | dirty run before → after |
  |---|---|---|
  | 1 file, `core/ports/index.ts` (113 inbound files, no id ties) | 79 → **2** | 5.7 s → **1.4 s** |
  | 1 file, `usage-period.ts` | 203 → 147 | 9.7 s → 7.6 s |
  | 6 files | 568 → 212 | 21.0 s → 11.2 s |

  `usage-period.ts` stays over budget for a real reason. Its `get` function ties with `portal/src/lib/theme.ts`'s
  `get` in 199 "resolved callee by name (ambiguous)" calls from 147 files, and the shift moves its id past
  theme.ts's. A full run then picks the other `get` for all of them. With guard (a) disabled, the 1-file run
  differs from a full run by 196 CALLS edges. The id hash is observable through that tie-break.
- **Conformance** (every row of the seven tables, plus S1–S3, I1/I2), dirty and incremental against full, on the
  clone: a 1-file shift of each of the two files, a 6-file shift, a rename of the exported `Clock`, a removed
  `AriaIdPrefix` (rows after it shift), and a signature-only change of `local_date`. All **ready**. wec.aria has no
  overloads, so the swapped-overload cases are fixtures.
- **Guarded:** `scopedRunStore.test.ts`: every symbol-id column of the schema (from `pragma table_info`) is
  re-pointed or exempt with a reason; pairing (shift, rename / removal / signature, same-line duplicate key); guard
  (b) on swapped overloads; guard (a) by kind family; the swap re-point. `scopedRunConformance.test.ts`: a shift
  with 0 dependents (fails without the re-point); rename and removal re-extract; a signature change re-extracts;
  guard (a) id flip vs no flip (fails without the guard); swapped C# overloads; guard (b) alone, overloads that
  trade line order but keep id order (fails without the guard). The doc's ambiguous mention lists its candidates
  by line. Review follow-up: an unmoved same-file namesake (fails without the fixed participants); a 6-file
  shift fixture; a run cancelled right after the shifted file's write leaves no dangling edge (fails with the
  re-point outside the transaction). `cross_repo_deps` is now in the snapshot.
- **Part 4 (C2d, owner-approved 2026-10-27): the tie-break no longer moves with a line.** Equally scored
  same-named candidates break the tie on `(file_path, symbol_id)`, not on `symbol_id` alone:
  - `tieBreakBefore` in `pickBestNamedCandidate`;
  - the candidate map's `order by name, file_path, symbol_id` (`buildNamedCandidateMap`), which also orders the
    `.find()` picks over it;
  - the first-row lookups by name: `interfaceByName` (calls), base classes, interfaces and contracts
    (contracts), CSS definitions, interface siblings, the cross-repo type match and the endpoint providers.

  The same-parent and same-file lookups (`findMemberMethod`, EF members, overrides) and the SQL pick (ranked by
  path and line) are unchanged. Guard (a) now compares only same-file namesakes: across files the path decides,
  and a shift does not move it. `INDEX_VERSION` becomes `v15-tiebreak-path`.
  - **Output change** (scratch wec.aria clone, a full run at v14 vs at v15, same tree): 0 symbols differ. 2,418 of
    47,698 edges change target, and all of them are by-name picks:

    | type | reason | edges |
    |---|---|---|
    | CALLS | resolved callee by name (ambiguous) | 1,938 |
    | CALLS | resolved interface method (unproven receiver) | 61 |
    | TYPE_REF | resolved type by name | 361 |
    | PROPERTY_WRITE | resolved property by name | 35 |
    | PROPERTY_REF | resolved method group | 23 |

    The winner of a tie is now the path that sorts first, so `checks/…` often wins over `packages/…`. Examples:
    - `packages/review/src/cadence.ts:86` `start`: `packages/ingest/server/main.ts:666` → `checks/exec/entrypoint.mjs:166`
    - `packages/portal/src/lib/past-cache.ts:12` `compare`: `checks/docs/reachable.mjs:90` → `checks/board/weight.mjs:32`

    That is no more correct than before, only stable. The edges keep their 0.7 "ambiguous" confidence.
  - **After** (clone, base = a v15 full run):

    | edit | dependents part 3 → part 4 | dirty run |
    |---|---|---|
    | 1 file `usage-period.ts` | 147 → **0** | **0.73 s** |
    | 1 file `core/ports/index.ts` | 2 → 0 | 0.77 s |
    | 6 files | 212 → **0** | **1.6 s** |
    | rename / remove / signature | 7 / 1 / 2 | 1.5 / 1.0 / 0.9 s |

    Conformance is ready for all six, dirty and incremental against full, on every row.
  - **Guarded:** `scopedRunConformance.test.ts`. A shift past a namesake's id in another file re-extracts nothing
    and equals a full run; it FAILS with the id-only tie-break. A shift that flips the id order of two overloads in
    one file re-extracts the caller; it FAILS without guard (a). `scopedRunStore.test.ts`: guard (a) is same-file
    only.
- **Found while checking the re-index (not fixed, needs the owner):** what a query sees during a full re-index.
  A full run commits in batches (`indexPipeline.ts` write loop, `subtxSize`), and the re-extracted files'
  outbound edges are raw `callee:` / `type:` tokens until the resolve phase. A reader on another connection
  therefore sees a half-written index. The probe (30 callers of one function) counted resolved callers
  30 → 25 → … → 0 while the run was going, and 30 again at the end. The gate does not notice. It checks only HEAD
  and the dirty tree (`middleware/freshness.ts`, `ensureFresh`), never `INDEX_VERSION`. Only the gate's own
  refreshes take the lock (`freshness.ts:447`); an explicit `index_repository` takes none. Another process's
  query on a clean tree is therefore answered `fresh` from the partial index.
- **Part 5 (C2e, owner-approved 2026-10-27): no `fresh` while a run is in progress or the index predates this
  build.**
  - `serialize`, which wraps every run (gate refresh, `index_repository`, watcher), writes a marker
    `running-<repo>-<pid>-<n>.json` to the state dir and removes it when the run ends.
  - Every process's gate checks the markers before anything else. While one is live (pid alive and younger
    than `staleRunMs`, 6 h by default) it answers `refreshing` and says that the index is partly re-written.
    A dead pid's or an expired marker is removed and ignored.
  - The gate also downgrades `fresh` / `refreshed` to `refreshing` when the latest successful FULL run's
    `index_version` (`getLatestFullRunVersion`) differs from this build's. A scoped run records the new
    version but re-resolves only what it touched, so it does not count.
  - **Guarded:** `freshness.test.ts`.
    - A second process runs a real full index; the query between its first batch and its end answers
      `refreshing`, then `fresh`. It FAILS without the marker check.
    - A killed holder's marker is ignored and removed.
    - A marker past `staleRunMs` with a live pid is ignored.
    - A run in this process counts too.
    - Version mismatch: `refreshing` before a full run at this version, through a scoped refresh, and `fresh`
      after. It FAILS without the check.
    - The reader skips failed and scoped runs.
  - **Not covered:** a run in a process that does not go through `serialize` (scripts, or another tool driving
    `runIndexPipeline` directly) writes no marker.

