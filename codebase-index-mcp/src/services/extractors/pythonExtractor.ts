/**
 * Python lane, on tree-sitter-python (PY-1, PY-3).
 *
 * It replaced a 90-line regex extractor that emitted no CALLS and no EXTENDS, listed methods as
 * owner-less functions, lost relative-import dots, aliases and every name after the first in
 * `import a, b`, and could match `def` inside a docstring. On translate (pure Python) that left
 * 0 call edges and 18 import edges, most of them accidental directory hits.
 *
 * What it emits, all through `makeSymbolId` so an edge's `fromId` is the id the symbol was stored under:
 *   - `class` (with `parentSymbolId` for a nested class; a `Protocol` subclass is kind `interface`, PY-5), `method` for a def directly in a class body
 *     — decorated or not (`@staticmethod`, `@classmethod`, `@property`, pydantic validators) — with
 *     `parentSymbolId` = its class, and `function` for every other def. The row is the `def` / `class`
 *     line, not the decorator's.
 *   - `EXTENDS` → `base:<Name>` per positional base (`class A(BaseModel)`, `class P(Protocol)`,
 *     `class B(pkg.Base)` → `Base`, `Generic[T]` → `Generic`); `metaclass=` is not a base.
 *   - `IMPORTS` → `import:<spec>` per imported name. `<spec>` keeps the relative level as leading dots:
 *     `import a.b` → `a.b`; `from x import y, z` → `x.y`, `x.z`; `from . import u` → `.u`;
 *     `from ..c.r import R` → `..c.r.R`; `from x import *` → `x.*` (PY-8). A from-import token names the module
 *     plus the imported name; `moduleResolution` binds it to the submodule when there is one, else to
 *     the module. Imports under `if TYPE_CHECKING:` and inside functions are imports too.
 *   - `CALLS` → `callee:<name>` or `callee:<Owner>.<member>` (see `callToken`), and best-effort
 *     references: a function name passed as a value (registry dict/list, `partial(f)`, `register(f)`)
 *     is a CALLS edge to it, because that is how it gets invoked.
 *   - FastAPI routes from `@router.get("/x")` / `@app.post(...)`.
 */

import type Parser from "tree-sitter";

import type { EdgeRecord, RouteRecord, SymbolRecord } from "../../types/index.js";
import type { ExtractInput } from "./extractorTypes.js";

import { extractFirstStringLiteral, isSameNode, makeSymbolId } from "./extractorUtils.js";
import {
  PYTHON_ARGS_HINT,
  PYTHON_OBJECT_RECEIVER_MARK,
  PYTHON_BUILTIN_FUNCTIONS,
  PYTHON_BUILTIN_METHODS,
  PYTHON_DUNDER_ALL_PREFIX,
  PYTHON_RECEIVER_HINT,
  PYTHON_STDLIB_MODULES
} from "./pythonNoise.js";

type ImportedName = { original: string; fromModule: string };

/** What one file's imports bind, for reading its calls. */
type ImportScope = {
  /** Local names bound by `from m import n [as a]` → the original name and its module spec. */
  names: Map<string, ImportedName>;
  /** Receiver texts that name a module: `import a.b` → `a`, `a.b`; `import x as z` → `z`. */
  modules: Map<string, string>;
  /** PY-8: repo-candidate modules this file star-imports (`from x import *`, stdlib excluded). */
  starModules: string[];
};

const ROUTE_METHODS = new Set(["get", "post", "put", "delete", "patch"]);
const ROUTE_RECEIVER = /(^app$|router$|^api$)/i;
const MAX_SIGNATURE = 300;
const UNTYPED_NAMES = new Set(["None", "Any", "object"]);

export function extractPythonImpl(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  symbols: SymbolRecord[],
  edges: EdgeRecord[],
  routes: RouteRecord[],
  moduleSymbolId: string
): void {
  const scope = extractImports(input, root, edges, moduleSymbolId);
  // PY-8b: the module's `__all__` rides on its module symbol's signature, for the star-import filter.
  const exported = readDunderAll(root);
  if (exported !== undefined) {
    const moduleSymbol = symbols.find((sym) => sym.symbolId === moduleSymbolId);
    if (moduleSymbol) moduleSymbol.signature = `${PYTHON_DUNDER_ALL_PREFIX}${exported ?? "?"}`;
  }
  const moduleFunctions = new Set<string>();
  const localClasses = new Set<string>();
  collectDefinitions(input, root, symbols, edges, routes, moduleSymbolId, null, false, moduleFunctions, localClasses);
  // Only ids actually stored may be an edge's `fromId`: a def under an ERROR node or in a nameless class is
  // never registered, so its calls are attributed to the nearest registered owner instead.
  const registered = new Set(symbols.map((s) => s.symbolId));
  extractCalls(input, root, edges, moduleSymbolId, scope, moduleFunctions, localClasses, registered);
}

// ── Symbols, EXTENDS, routes ────────────────────────────────────────────────────────────────

function collectDefinitions(
  input: ExtractInput,
  node: Parser.SyntaxNode,
  symbols: SymbolRecord[],
  edges: EdgeRecord[],
  routes: RouteRecord[],
  moduleSymbolId: string,
  ownerClassId: string | null,
  inFunction: boolean,
  moduleFunctions: Set<string>,
  localClasses: Set<string>
): void {
  for (const child of node.namedChildren) {
    const def = child.type === "decorated_definition" ? child.childForFieldName("definition") : child;
    if (!def) continue;

    if (def.type === "class_definition") {
      const name = def.childForFieldName("name")?.text;
      const body = def.childForFieldName("body");
      if (!name) continue;
      const kind = classKindOf(def);
      const symbolId = makeSymbolId(input, kind, name, def.startPosition.row);
      if (!inFunction && !ownerClassId) localClasses.add(name);
      symbols.push({
        repoId: input.repoId,
        symbolId,
        filePath: input.filePath,
        name,
        kind,
        line: def.startPosition.row + 1,
        endLine: def.endPosition.row + 1,
        signature: headerText(input.source, def, body),
        ...(ownerClassId ? { parentSymbolId: ownerClassId } : {})
      });
      for (const base of classBaseNames(def)) {
        edges.push({
          repoId: input.repoId,
          fromId: symbolId,
          toId: `base:${base}`,
          type: "EXTENDS",
          confidence: 0.95,
          reason: "class_bases"
        });
      }
      if (body) collectDefinitions(input, body, symbols, edges, routes, moduleSymbolId, symbolId, false, moduleFunctions, localClasses);
      continue;
    }

    if (def.type === "function_definition") {
      const name = def.childForFieldName("name")?.text;
      const body = def.childForFieldName("body");
      if (!name) continue;
      const kind = ownerClassId && !inFunction ? "method" : "function";
      const symbolId = makeSymbolId(input, kind, name, def.startPosition.row);
      if (!ownerClassId && !inFunction) moduleFunctions.add(name);
      symbols.push({
        repoId: input.repoId,
        symbolId,
        filePath: input.filePath,
        name,
        kind,
        line: def.startPosition.row + 1,
        endLine: def.endPosition.row + 1,
        signature: headerText(input.source, def, body),
        ...(kind === "method" && ownerClassId ? { parentSymbolId: ownerClassId } : {})
      });
      if (child.type === "decorated_definition") collectRoutes(input, child, symbolId, moduleSymbolId, name, routes);
      collectFixtureUses(input, child, def, name, symbolId, edges);
      if (body) collectDefinitions(input, body, symbols, edges, routes, moduleSymbolId, null, true, moduleFunctions, localClasses);
      continue;
    }

    // Defs nested in if/try/with/for blocks at the same level (`if TYPE_CHECKING:`, a guarded import of
    // an optional dependency, a platform branch) are still members of the enclosing scope.
    if (isCompoundStatement(child.type)) {
      collectDefinitions(input, child, symbols, edges, routes, moduleSymbolId, ownerClassId, inFunction, moduleFunctions, localClasses);
    }
  }
}

