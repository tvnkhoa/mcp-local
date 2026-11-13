## MCP-ISSUE-128 — Python lane gaps G1-G4 after the tree-sitter lane (Protocols, conftest fixtures, star imports, untyped receivers, qualified search)

- **Status:** FIXED, PARTIAL (row #3, 13 Nov 2026, branch `wt/py-gaps`: 448e663 PY-5, 89ff624 PY-7, a891148 PY-8,
  619f598 PY-6, a4b260e PY-9, then the review fixes). Leftovers below. Needs a FULL re-index of every Python repo after deploy (translate):
  Protocol classes change kind (and so symbol id), and CALLS / IMPLEMENTS semantics changed; no `INDEX_VERSION` bump.
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
