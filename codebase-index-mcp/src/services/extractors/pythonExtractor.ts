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
 *     `from ..c.r import R` → `..c.r.R`; `from x import *` → `x`. A from-import token names the module
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
import { PYTHON_BUILTIN_FUNCTIONS, PYTHON_BUILTIN_METHODS, PYTHON_STDLIB_MODULES } from "./pythonNoise.js";

type ImportedName = { original: string; fromModule: string };

/** What one file's imports bind, for reading its calls. */
type ImportScope = {
  /** Local names bound by `from m import n [as a]` → the original name and its module spec. */
  names: Map<string, ImportedName>;
  /** Receiver texts that name a module: `import a.b` → `a`, `a.b`; `import x as z` → `z`. */
  modules: Map<string, string>;
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

// ── Imports ─────────────────────────────────────────────────────────────────────────────────

function extractImports(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  edges: EdgeRecord[],
  moduleSymbolId: string
): ImportScope {
  const scope: ImportScope = { names: new Map(), modules: new Map() };
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
      specs.push(modulePart);
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

/** Names → class a receiver is known to hold, per function (parameters, constructor assignments). */
type TypeScopes = { byFunction: Map<number, Map<string, string>>; byClass: Map<number, Map<string, string>> };

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
  const types: TypeScopes = { byFunction: new Map(), byClass: new Map() };
  const seen = new Set<string>();
  const push = (fromId: string, token: string): void => {
    const key = `${fromId}\u0000${token}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ repoId: input.repoId, fromId, toId: `callee:${token}`, type: "CALLS" });
  };

  for (const call of root.descendantsOfType("call")) {
    const fn = call.childForFieldName("function");
    if (!fn) continue;
    const fromId = enclosingSymbolId(call, input, registered) ?? moduleSymbolId;
    const token = callToken(fn, call, scope, moduleFunctions, localClasses, types);
    if (token) push(fromId, token);

    // Best-effort references: a known function passed as an argument (`partial(f)`, `register(f)`,
    // `Thread(target=f)`) is invoked through that value.
    const args = call.childForFieldName("arguments");
    for (const arg of args?.namedChildren ?? []) {
      const value = arg.type === "keyword_argument" ? arg.childForFieldName("value") : arg;
      const ref = value ? referenceToken(value, scope, moduleFunctions) : null;
      if (ref) push(fromId, ref);
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
      if (ref) push(enclosingSymbolId(container, input, registered) ?? moduleSymbolId, ref);
    }
  }

  // A bare decorator `@register` calls `register` with the decorated function.
  for (const decorator of root.descendantsOfType("decorator")) {
    const expr = decorator.namedChildren[0];
    if (expr?.type !== "identifier" && expr?.type !== "attribute") continue;
    const token = callToken(expr, decorator, scope, moduleFunctions, localClasses, types);
    if (token) push(enclosingSymbolId(decorator, input, registered) ?? moduleSymbolId, token);
  }
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
    const typed = localType(site, name, types);
    if (typed) return `${typed}.${member}`;
    if (PYTHON_STDLIB_MODULES.has(name)) return null;
  }

  if (receiver.type === "attribute") {
    const inner = receiver.childForFieldName("object");
    const field = receiver.childForFieldName("attribute")?.text;
    if (inner?.type === "identifier" && inner.text === "self" && field) {
      const owner = enclosingClass(site);
      const typed = owner ? classFieldType(owner, field, types) : null;
      if (typed) return `${typed}.${member}`;
    }
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
    const params = fn.childForFieldName("parameters");
    for (const p of params?.namedChildren ?? []) {
      if (p.type !== "typed_parameter" && p.type !== "typed_default_parameter") continue;
      const pname = p.type === "typed_parameter" ? p.namedChildren.find((c) => c.type === "identifier")?.text : p.childForFieldName("name")?.text;
      const ptype = p.childForFieldName("type");
      const tname = ptype ? typeNameOf(ptype) : null;
      if (pname && tname) map.set(pname, tname);
    }
    const body = fn.childForFieldName("body");
    if (body) collectAssignedTypes(body, map, (left) => (left.type === "identifier" ? left.text : null));
    types.byFunction.set(fn.startIndex, map);
  }
  return map.get(name) ?? null;
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
  params?: ReadonlyMap<string, string>
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
        if (tname) map.set(name, tname);
      }
    }
    const kids = node.namedChildren;
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]!);
  }
}