const COMPOUND_STATEMENTS = new Set([
  "if_statement", "elif_clause", "else_clause", "try_statement", "except_clause", "except_group_clause",
  "finally_clause", "with_statement", "for_statement", "while_statement", "block", "match_statement", "case_clause",
  // tree-sitter's error recovery wraps the statements around a syntax error; defs inside are still defs.
  "ERROR"
]);

function isCompoundStatement(type: string): boolean {
  return COMPOUND_STATEMENTS.has(type);
}

/** `def f(a, b) -> int` / `class A(Base)` — the header up to the body, whitespace collapsed. */
function headerText(source: string, def: Parser.SyntaxNode, body: Parser.SyntaxNode | null): string {
  const end = body ? body.startIndex : def.endIndex;
  const raw = source.slice(def.startIndex, end).replace(/\s+/g, " ").trim().replace(/:$/, "").trim();
  return raw.length <= MAX_SIGNATURE ? raw : `${raw.slice(0, MAX_SIGNATURE)}...`;
}

/**
 * PY-5: a class that lists `Protocol` among its bases (`typing.Protocol`, `typing_extensions.Protocol`,
 * `Protocol[T]`) is a structural interface, stored as kind `interface` so find_implementations, the
 * interface-dispatch fan-out and the interface sibling lookup treat it as one. A class that only extends
 * another Protocol is NOT a Protocol (PEP 544): it implements it.
 */
function classKindOf(def: Parser.SyntaxNode): "class" | "interface" {
  return classBaseNames(def).includes("Protocol") ? "interface" : "class";
}

