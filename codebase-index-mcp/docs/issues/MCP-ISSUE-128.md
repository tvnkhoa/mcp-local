## MCP-ISSUE-128 — Python lane gaps G1-G4 after the tree-sitter lane (Protocols, conftest fixtures, star imports, untyped receivers, qualified search)

- **Status:** FIXED, PARTIAL (row #3, 13 Nov 2026, branch `wt/py-gaps`: 448e663 PY-5, 89ff624 PY-7, a891148 PY-8,
  619f598 PY-6, a4b260e PY-9, then the review fixes). Leftovers 1-5 fixed by row #12 (branch `wt/py-rest`: 089a0e4
  PY-8b, e87d81e PY-5b, e19e88d PY-5c, da05138 PY-6b, 890936e review); 6-8 remain. Needs a FULL re-index of every
  Python repo after deploy (translate): Protocol classes change kind (and so symbol id), CALLS / IMPLEMENTS semantics
  changed, and row #12 adds module `__all__` signatures and CALLS hints; no `INDEX_VERSION` bump.
- **Scenario:** translate (pure Python) after the PY-1..PY-4 tree-sitter lane went live (12 Nov). Probes from the
  translate leader: `find_implementations` on the executor Protocol (core/ports.py) empty; `get_call_chain` of the
  pipeline run path never reached `FixStage.run`; a fixture-only test linked to nothing; `search_symbols("FixStage.run")`
  returned 0.
- **Tool/query:** `find_implementations`, `get_call_chain`, `link_tests_to_source`, `search_symbols` (strategy `name`).
- **Expected vs actual:**
  - G1 `class Executor(Protocol)` was a plain class; structural implementers (PEP 544) had no IMPLEMENTS edge.
  - G2 `self.factory(st)().run(ctx)` (factory `-> StageFactory`, `StageFactory = Callable[[], Stage]`) emitted the bare
    token `run`, bound by name to whichever `run` sorted first.
  - G3 a fixture parameter bound to whichever same-named fixture sorted first, not the nearest conftest.py; a test
    using only fixtures had no import/call evidence to its source.
  - G4 `from x import *` bound nothing x re-exports from its own imports; `Cls.m()` on a star-imported class lost `Cls`.
  - PY-9 a dotted `Owner.member` name query matched nothing.
- **Impact:** call chains and blast radius on translate stopped at Protocol-typed and factory-built receivers — the
  pipeline's whole stage dispatch; tests-for-change missed fixture-only tests.
- **Fix:** see the commits. Kind `interface` for Protocol subclasses; `rebuildPythonProtocolImplements` (explicit 0.95,
  structural 0.8, signature-checked); Python dispatch by implementer owner, cap 40; return-annotation / Callable-alias /
  default / same-file 1-hop receiver typing; untyped bare-name method hits flagged 0.6
  `resolved callee by name (untyped receiver)`; nearest-conftest fixture binding and a `fixture_trace` hop in
  `link_tests_to_source`; `x.*` star token with reason `resolved python star import` and the re-export hop;
  `Owner.member` matched on the parent link in both search paths.
- **Workaround used (baseline path):** none needed; no MCP fallback in this row.

### Leftovers (not done, by decision of scope)

Items 1-5 are FIXED by row #12 — see *Row #12* below; their original text is kept for the record.

1. **`__all__` does not filter star-imported names (G4).** `from x import *` puts all of x's own imports in the
   importer's scope, so a name x imports but does not export (not in `__all__`, or private) can still win the
   imported-file preference over a same-named definition elsewhere — an over-match. No translate file uses `import *`.
2. **1-hop is same-file only (G2).** An untyped parameter takes its callers' argument type only from callers in the
   same file; cross-file callers are not a hop yet (needs resolution-phase data, not extraction).
3. **One candidate, not a set (G2).** An untyped receiver keeps one name-picked candidate (flagged 0.6), not every
   same-named method.
4. **Inherited Protocol defaults are not dispatched.** The Python fan-out reaches an implementer's OWN method; a
   method the implementer inherits from an in-repo base is not a dispatch target.
5. **A Protocol is found by name repo-wide (`interfaceByName`).** Two Protocols of one name in different packages:
   a `Name.member` call binds to the first by path, not the one the caller imports (review finding, not fixed).
