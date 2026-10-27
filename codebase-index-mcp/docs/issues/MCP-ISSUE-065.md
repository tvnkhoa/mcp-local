## MCP-ISSUE-065 — every `.csproj` `ProjectReference` edge pointed at a symbol id that does not exist

- **Status:** ✅ FIXED 2026-10-01 (P1; measured live the same day).
- **Scenario:** full index of any C# repo, then follow a project's `DEPENDS_ON` edges to its sibling
  projects (`get_dependency_graph`, `detect_circular_dependencies`, `find_impact_files` on a `.csproj`).
- **Expected vs actual:** `dotnetProjectParser.ts` minted the two ends of a project edge with
  different formulas:
  - the project's module symbol: `stableId(repoId:<filePath>:module:<name>)`, where `filePath` is the
    pipeline's `path.relative` output (backslashes on Windows);
  - a `<ProjectReference>` target: `stableId(repoId:project:<raw Include value, lower-cased>)`. This
    was not resolved against the `.csproj` directory, so `..\Domain\Domain.csproj` could never equal
    anything.

  Every such edge therefore held a 24-hex `to_id` that matched no symbol. It was neither resolved nor
  a prefixed token. Dangling `DEPENDS_ON` edges after a full index, central DB:

  | Repo | Dangling `DEPENDS_ON` |
  |---|---|
  | wec.be | 271 |
  | api-testing-studio | 82 |
  | ssnet | 52 |
  | wec.communication-hub | 13 |
  | wec.social-ads | 11 |
  | wec.document-management | 8 |
  | wec.notification | 5 |

  On `wec.notification` the 5 are: 2 from `src\API\API.csproj`, 2 from
  `src\Infrastructure\Infrastructure.csproj` and 1 from `src\Application\Application.csproj`. API's
  stored module id `c39b0956…` reproduces only from the backslash path.
- **Two findings checked beside it:**
  - *"Two module symbols per csproj"* is **by design**. The second is the provider-side
    `nuget-export` bridge symbol (`signature = nuget:<package>`, ISSUE-CR-001), which
    `find_package_consumers` and the cross-repo resolver need. It is unchanged.
  - There was a **third** copy, and it was redundant. The `.sln` parser minted a sln-scoped `module`
    symbol per listed project, owned by the `.sln` file, and pointed its edges at those. The `.sln`
    edges resolved, but only to that copy, never to the project. The copies are removed.
  - Backslashes in `from_file`: stored `file_path` is the pipeline's `path.relative` output, so it is
    backslashed on Windows for every language, and responses normalize it. Changing that would re-mint
    every symbol id, so it is out of scope. The fix makes the project id independent of it instead.
- **Impact:**
  - The project-to-project layer of every C# graph was missing: no `.csproj` → `.csproj` traversal,
    and no project-level cycles in `detect_circular_dependencies`.
  - Because the ids looked resolved, the MCP-ISSUE-063 safety-net prune (`pruneDanglingResolvedEdges`)
    deleted them on every incremental run.
  - `findDanglingEdgeSourceFiles` also re-queued every `.csproj` on every incremental run that wrote
    something.
- **Fix** (`src/services/extractors/dotnetProjectParser.ts`):
  - `projectModuleSymbolId` is the only way to spell a project's module id. It is keyed on the
    canonical path: forward slashes, `.`/`..` folded, lower-cased. The `.csproj` lane mints its symbol
    with it, and every project edge mints its `to_id` with it.
  - `resolveProjectTarget` joins the reference onto the owner's directory (`.csproj` or `.sln`):
    - inside the repo → the target's module id, `confidence 1`, `reason 'project reference'`;
    - above the repo root, or absolute → `project:<path>`, `confidence 0.1`, `reason 'external boundary'`;
    - built from an MSBuild property (`$(SolutionDir)…`) → `project:<raw>`, `confidence 0.3`,
      `reason 'unresolved project reference token'`.

    It never returns a bare id for a reference it cannot place.
  - `project:` is data, like `nuget:`, so it is deliberately not in `UNRESOLVED_SYMBOL_TOKEN_PREFIXES`.
  - **`INDEX_VERSION` bumped** `v2-string-literals` → `v3-project-refs`. Extraction output changes for
    files that did not change, and the per-file content-hash skip would keep unchanged `.sln` files'
    proxy symbols. **Heal with a full re-index** (`mode: "full"`) of each C# repo.
- **Residual:** a reference to an in-repo path that is not indexed (a missing file, or an excluded
  folder) still gets the computed module id, and that id dangles. The MCP-ISSUE-063 prune removes it
  on the next incremental run. Telling this case apart at extract time would need the scan's file set
  passed to the parser.
- **Guarded:** `src/services/extractors/dotnetProjectParser.test.ts` (6 tests):
  - `/` and `\` fixtures: the API → Domain edge `to_id` equals Domain's module symbol id;
  - the id ignores separator and casing;
  - out-of-repo and MSBuild-property references are `project:` tokens;
  - the `.sln` mints no proxy symbols and its edges hit the real module ids;
  - an end-to-end full index of a two-project tree has **0 dangling ids** and the expected four
    project edges, and keeps them across an incremental run.

  All 6 fail against the pre-fix code. The end-to-end test showed 2 dangling ids before the fix.
- **Verified:**
  - `npm run typecheck` and `npm run test:unit` (198/198) pass;
  - `npm run build`, `npm run test:integration` (41/41) and `npm run guard:no-llm-runtime` pass.
  - The live repos were not re-indexed in this change. The "after" count on the central DB is
    pending a full run.

- **Verified live 2026-10-01** after a full re-index at `v3-project-refs`. Dangling `DEPENDS_ON` before → after:
  - wec.be 271 → 2
  - api-testing-studio 82 → 0
  - ssnet 52 → 0
  - wec.communication-hub 13 → 0
  - wec.document-management 8 → 0
  - wec.notification 5 → 0
  - wec.social-ads 11 → 0, measured after the MCP-ISSUE-066 fix (1 003 files indexed, up from 1).

  The 2 left in wec.be reference `src/packages/SS.Cache` and `src/packages/SS.Lib.FilterExpressions`, which do not exist in that repo. That is the documented in-repo-but-unindexed gap, not a minting defect. Any other dangling ids left in these repos are IMPORTS/TYPE_REF edges to symbols in other repos, and all of them match `cross_repo_deps`.