/** The plain name each positional base names; keyword arguments (`metaclass=`) are not bases. */
function classBaseNames(def: Parser.SyntaxNode): string[] {
  const list = def.childForFieldName("superclasses");
  if (!list) return [];
  const out: string[] = [];
  for (const entry of list.namedChildren) {
    const name = typeNameOf(entry);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * The class a type expression names: `Foo`, `pkg.Foo` → `Foo`, `Generic[T]` → `Generic`,
 * `Optional[Foo]` / `Foo | None` → `Foo`. Null for anything that is not a plain name.
 */
function typeNameOf(node: Parser.SyntaxNode): string | null {
  switch (node.type) {
    case "identifier":
      // `Any` / `object` say nothing about the receiver: the call is read as an untyped one.
      return UNTYPED_NAMES.has(node.text) ? null : node.text;
    case "attribute":
      return node.childForFieldName("attribute")?.text ?? null;
    case "type":
      return node.namedChildren[0] ? typeNameOf(node.namedChildren[0]) : null;
    case "string":
      // A forward reference: `repo: "Repo"`.
      return /^["']([A-Za-z_][A-Za-z0-9_.]*)["']$/.exec(node.text)?.[1]?.split(".").pop() ?? null;
    case "subscript":
    case "generic_type":
      return genericTypeName(node);
    case "binary_operator": {
      // `Foo | None`
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      return (left ? typeNameOf(left) : null) ?? (right ? typeNameOf(right) : null);
    }
    default:
      return null;
  }
}

/** Wrappers whose argument is the type: `Optional[Foo]`, `Annotated[Foo, ...]`, `Union[Foo, None]`. */
const TYPE_WRAPPERS = new Set(["Optional", "Annotated", "Union", "Final", "ClassVar"]);
/**
 * Generic heads that say nothing about the receiver's own methods in the repo: `list[Foo].append` is a
 * builtin method, not `list.append` in the repo. Read as untyped, so the builtin-method filter applies.
 */
const BUILTIN_GENERIC_HEADS = new Set([
  "list", "dict", "set", "frozenset", "tuple", "type", "List", "Dict", "Set", "FrozenSet", "Tuple", "Type",
  "Sequence", "MutableSequence", "Iterable", "Iterator", "Mapping", "MutableMapping", "Callable", "Generator",
  "AsyncIterator", "AsyncIterable", "Awaitable", "Coroutine", "Collection", "DefaultDict", "OrderedDict", "Deque"
]);

/**
 * `Foo[...]` in either grammar shape — `subscript` (value + subscript fields, an expression) or
 * `generic_type` (identifier + `type_parameter`, an annotation in tree-sitter-python 0.21).
 */
function genericTypeName(node: Parser.SyntaxNode): string | null {
  const headNode = node.type === "subscript" ? node.childForFieldName("value") : node.namedChildren[0];
  const head = headNode ? typeNameOf(headNode) : null;
  if (!head) return null;
  if (TYPE_WRAPPERS.has(head)) {
    const args =
      node.type === "subscript"
        ? node.namedChildren.filter((c) => !headNode || !isSameNode(c, headNode))
        : (node.namedChildren.find((c) => c.type === "type_parameter")?.namedChildren ?? []);
    for (const arg of args) {
      const name = typeNameOf(arg);
      if (name) return name;
    }
    return null;
  }
  return BUILTIN_GENERIC_HEADS.has(head) ? null : head;
}

function collectRoutes(
  input: ExtractInput,
  decorated: Parser.SyntaxNode,
  handlerSymbolId: string,
  moduleSymbolId: string,
  handlerName: string,
  routes: RouteRecord[]
): void {
  for (const decorator of decorated.namedChildren.filter((c) => c.type === "decorator")) {
    const call = decorator.namedChildren[0];
    if (call?.type !== "call") continue;
    const fn = call.childForFieldName("function");
    if (fn?.type !== "attribute") continue;
    const receiver = fn.childForFieldName("object");
    const method = fn.childForFieldName("attribute")?.text.toLowerCase() ?? "";
    if (!receiver || !ROUTE_RECEIVER.test(receiver.text) || !ROUTE_METHODS.has(method)) continue;
    const template = extractFirstStringLiteral(call.childForFieldName("arguments")?.text ?? "") ?? "/";
    routes.push({
      repoId: input.repoId,
      filePath: input.filePath,
      controllerSymbolId: moduleSymbolId,
      handlerSymbolId,
      // MCP-ISSUE-055: the name as written at the registration site.
      handlerName,
      httpMethod: method.toUpperCase() as RouteRecord["httpMethod"],
      routeTemplate: template.startsWith("/") ? template : `/${template}`,
      line: decorator.startPosition.row + 1
    });
  }
}

const PYTEST_FILE = /(^|\/)(test_[^/]+|[^/]+_test|conftest)\.py$/i;
/** pytest's own fixtures: requested by name, defined by no repo code. */
const PYTEST_BUILTIN_FIXTURES = new Set([
  "self", "cls", "request", "tmp_path", "tmp_path_factory", "tmpdir", "tmpdir_factory", "monkeypatch",
  "capsys", "capsysbinary", "capfd", "capfdbinary", "caplog", "recwarn", "pytestconfig", "cache",
  "record_property", "record_testsuite_property", "doctest_namespace", "mocker", "event_loop"
]);

/**
 * PY-4 (best effort): pytest injects a fixture into a test — or into another fixture — by PARAMETER
 * NAME, so `def test_x(sample_item)` invokes the `sample_item` fixture (usually in a conftest.py). Each
 * such parameter becomes `callee:<name>`, which the call resolver binds to the fixture function by name;
 * a parameter no repo function defines ends as an external boundary like any other unbound callee.
 */
function collectFixtureUses(
  input: ExtractInput,
  outer: Parser.SyntaxNode,
  def: Parser.SyntaxNode,
  name: string,
  symbolId: string,
  edges: EdgeRecord[]
): void {
  if (!PYTEST_FILE.test(input.filePath.replace(/\\/g, "/"))) return;
  const isFixture =
    outer.type === "decorated_definition" &&
    outer.namedChildren.some((d) => d.type === "decorator" && /(^|\.)fixture\b/.test(d.text.replace(/^@\s*/, "")));
  if (!name.startsWith("test") && !isFixture) return;
  for (const param of def.childForFieldName("parameters")?.namedChildren ?? []) {
    const pname =
      param.type === "identifier"
        ? param.text
        : param.type === "typed_parameter"
          ? param.namedChildren.find((c) => c.type === "identifier")?.text
          : param.type === "default_parameter" || param.type === "typed_default_parameter"
            ? param.childForFieldName("name")?.text
            : undefined;
    if (!pname || PYTEST_BUILTIN_FIXTURES.has(pname)) continue;
    edges.push({ repoId: input.repoId, fromId: symbolId, toId: `callee:${pname}`, type: "CALLS" });
  }
}

// ── __all__ (PY-8b) ─────────────────────────────────────────────────────────────────────────

/**
 * PY-8b: a module's `__all__`, from its module-level `__all__ = [...]` / `(...)` and `__all__ += [...]`
 * statements, comma-joined. `undefined`: the module never assigns `__all__` (a star import binds its public
 * names). `null`: it assigns something other than a literal list of names (`a.__all__ + [...]`), so what it
 * exports is unknown and nothing is filtered.
 */
function readDunderAll(root: Parser.SyntaxNode): string | null | undefined {
  let names: string[] | undefined;
  for (const statement of root.namedChildren) {
    if (statement.type !== "expression_statement") continue;
    const assign = statement.namedChildren[0];
    // Review: `__all__.extend([...])` / `__all__.append("x")` add names too; any other `__all__.<m>(...)` makes
    // the list unknown. Before an assignment they are unknown as well (Python would raise).
    if (assign?.type === "call") {
      const fn = assign.childForFieldName("function");
      if (fn?.type !== "attribute" || fn.childForFieldName("object")?.text !== "__all__") continue;
      const method = fn.childForFieldName("attribute")?.text;
      const args = (assign.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type !== "comment");
      const items = method === "append" ? args : method === "extend" && args.length === 1 && (args[0]!.type === "list" || args[0]!.type === "tuple") ? args[0]!.namedChildren : null;
      if (names === undefined || !items || (method === "append" && args.length !== 1)) return null;
      for (const item of items) {
        if (item.type === "comment") continue;
        const value = item.type === "string" ? stringLiteralValue(item.text) : undefined;
        if (value === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return null;
        names.push(value);
      }
      continue;
    }
    if (assign?.type !== "assignment" && assign?.type !== "augmented_assignment") continue;
    if (assign.childForFieldName("left")?.text !== "__all__") continue;
    const right = assign.childForFieldName("right");
    if (!right || (right.type !== "list" && right.type !== "tuple")) return null;
    const listed: string[] = [];
    for (const item of right.namedChildren) {
      if (item.type === "comment") continue;
      const value = item.type === "string" ? stringLiteralValue(item.text) : undefined;
      if (value === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return null;
      listed.push(value);
    }
    names = assign.type === "augmented_assignment" ? [...(names ?? []), ...listed] : listed;
  }
  return names === undefined ? undefined : [...new Set(names)].join(",");
}

/** `"x"` / `'x'` / `u"x"` → `x`; an f-string or a byte string is not a name. */
function stringLiteralValue(text: string): string | undefined {
  const match = /^[rRuU]?("""|'''|"|')([\s\S]*)\1$/.exec(text);
  return match ? match[2] : undefined;
}

// ── Imports ─────────────────────────────────────────────────────────────────────────────────

function extractImports(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  edges: EdgeRecord[],
  moduleSymbolId: string
): ImportScope {
  const scope: ImportScope = { names: new Map(), modules: new Map(), starModules: [] };
  const specs: string[] = [];

  for (const node of root.descendantsOfType(["import_statement", "import_from_statement"])) {
    if (node.type === "import_statement") {
      for (const entry of node.namedChildren) {
        const dotted = entry.type === "aliased_import" ? entry.childForFieldName("name") : entry;
        if (dotted?.type !== "dotted_name") continue;
        const spec = dotted.text.replace(/\s+/g, "");
        specs.push(spec);
        const alias = entry.type === "aliased_import" ? entry.childForFieldName("alias")?.text : undefined;
        if (alias) {
          scope.modules.set(alias, spec);
        } else {
          // `import a.b.c` binds `a`; every prefix is a receiver text that names a module.
          const parts = spec.split(".");
          for (let i = 1; i <= parts.length; i += 1) scope.modules.set(parts.slice(0, i).join("."), parts.slice(0, i).join("."));
        }
      }
      continue;
    }

    const moduleNode = node.childForFieldName("module_name");
    if (!moduleNode) continue;
    const modulePart = moduleSpecText(moduleNode);
    if (modulePart === "__future__") continue;
    const wildcard = node.namedChildren.some((c) => c.type === "wildcard_import");
    if (wildcard) {
      // PY-8: `x.*` (`.*` for `from . import *`) — the module resolves as `x`, and the `*` tells
      // moduleResolution to put what `x` re-exports in this file's scope too.
      specs.push(joinSpec(modulePart, "*"));
      if (!isStdlibSpec(modulePart)) scope.starModules.push(modulePart);
      continue;
    }
    for (const entry of node.namedChildren) {
      if (isSameNode(entry, moduleNode)) continue;
      const dotted = entry.type === "aliased_import" ? entry.childForFieldName("name") : entry;
      if (dotted?.type !== "dotted_name") continue;
      const original = dotted.text.replace(/\s+/g, "");
      specs.push(joinSpec(modulePart, original));
      const local = (entry.type === "aliased_import" ? entry.childForFieldName("alias")?.text : undefined) ?? original;
      scope.names.set(local, { original, fromModule: modulePart });
    }
  }

  for (const spec of [...new Set(specs)]) {
    edges.push({ repoId: input.repoId, fromId: moduleSymbolId, toId: `import:${spec}`, type: "IMPORTS" });
  }
  return scope;
}

/** `relative_import` keeps its dots: `..checks.registry`; a bare `.` stays `.`. */
function moduleSpecText(node: Parser.SyntaxNode): string {
  return node.text.replace(/\s+/g, "");
}

/** `x` + `y` → `x.y`; `.` + `y` → `.y`; `..` + `y` → `..y`. */
function joinSpec(modulePart: string, name: string): string {
  return /^\.+$/.test(modulePart) ? `${modulePart}${name}` : `${modulePart}.${name}`;
}

function isStdlibSpec(spec: string): boolean {
  if (spec.startsWith(".")) return false;
  return PYTHON_STDLIB_MODULES.has(spec.split(".")[0] ?? "");
}

// ── Calls ───────────────────────────────────────────────────────────────────────────────────

/**
 * Names → class a receiver is known to hold, per function (parameters, constructor assignments).
 *
 * PY-6: a type is a class name (`Foo`) or a callable that returns one (`()=>Foo`, from `Callable[..., Foo]`).
 * `returns` holds the file's return annotations and type aliases; `callSites` the file's calls by callee
 * name, for the one hop from an untyped parameter to its same-file callers' argument types.
 */
type TypeScopes = {
  byFunction: Map<number, Map<string, string>>;
  byClass: Map<number, Map<string, string>>;
  returns: ReturnTypes;
  callSites: Map<string, Parser.SyntaxNode[]>;
  /** `<fn startIndex>:<param>` → the one type its same-file callers pass, or null (none / several). */
  hop: Map<string, string | null>;
  localClasses: Set<string>;
  scope: ImportScope;
};

type ReturnTypes = {
  /** Module function name → its return type. */
  functions: Map<string, string>;
  /** `Class.method` → its return type. */
  methods: Map<string, string>;
  /** Module-level `X = Callable[[...], Foo]` / `X = Foo` / `X: TypeAlias = ...`. */
  aliases: Map<string, string>;
};

const CALLABLE_PREFIX = "()=>";

function extractCalls(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  edges: EdgeRecord[],
  moduleSymbolId: string,
  scope: ImportScope,
  moduleFunctions: Set<string>,
  localClasses: Set<string>,
  registered: ReadonlySet<string>
): void {
  const types: TypeScopes = {
    byFunction: new Map(),
    byClass: new Map(),
    returns: collectReturnTypes(root),
    callSites: indexCallSites(root),
    hop: new Map(),
    localClasses,
    scope
  };
  const seen = new Map<string, EdgeRecord>();
  const push = (fromId: string, token: string): EdgeRecord => {
    const key = `${fromId}\u0000${token}`;
    const known = seen.get(key);
    if (known) return known;
    const edge: EdgeRecord = { repoId: input.repoId, fromId, toId: `callee:${token}`, type: "CALLS" };
    seen.set(key, edge);
    edges.push(edge);
    return edge;
  };
  // PY-6b: per CALLS edge, the untyped-parameter receivers (bare tokens) and each call site's argument types.
  const hints = new Map<EdgeRecord, { receivers: Set<string>; sites: string[] }>();
  // Row #16: edges reached only from `obj.m()` sites on an object receiver, and edges reached any other way.
  const objectOnly = new Set<EdgeRecord>();
  const otherwise = new Set<EdgeRecord>();
  const hintOf = (edge: EdgeRecord) => {
    let hint = hints.get(edge);
    if (!hint) hints.set(edge, (hint = { receivers: new Set(), sites: [] }));
    return hint;
  };

  for (const call of root.descendantsOfType("call")) {
    const fn = call.childForFieldName("function");
    if (!fn) continue;
    const fromId = enclosingSymbolId(call, input, registered) ?? moduleSymbolId;
    const token = callToken(fn, call, scope, moduleFunctions, localClasses, types);
    if (token) {
      const edge = push(fromId, token);
      const site = argumentTypes(call, types, isClassCall(fn, call, scope, localClasses, types));
      if (site && hintOf(edge).sites.length < MAX_HINT_SITES) hintOf(edge).sites.push(site);
      const objectReceiver = !token.includes(".") && fn.type === "attribute" && isObjectReceiver(fn, scope);
      (objectReceiver ? objectOnly : otherwise).add(edge);
      if (!token.includes(".") && fn.type === "attribute") {
        const receiver = fn.childForFieldName("object");
        const ref =
          receiver?.type === "identifier" ? untypedParameterRef(call, receiver.text, types) : receiver?.type === "attribute" ? initFieldRef(receiver, call, types) : null;
        if (ref) hintOf(edge).receivers.add(ref);
      }
    }

    // Best-effort references: a known function passed as an argument (`partial(f)`, `register(f)`,
    // `Thread(target=f)`) is invoked through that value.
    const args = call.childForFieldName("arguments");
    for (const arg of args?.namedChildren ?? []) {
      const value = arg.type === "keyword_argument" ? arg.childForFieldName("value") : arg;
      const ref = value ? referenceToken(value, scope, moduleFunctions) : null;
      if (ref) otherwise.add(push(fromId, ref));
    }
  }

  // Registry dicts / lists / tuples / sets of functions.
  for (const container of root.descendantsOfType(["dictionary", "list", "tuple", "set"])) {
    const values =
      container.type === "dictionary"
        ? container.namedChildren.filter((c) => c.type === "pair").map((p) => p.childForFieldName("value"))
        : container.namedChildren;
    for (const value of values) {
      const ref = value ? referenceToken(value, scope, moduleFunctions) : null;
      if (ref) otherwise.add(push(enclosingSymbolId(container, input, registered) ?? moduleSymbolId, ref));
    }
  }

  // A bare decorator `@register` calls `register` with the decorated function.
  for (const decorator of root.descendantsOfType("decorator")) {
    const expr = decorator.namedChildren[0];
    if (expr?.type !== "identifier" && expr?.type !== "attribute") continue;
    const token = callToken(expr, decorator, scope, moduleFunctions, localClasses, types);
    if (token) otherwise.add(push(enclosingSymbolId(decorator, input, registered) ?? moduleSymbolId, token));
  }

  // PY-6b: the hints ride on the edge's `assignedExpression` (stored, never rewritten by call resolution), so
  // the resolver can type an untyped parameter from callers in OTHER files, over several hops.
  for (const [edge, hint] of hints) {
    const parts: string[] = [];
    if (hint.receivers.size > 0) parts.push(`${PYTHON_RECEIVER_HINT}${edge.toId.slice("callee:".length)}|${[...hint.receivers].sort().join(",")}`);
    const sites = [...new Set(hint.sites)];
    while (sites.length > 0 && sites.join(";").length > MAX_HINT_LENGTH) sites.pop();
    if (sites.length > 0) parts.push(`${PYTHON_ARGS_HINT}${sites.join(";")}`);
    if (parts.length > 0) edge.assignedExpression = parts.join(" ");
  }
  for (const edge of objectOnly) {
    if (otherwise.has(edge)) continue;
    edge.assignedExpression = edge.assignedExpression ? `${edge.assignedExpression} ${PYTHON_OBJECT_RECEIVER_MARK}` : PYTHON_OBJECT_RECEIVER_MARK;
  }
}

/** Row #16: `obj.m()` whose receiver is not `self` / `cls` (those arrive qualified) and not an imported module. */
function isObjectReceiver(fn: Parser.SyntaxNode, scope: ImportScope): boolean {
  const receiver = fn.childForFieldName("object");
  if (!receiver) return false;
  if (receiver.type === "identifier" && (receiver.text === "self" || receiver.text === "cls")) return false;
  return !scope.modules.has(receiver.text.replace(/\s+/g, ""));
}

/** PY-6b: at most this many call sites' argument types per (caller, callee) edge, and this many characters. */
const MAX_HINT_SITES = 8;
const MAX_HINT_LENGTH = 600;

/**
 * PY-6b: `pos:name` when `name` is a parameter of the function holding `site` that nothing types — no
 * annotation, default constructor or assignment, and no same-file caller agreeing on one class (`hopType`).
 * `pos` counts after `self` / `cls`, as a call site's positional arguments do.
 */
function untypedParameterRef(site: Parser.SyntaxNode, name: string, types: TypeScopes): string | null {
  if (name === "self" || name === "cls") return null;
  const fn = enclosingFunction(site);
  if (!fn) return null;
  // Review: a parameter after `*args` / a bare `*` is keyword-only — no positional index (`-1`), matched by
  // name only; a `/` marker is not a parameter.
  const positional: (string | null)[] = [];
  const keywordOnly: string[] = [];
  let afterStar = false;
  for (const p of fn.childForFieldName("parameters")?.namedChildren ?? []) {
    if (p.type === "positional_separator" || p.type === "comment") continue;
    if (p.type === "list_splat_pattern" || p.type === "keyword_separator" || p.type === "dictionary_splat_pattern") {
      afterStar = true;
      continue;
    }
    const pname = parameterName(p);
    if (afterStar) {
      if (pname) keywordOnly.push(pname);
    } else positional.push(pname);
  }
  if (isMethodDefinition(fn) && (positional[0] === "self" || positional[0] === "cls")) positional.shift();
  const index = positional.indexOf(name);
  if (index < 0 && !keywordOnly.includes(name)) return null;
  if (localType(site, name, types) !== null || hopType(site, name, types) !== null) return null;
  return `${String(index)}:${name}`;
}

/**
 * Row #16: `self.f.m()` where the class's `__init__` assigns `self.f = p` from its untyped parameter `p` —
 * `@<pos>:<p>`, a parameter of the caller's class's `__init__`, which `Foo(x)` callers type. Null when the
 * field is typed (`classFieldType`) or not set from an `__init__` parameter.
 */
function initFieldRef(receiver: Parser.SyntaxNode, site: Parser.SyntaxNode, types: TypeScopes): string | null {
  const inner = receiver.childForFieldName("object");
  const field = receiver.childForFieldName("attribute")?.text;
  if (inner?.type !== "identifier" || inner.text !== "self" || !field) return null;
  const owner = enclosingClass(site);
  if (!owner || classFieldType(owner, field, types) !== null) return null;
  // The last `__init__` the body defines wins, as at runtime: `@overload` stubs come before the real one.
  const init = (owner.childForFieldName("body")?.namedChildren ?? [])
    .map((c) => (c.type === "decorated_definition" ? c.childForFieldName("definition") : c))
    .filter((d) => d?.type === "function_definition" && d.childForFieldName("name")?.text === "__init__")
    .pop();
  const body = init?.childForFieldName("body");
  if (!body) return null;
  // The first `self.<field> = …` in `__init__`'s own body (not a nested def), as `classFieldType` reads it.
  const stack: Parser.SyntaxNode[] = [...body.namedChildren].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "function_definition" || node.type === "class_definition" || node.type === "lambda") continue;
    if (node.type === "assignment") {
      const left = node.childForFieldName("left");
      if (left?.type === "attribute" && left.childForFieldName("object")?.text === "self" && left.childForFieldName("attribute")?.text === field) {
        const right = node.childForFieldName("right");
        const ref = right?.type === "identifier" ? untypedParameterRef(right, right.text, types) : null;
        return ref ? `@${ref}` : null;
      }
    }
    const kids = node.namedChildren;
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]!);
  }
  return null;
}

/**
 * PY-6b: one call site's argument types — `#<i>=<Class>` positionally, `<kw>=<Class>` by keyword, and
 * `=^<pos>:<name>` for an argument that is the caller's own untyped parameter (the next hop). Positional
 * indexes stop at the first `*args` / `**kw` splat. Null when no argument is typed.
 *
 * A call on a class (`Foo.m(inst, arg)`, `cls.m(...)`) writes `$<i>` instead of `#<i>`: whether its first
 * argument is `self` depends on the method it reaches (an instance method's, not a static / class method's),
 * which only the resolver knows — it shifts `$` slots by one for a callee whose first parameter is `self`.
 */
function argumentTypes(call: Parser.SyntaxNode, types: TypeScopes, classCall = false): string | null {
  const mark = classCall ? "$" : "#";
  const entries: string[] = [];
  let index = 0;
  let positionalOpen = true;
  for (const arg of call.childForFieldName("arguments")?.namedChildren ?? []) {
    if (arg.type === "comment") continue;
    if (arg.type === "list_splat" || arg.type === "dictionary_splat") {
      positionalOpen = false;
      continue;
    }
    const keyword = arg.type === "keyword_argument" ? arg.childForFieldName("name")?.text : undefined;
    const value = keyword !== undefined ? arg.childForFieldName("value") : arg;
    const slot = keyword !== undefined ? keyword : positionalOpen ? `${mark}${String(index)}` : null;
    if (keyword === undefined) index += 1;
    if (!value || !slot) continue;
    const typed = classOf(value.type === "call" ? (constructedClass(value, types) ?? exprType(value, types, false)) : exprType(value, types, false), types);
    if (typed && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(typed)) {
      entries.push(`${slot}=${typed}`);
      continue;
    }
    const ref = value.type === "identifier" ? untypedParameterRef(value, value.text, types) : null;
    if (ref) entries.push(`${slot}=^${ref}`);
  }
  return entries.length > 0 ? entries.join(",") : null;
}

/**
 * PY-6b: the call's receiver is a class, not an instance — `Foo.m(...)` for a class defined or imported here
 * (or star-imported, as `callToken` reads a capitalised unbound name), or `cls.m(...)` inside a class. The
 * same order as `callToken`, so a local that holds an instance (`x = Foo(); x.m()`) is never one.
 */
function isClassCall(fn: Parser.SyntaxNode, site: Parser.SyntaxNode, scope: ImportScope, localClasses: Set<string>, types: TypeScopes): boolean {
  if (fn.type !== "attribute") return false;
  const receiver = fn.childForFieldName("object");
  if (receiver?.type !== "identifier") return false;
  const name = receiver.text;
  if (name === "cls") return enclosingClass(site) !== null;
  if (name === "self" || scope.modules.has(name)) return false;
  const imported = scope.names.get(name);
  // Review: an imported ALL-CAPS name (`REGISTRY.register(a, b)`) is a module-level instance, not a class.
  if (imported) return !isStdlibSpec(imported.fromModule) && /^[A-Z][A-Za-z0-9_]*[a-z]/.test(imported.original);
  if (localClasses.has(name)) return true;
  if (classOf(localType(site, name, types), types) ?? hopType(site, name, types)) return false;
  return scope.starModules.length > 0 && /^[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*$/.test(name);
}

/** A function name used as a value: defined at module level here, or from-imported from a repo module. */
function referenceToken(node: Parser.SyntaxNode, scope: ImportScope, moduleFunctions: Set<string>): string | null {
  if (node.type !== "identifier") return null;
  const name = node.text;
  if (moduleFunctions.has(name)) return name;
  const imported = scope.names.get(name);
  // A lower-case imported name is a function (or a submodule, which binds nothing); a capitalised one
  // is a class, and passing a class around is not invoking it.
  if (imported && !isStdlibSpec(imported.fromModule) && /^[a-z_]/.test(imported.original)) return imported.original;
  return null;
}

/**
 * The token for one call site:
 *   - `f()` → `f` (an imported alias → its original name; builtins skipped unless shadowed);
 *   - `self.m()` / `cls.m()` → `<EnclosingClass>.m`; `cls(...)` → `<EnclosingClass>`; `super().m()` → `<FirstBase>.m`;
 *   - `mod.f()` for an imported module or module alias → `f`; a stdlib module → nothing;
 *   - `Cls.m()` for a class defined or imported here → `Cls.m`;
 *   - `x.m()` where `x` is a parameter annotated `x: Foo` or assigned `x = Foo(...)`, and
 *     `self.x.m()` where the class assigns `self.x = Foo(...)` / annotates `x: Foo` → `Foo.m`;
 *   - any other `obj.m()` → `m`, unless `m` is a method of a builtin type.
 */
function callToken(
  fn: Parser.SyntaxNode,
  site: Parser.SyntaxNode,
  scope: ImportScope,
  moduleFunctions: Set<string>,
  localClasses: Set<string>,
  types: TypeScopes
): string | null {
  if (fn.type === "identifier") {
    const name = fn.text;
    if (name === "cls") {
      // `cls(...)` in a classmethod constructs the owner class.
      const ownerName = enclosingClass(site)?.childForFieldName("name")?.text;
      return ownerName ?? null;
    }
    const imported = scope.names.get(name);
    if (imported) return isStdlibSpec(imported.fromModule) ? null : imported.original;
    if (PYTHON_BUILTIN_FUNCTIONS.has(name) && !moduleFunctions.has(name) && !localClasses.has(name)) return null;
    return name;
  }
  if (fn.type !== "attribute") return null;

  const member = fn.childForFieldName("attribute")?.text;
  const receiver = fn.childForFieldName("object");
  if (!member || !receiver) return null;

  if (receiver.type === "identifier" && (receiver.text === "self" || receiver.text === "cls")) {
    const owner = enclosingClass(site);
    const ownerName = owner?.childForFieldName("name")?.text;
    return ownerName ? `${ownerName}.${member}` : member;
  }

  if (receiver.type === "call" && receiver.childForFieldName("function")?.text === "super") {
    const owner = enclosingClass(site);
    const base = owner ? classBaseNames(owner)[0] : undefined;
    return base ? `${base}.${member}` : null;
  }

  const receiverText = receiver.text.replace(/\s+/g, "");
  const moduleSpec = scope.modules.get(receiverText);
  if (moduleSpec !== undefined) return isStdlibSpec(moduleSpec) ? null : member;

  if (receiver.type === "identifier") {
    const name = receiver.text;
    const imported = scope.names.get(name);
    if (imported) {
      if (isStdlibSpec(imported.fromModule)) return null;
      // `from pkg import mod; mod.f()` → f; `from pkg import Cls; Cls.make()` → Cls.make.
      return /^[A-Z]/.test(imported.original) ? `${imported.original}.${member}` : member;
    }
    if (localClasses.has(name)) return `${name}.${member}`;
    // PY-6: the local / parameter type first, then (1 hop) the one type every same-file caller passes.
    const typed = classOf(localType(site, name, types), types) ?? hopType(site, name, types);
    if (typed) return `${typed}.${member}`;
    if (PYTHON_STDLIB_MODULES.has(name)) return null;
    // PY-8: a capitalised name nothing here binds, in a file that star-imports a repo module, is a class that
    // import brought in: `Cls.m`, resolved on the classes the file can see (an external boundary if none).
    if (scope.starModules.length > 0 && /^[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*$/.test(name)) return `${name}.${member}`;
  }

  if (receiver.type === "attribute") {
    const inner = receiver.childForFieldName("object");
    const field = receiver.childForFieldName("attribute")?.text;
    if (inner?.type === "identifier" && inner.text === "self" && field) {
      const owner = enclosingClass(site);
      const typed = owner ? classOf(classFieldType(owner, field, types), types) : null;
      if (typed) return `${typed}.${member}`;
    }
  }

  // PY-6: a call as the receiver — `self.make().run()`, `build(x).run()`, `self.factory(id)().run()` — is
  // typed from the callee's return annotation (a `Callable[..., Foo]` alias called once more yields `Foo`).
  if (receiver.type === "call") {
    const typed = classOf(exprType(receiver, types, true), types);
    if (typed) return `${typed}.${member}`;
  }

  return PYTHON_BUILTIN_METHODS.has(member) ? null : member;
}

/** The nearest class whose method (or a function nested in one) holds `node`. */
function enclosingClass(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let current: Parser.SyntaxNode | null = node.parent;
  let passedFunction = false;
  while (current) {
    if (current.type === "function_definition") passedFunction = true;
    if (current.type === "class_definition") return passedFunction ? current : null;
    current = current.parent;
  }
  return null;
}

function enclosingFunction(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === "function_definition") return current;
    current = current.parent;
  }
  return null;
}

/**
 * The id of the def or class that holds `node`, minted exactly as `collectDefinitions` minted it: a def
 * directly in a class body is a `method`, every other def a `function`. A call in a class body outside
 * any method belongs to the class.
 */
function enclosingSymbolId(node: Parser.SyntaxNode, input: ExtractInput, registered: ReadonlySet<string>): string | null {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === "function_definition" || current.type === "class_definition") {
      const name = current.childForFieldName("name")?.text;
      if (name) {
        const kind = current.type === "class_definition" ? classKindOf(current) : isMethodDefinition(current) ? "method" : "function";
        const id = makeSymbolId(input, kind, name, current.startPosition.row);
        if (registered.has(id)) return id;
      }
    }
    current = current.parent;
  }
  return null;
}

/** True when the def sits directly in a class body (through a decorator and same-level if/try blocks). */
function isMethodDefinition(def: Parser.SyntaxNode): boolean {
  let current: Parser.SyntaxNode | null = def.parent;
  while (current) {
    if (current.type === "class_definition") return true;
    if (current.type === "function_definition" || current.type === "module") return false;
    current = current.parent;
  }
  return false;
}

/** The class a local name holds inside the enclosing function: a parameter annotation, or `x = Foo(...)`. */
function localType(site: Parser.SyntaxNode, name: string, types: TypeScopes): string | null {
  const fn = enclosingFunction(site);
  if (!fn) return null;
  let map = types.byFunction.get(fn.startIndex);
  if (!map) {
    map = new Map<string, string>();
    // Cached BEFORE it is filled: an assignment typed from a call (PY-6) may ask this function's map again.
    types.byFunction.set(fn.startIndex, map);
    const params = fn.childForFieldName("parameters");
    for (const p of params?.namedChildren ?? []) {
      const pname = parameterName(p);
      if (!pname) continue;
      const ptype = p.type === "typed_parameter" || p.type === "typed_default_parameter" ? p.childForFieldName("type") : null;
      let tname = ptype ? annotationType(ptype) : null;
      // PY-6: `def f(x=Foo())` — the default's constructor types the parameter when nothing annotates it.
      const value = p.type === "default_parameter" || p.type === "typed_default_parameter" ? p.childForFieldName("value") : null;
      if (!tname && value?.type === "call") tname = constructedClass(value, types);
      if (tname) map.set(pname, tname);
    }
    const body = fn.childForFieldName("body");
    if (body) {
      collectAssignedTypes(body, map, (left) => (left.type === "identifier" ? left.text : null), undefined, (right) =>
        right.type === "call" ? exprType(right, types, false) : null
      );
    }
  }
  return map.get(name) ?? null;
}

function parameterName(p: Parser.SyntaxNode): string | null {
  if (p.type === "identifier") return p.text;
  if (p.type === "typed_parameter") return p.namedChildren.find((c) => c.type === "identifier")?.text ?? null;
  if (p.type === "default_parameter" || p.type === "typed_default_parameter") return p.childForFieldName("name")?.text ?? null;
  return null;
}

// ── PY-6: return annotations, aliases, call receivers, 1-hop caller arguments ─────────────────────

/** An annotation as a PY-6 type: `Callable[[...], Foo]` → `()=>Foo`, anything else as `typeNameOf` reads it. */
function annotationType(node: Parser.SyntaxNode): string | null {
  const inner = node.type === "type" && node.namedChildren[0] ? node.namedChildren[0] : node;
  if (inner.type === "subscript" || inner.type === "generic_type") {
    const headNode = inner.type === "subscript" ? inner.childForFieldName("value") : inner.namedChildren[0];
    const head = headNode?.type === "attribute" ? headNode.childForFieldName("attribute")?.text : headNode?.text;
    if (head === "Callable") {
      const args =
        inner.type === "subscript"
          ? inner.namedChildren.filter((c) => !headNode || !isSameNode(c, headNode))
          : (inner.namedChildren.find((c) => c.type === "type_parameter")?.namedChildren ?? []);
      const ret = args[args.length - 1];
      const rname = ret ? annotationType(ret) : null;
      return rname ? `${CALLABLE_PREFIX}${rname}` : null;
    }
  }
  return typeNameOf(node);
}

/** Module-level aliases and every def's return annotation, keyed for `exprType`. */
function collectReturnTypes(root: Parser.SyntaxNode): ReturnTypes {
  const out: ReturnTypes = { functions: new Map(), methods: new Map(), aliases: new Map() };
  for (const stmt of root.namedChildren) {
    const assign = stmt.type === "expression_statement" ? stmt.namedChildren[0] : null;
    if (assign?.type !== "assignment") continue;
    const left = assign.childForFieldName("left");
    const right = assign.childForFieldName("right");
    if (left?.type !== "identifier" || !right || !/^[A-Z]/.test(left.text)) continue;
    const t = right.type === "subscript" || right.type === "identifier" || right.type === "attribute" ? annotationType(right) : null;
    if (t && t !== left.text) out.aliases.set(left.text, t);
  }
  for (const def of root.descendantsOfType("function_definition")) {
    const name = def.childForFieldName("name")?.text;
    const ret = def.childForFieldName("return_type");
    const t = ret ? annotationType(ret) : null;
    if (!name || !t) continue;
    const owner = isMethodDefinition(def) ? enclosingClassOfDef(def)?.childForFieldName("name")?.text : null;
    if (owner) out.methods.set(`${owner}.${name}`, t);
    else if (!enclosingFunction(def)) out.functions.set(name, t);
  }
  return out;
}

/** An alias followed to what it names (a few hops, never a cycle). */
function resolveAlias(t: string | null, types: TypeScopes): string | null {
  let current = t;
  for (let i = 0; current && i < 4; i += 1) {
    const isCallable = current.startsWith(CALLABLE_PREFIX);
    const bare = isCallable ? current.slice(CALLABLE_PREFIX.length) : current;
    const next = types.returns.aliases.get(bare);
    if (!next) return current;
    current = isCallable ? (next.startsWith(CALLABLE_PREFIX) ? null : `${CALLABLE_PREFIX}${next}`) : next;
  }
  return current;
}

/** A PY-6 type that names a class a member can be looked up on; a callable or nothing → null. */
function classOf(t: string | null, types: TypeScopes): string | null {
  const resolved = resolveAlias(t, types);
  return resolved && !resolved.startsWith(CALLABLE_PREFIX) ? resolved : null;
}

/** `Foo(...)` for a capitalised callee: the class it constructs. */
function constructedClass(call: Parser.SyntaxNode, types: TypeScopes): string | null {
  const callee = call.childForFieldName("function");
  const cname = callee ? typeNameOf(callee) : null;
  if (!cname || !/^[A-Z]/.test(cname) || types.returns.aliases.has(cname)) return null;
  return cname;
}

/**
 * The PY-6 type of an expression, from what this file proves: a constructor call, a function's or method's
 * return annotation (`self.m()` on the enclosing class), a callable type called once more, a typed local or
 * field. `hop` lets an untyped parameter take its callers' argument type; it is off inside that hop.
 */
function exprType(node: Parser.SyntaxNode, types: TypeScopes, hop: boolean): string | null {
  switch (node.type) {
    case "parenthesized_expression":
      return node.namedChildren[0] ? exprType(node.namedChildren[0], types, hop) : null;
    case "identifier": {
      if (node.text === "self" || node.text === "cls") return enclosingClass(node)?.childForFieldName("name")?.text ?? null;
      return resolveAlias(localType(node, node.text, types), types) ?? (hop ? hopType(node, node.text, types) : null);
    }
    case "attribute": {
      const obj = node.childForFieldName("object");
      const field = node.childForFieldName("attribute")?.text;
      if (obj?.type === "identifier" && obj.text === "self" && field) {
        const owner = enclosingClass(node);
        return owner ? resolveAlias(classFieldType(owner, field, types), types) : null;
      }
      return null;
    }
    case "call": {
      const fn = node.childForFieldName("function");
      if (!fn) return null;
      if (fn.type === "identifier") {
        const name = fn.text;
        const fromFunction = types.returns.functions.get(name);
        if (fromFunction) return resolveAlias(fromFunction, types);
        const imported = types.scope.names.get(name);
        if (types.localClasses.has(name) || (imported && !isStdlibSpec(imported.fromModule) && /^[A-Z]/.test(imported.original))) {
          return imported?.original ?? name;
        }
        const local = resolveAlias(localType(node, name, types), types);
        return local?.startsWith(CALLABLE_PREFIX) ? local.slice(CALLABLE_PREFIX.length) : null;
      }
      if (fn.type === "attribute") {
        const obj = fn.childForFieldName("object");
        const member = fn.childForFieldName("attribute")?.text;
        if (!obj || !member) return null;
        const owner = classOf(exprType(obj, types, hop), types);
        const fromMethod = owner ? types.returns.methods.get(`${owner}.${member}`) : undefined;
        return fromMethod ? resolveAlias(fromMethod, types) : null;
      }
      // `f(x)()`: the inner call returns a callable; calling it yields what the callable returns.
      const inner = resolveAlias(exprType(fn, types, hop), types);
      return inner?.startsWith(CALLABLE_PREFIX) ? inner.slice(CALLABLE_PREFIX.length) : null;
    }
    default:
      return null;
  }
}

/** Calls in the file by the name they call: `f(...)` → `f`, `self.m(...)` / `cls.m(...)` → `.m`. */
function indexCallSites(root: Parser.SyntaxNode): Map<string, Parser.SyntaxNode[]> {
  const out = new Map<string, Parser.SyntaxNode[]>();
  for (const call of root.descendantsOfType("call")) {
    const fn = call.childForFieldName("function");
    let key: string | undefined;
    if (fn?.type === "identifier") key = fn.text;
    else if (fn?.type === "attribute") {
      const obj = fn.childForFieldName("object");
      if (obj?.type === "identifier" && (obj.text === "self" || obj.text === "cls")) key = `.${fn.childForFieldName("attribute")?.text ?? ""}`;
    }
    if (!key) continue;
    const list = out.get(key);
    if (list) list.push(call);
    else out.set(key, [call]);
  }
  return out;
}

/**
 * PY-6, one hop: an untyped parameter of the function holding `site` takes the class its same-file callers
 * pass in that position (or by keyword) — only when every caller that types the argument agrees.
 */
function hopType(site: Parser.SyntaxNode, name: string, types: TypeScopes): string | null {
  const fn = enclosingFunction(site);
  if (!fn) return null;
  const key = `${fn.startIndex}:${name}`;
  if (types.hop.has(key)) return types.hop.get(key) ?? null;
  types.hop.set(key, null);
  const fnName = fn.childForFieldName("name")?.text;
  const params = (fn.childForFieldName("parameters")?.namedChildren ?? []).map(parameterName);
  const method = isMethodDefinition(fn);
  // A @staticmethod has no self / cls to skip.
  const positional = method && (params[0] === "self" || params[0] === "cls") ? params.slice(1) : params;
  const index = positional.indexOf(name);
  if (!fnName || index < 0) return null;
  // `self.m(...)` / `cls.m(...)` reaches this method only from inside its own class.
  const ownerClass = method ? enclosingClassOfDef(fn) : null;
  const sites = method
    ? (types.callSites.get(`.${fnName}`) ?? []).filter((c) => {
        const cls = enclosingClass(c);
        return cls !== null && ownerClass !== null && isSameNode(cls, ownerClass);
      })
    : (types.callSites.get(fnName) ?? []);
  const found = new Set<string>();
  for (const call of sites) {
    const args = call.childForFieldName("arguments")?.namedChildren ?? [];
    const keyword = args.find((a) => a.type === "keyword_argument" && a.childForFieldName("name")?.text === name);
    // `cls.m(inst, x)` on an instance method passes `self` explicitly: its positional arguments sit one further on.
    const viaCls = call.childForFieldName("function")?.childForFieldName("object")?.text === "cls" && params[0] === "self" ? 1 : 0;
    const arg = keyword ? keyword.childForFieldName("value") : args.filter((a) => a.type !== "keyword_argument")[index + viaCls];
    if (!arg) continue;
    const t = classOf(arg.type === "call" ? (constructedClass(arg, types) ?? exprType(arg, types, false)) : exprType(arg, types, false), types);
    if (t) found.add(t);
  }
  const result = found.size === 1 ? [...found][0]! : null;
  types.hop.set(key, result);
  return result;
}

/** The class `self.<field>` holds: a class-level `field: Foo`, or `self.field = Foo(...)` / `self.field = param` in a method. */
function classFieldType(cls: Parser.SyntaxNode, field: string, types: TypeScopes): string | null {
  let map = types.byClass.get(cls.startIndex);
  if (!map) {
    map = new Map<string, string>();
    const body = cls.childForFieldName("body");
    for (const stmt of body?.namedChildren ?? []) {
      const assign = stmt.type === "expression_statement" ? stmt.namedChildren[0] : null;
      if (assign?.type !== "assignment") continue;
      const left = assign.childForFieldName("left");
      const annotation = assign.childForFieldName("type");
      const tname = annotation ? typeNameOf(annotation) : null;
      if (left?.type === "identifier" && tname) map.set(left.text, tname);
    }
    const fieldMap = map;
    for (const def of body?.descendantsOfType("function_definition") ?? []) {
      if (!isMethodDefinition(def) || !isSameNode(enclosingClassOfDef(def) ?? def, cls)) continue;
      // Parameter types first, so `self.repo = repo` takes `repo: Repo`'s type.
      const params = new Map<string, string>();
      for (const p of def.childForFieldName("parameters")?.namedChildren ?? []) {
        if (p.type !== "typed_parameter" && p.type !== "typed_default_parameter") continue;
        const pname = p.type === "typed_parameter" ? p.namedChildren.find((c) => c.type === "identifier")?.text : p.childForFieldName("name")?.text;
        const ptype = p.childForFieldName("type");
        const tname = ptype ? typeNameOf(ptype) : null;
        if (pname && tname) params.set(pname, tname);
      }
      const defBody = def.childForFieldName("body");
      if (!defBody) continue;
      collectAssignedTypes(
        defBody,
        fieldMap,
        (left) => {
          if (left.type !== "attribute") return null;
          const obj = left.childForFieldName("object");
          return obj?.type === "identifier" && obj.text === "self" ? left.childForFieldName("attribute")?.text ?? null : null;
        },
        params
      );
    }
    types.byClass.set(cls.startIndex, map);
  }
  return map.get(field) ?? null;
}

function enclosingClassOfDef(def: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let current: Parser.SyntaxNode | null = def.parent;
  while (current) {
    if (current.type === "class_definition") return current;
    current = current.parent;
  }
  return null;
}

/**
 * Assignments in one function body (not nested defs or classes) that fix a name's class:
 * `x: Foo = ...`, `x = Foo(...)`, `x = param` for a typed param. First assignment wins.
 */
function collectAssignedTypes(
  body: Parser.SyntaxNode,
  map: Map<string, string>,
  targetName: (left: Parser.SyntaxNode) => string | null,
  params?: ReadonlyMap<string, string>,
  /** PY-6: types a right-hand side the rules below do not (a call through a return annotation). */
  typeOfRight?: (right: Parser.SyntaxNode) => string | null
): void {
  // Children are pushed in reverse so nodes pop in source order and "first assignment" means first in the file.
  const stack: Parser.SyntaxNode[] = [...body.namedChildren].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "function_definition" || node.type === "class_definition" || node.type === "lambda") continue;
    if (node.type === "assignment") {
      const left = node.childForFieldName("left");
      const name = left ? targetName(left) : null;
      if (name && !map.has(name)) {
        const annotation = node.childForFieldName("type");
        const right = node.childForFieldName("right");
        let tname = annotation ? typeNameOf(annotation) : null;
        if (!tname && right?.type === "call") {
          const callee = right.childForFieldName("function");
          const cname = callee ? typeNameOf(callee) : null;
          if (cname && /^[A-Z]/.test(cname)) tname = cname;
        }
        if (!tname && right?.type === "identifier" && params) tname = params.get(right.text) ?? null;
        if (!tname && right && typeOfRight) tname = typeOfRight(right);
        if (tname) map.set(name, tname);
      }
    }
    const kids = node.namedChildren;
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]!);
  }
}