6. **Signature fit is by annotated class name.** A wider parameter type (`x: object` → wildcard, but `x: Base` for a
   Protocol's `x: Sub`) is a mismatch; TypeVars (`T`, `TKey`, `T_co`) and `List`/`list` are handled.
7. **A dotted name query answers on the parent link first.** A symbol literally named with dots (a C# namespace module
   `A.B.C`) is shadowed when some `C` has a parent named `B` (review, low).
8. **Explicit Protocol subclass keeps an external EXTENDS.** `class M(Executor)` with `Executor` a Protocol: the EXTENDS
   row is tagged external boundary (resolveExtendsEdges binds classes only); the IMPLEMENTS edge carries the relation.

### Row #12 (13 Nov 2026, branch `wt/py-rest`) — leftovers 1-5

- **PY-8b (leftover 1), 089a0e4.** The extractor records a literal `__all__` (assignment, `+=`, `.extend`,
  `.append`) on the module symbol's signature (`__all__:a,b`; `__all__:?` when not a literal list — no filter).
  `pythonImportedFilesForName` drops a file that is in scope ONLY through star imports for a name none of those
  star modules exports (`__all__`, else public names). Granularity stays per file: a module without `__all__`
  re-exports, for a public name, every file it imports.
- **PY-5b (leftover 4), e87d81e.** The Python dispatch fan-out takes the method an implementer RUNS: its own, else
  the first up its MRO (a base class's, or a sub-Protocol's default body). The MRO is C3 since 890936e
  (breadth-first fallback for an inconsistent hierarchy); `Owner.member` calls use the same walk.
- **PY-5c (leftover 5), e19e88d.** A Python caller's `Proto.member` picks the Protocol it can see (same file,
  imported file, tie-break) from every Python Protocol of that name, not `interfaceByName`'s first row by path.
- **PY-6b (leftovers 2 and 3), da05138 + 890936e.** Python CALLS edges carry hints in `assigned_expression`
  (`pyargs:` argument classes per call site, `pyrecv:` on a bare token whose receiver is an untyped parameter).
  `rebuildPythonUntypedReceiverEdges`, run from `rebuildInterfaceDispatchEdges` after the dispatch delete, types
  such a receiver from its callers in ANY file through up to 3 untyped hops and writes the SET of those classes'
  methods, reason `resolved callee by caller argument type (untyped receiver)`, 0.65 (extra rows marked `pyset`).
  With no typed caller the receiver keeps ONE flagged 0.6 name pick: a set of every same-named method was tried
  and dropped — on translate it gave a test-local fake `Ctx.segments` 7 callers it does not have, and
  `get_change_context` / `get_call_chain` list every CALLS row whatever its confidence. A caller in a test file
  never types a non-test function. A hinted untyped row duplicating its caller's other row is demoted the
  MCP-ISSUE-052 way. translate vs the main build: one call re-labelled caller-typed, nothing else moves.
- **Still open from the review:** a class-call `Foo.method(inst, arg)` shifts positional indexes by one;
  constructor arguments type nothing (the anchor sits in `__init__`, the call resolves to the class).

Why the set is caller-typed only (leader, 13 Nov: accuracy over recall): a candidate set must come from evidence
— the classes callers actually pass. A name set adds every same-named method as a caller of each, and nothing in
the traversal tools hides a low-confidence CALLS row by default, so it inflates every caller list it touches.

### Discoveries of row #12

- **FIXED (row #12, leader-approved scope):** `resolved callee by name (untyped receiver)` was not a name-only
  reason. Missing from `NAME_ONLY_EDGE_REASONS` (`src/types/index.ts`), a traversal standing on these 0.6 rows
  reported coverage `high` with no known gap. Added; test:python-gaps checks `trace_execution_flow` from such a
  caller reports coverage below `high` with the name-only gap, and that caller-typed rows are not counted.
- **OPEN — a same-file bare method token is bound at extraction.** `extractorEdges.ts` (shared by every language;
  not changed, by decision) binds `callee:m` to a same-file symbol `m` at 0.9, `resolved callee same-file`, before
  the call pass. An untyped `x.m()` beside a same-file method `m` is therefore never flagged as an untyped receiver,
  and PY-6b never sees it. Repro (python-gaps fixture shape): one file with `class GoA: def go(self, x): x.ping()`,
  `class Pinger: def ping(self): ...` and `def drive2(r): r.go(Pinger())` — both `x.ping()` and `r.go(...)` come
  out `resolved callee same-file` 0.9 instead of `resolved callee by name (untyped receiver)` 0.6. Enhancement:
  skip the extraction-time same-file bind for a Python bare token whose receiver is not `self`/`cls` (the
  extractor could mark it), so the call pass flags it.

### Review fixes (independent review of the five commits)

- `Protocol.member` was picked by FILE: `Executor.close` could bind to `Store.close` in the same file. Python now
  binds the member by owner (`parent_symbol_id`); C# keeps the file match.
- A Protocol (kind `interface`) had dropped out of the Python base chain, so `self.greet()` in `class Loud(Greeter)`
  lost the Protocol's default method. `buildPythonBases` now binds Protocol bases too.
- Signature fit: TypeVars bind anything, heads compare case-insensitively, string literals no longer break the
  bracket scan; `hopType` skips `self`/`cls` only when present (a @staticmethod) and reads `self.m(...)` sites of the
  method's own class only; the Protocol pass no longer copies a member list per class × Protocol pair.
- `link_tests_to_source`'s fixture hop no longer reads `symbols.kind` (a conftest path is the filter).

### Discovery outside Python (not fixed here)

- **C# interface dispatch picks the first same-named method in an implementer's FILE.** `rebuildInterfaceDispatchEdges`
  keys implementers by file and takes `candidateMap.get(name).find(c => c.filePath === file)`, so two implementers of
  one interface in one file both dispatch to the first one's method. The Python path now keys by owner; C# was left
  unchanged on purpose (scope). Enhancement: key by `parent_symbol_id`, with the file fallback for symbols without one.
