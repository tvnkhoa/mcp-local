/**
 * Python call-noise suppression: builtins and the methods of builtin types.
 *
 * A bare `callee:<name>` the resolver cannot bind is tagged an external boundary, so these lists do not
 * decide correctness — they keep a name-only guess from binding `items.append(x)` to a repo function
 * that happens to be called `append`. Data, not logic, like `jsCalls.ts`.
 */

/** Builtin functions and constructors: `len(x)`, `isinstance(...)`, `dict(...)`. */
export const PYTHON_BUILTIN_FUNCTIONS = new Set<string>([
  "abs", "aiter", "all", "anext", "any", "ascii", "bin", "bool", "breakpoint", "bytearray", "bytes",
  "callable", "chr", "classmethod", "compile", "complex", "delattr", "dict", "dir", "divmod",
  "enumerate", "eval", "exec", "filter", "float", "format", "frozenset", "getattr", "globals",
  "hasattr", "hash", "help", "hex", "id", "input", "int", "isinstance", "issubclass", "iter", "len",
  "list", "locals", "map", "max", "memoryview", "min", "next", "object", "oct", "open", "ord", "pow",
  "print", "property", "range", "repr", "reversed", "round", "set", "setattr", "slice", "sorted",
  "staticmethod", "str", "sum", "super", "tuple", "type", "vars", "zip", "__import__",
  // Builtin exceptions raised by name.
  "Exception", "BaseException", "ValueError", "TypeError", "KeyError", "IndexError", "RuntimeError",
  "NotImplementedError", "AttributeError", "AssertionError", "OSError", "IOError", "FileNotFoundError",
  "StopIteration", "LookupError", "PermissionError", "TimeoutError", "UnicodeDecodeError"
]);

/** Methods of str / list / dict / set / file / pathlib objects — a member call with these names is not a repo call. */
export const PYTHON_BUILTIN_METHODS = new Set<string>([
  // str
  "capitalize", "casefold", "center", "count", "encode", "decode", "endswith", "expandtabs", "find",
  "format", "format_map", "index", "isalnum", "isalpha", "isascii", "isdecimal", "isdigit",
  "isidentifier", "islower", "isnumeric", "isprintable", "isspace", "istitle", "isupper", "join",
  "ljust", "lower", "lstrip", "maketrans", "partition", "removeprefix", "removesuffix", "replace",
  "rfind", "rindex", "rjust", "rpartition", "rsplit", "rstrip", "split", "splitlines", "startswith",
  "strip", "swapcase", "title", "translate", "upper", "zfill",
  // list / dict / set
  "append", "extend", "insert", "remove", "pop", "clear", "copy", "sort", "reverse", "get", "items",
  "keys", "values", "update", "setdefault", "popitem", "fromkeys", "add", "discard", "union",
  "intersection", "difference", "symmetric_difference", "issubset", "issuperset",
  // file / io / pathlib
  "read", "readline", "readlines", "write", "writelines", "close", "flush", "seek", "tell",
  "exists", "is_file", "is_dir", "mkdir", "iterdir", "glob", "rglob", "read_text", "write_text",
  "read_bytes", "write_bytes", "resolve", "relative_to", "with_suffix", "with_name", "unlink",
  "open", "stat",
  // logging
  "debug", "info", "warning", "error", "exception", "critical", "log",
  // regex / misc
  "match", "fullmatch", "search", "sub", "subn", "findall", "finditer", "group", "groups", "groupdict",
  "__init__", "__enter__", "__exit__",
  // property accessors used as decorators: `@value.setter`
  "setter", "getter", "deleter"
]);

/** Receivers whose member calls are never repo calls: `os.path.join`, `json.loads`, `re.compile`. */
export const PYTHON_STDLIB_MODULES = new Set<string>([
  "os", "sys", "re", "json", "time", "datetime", "math", "random", "logging", "pathlib", "shutil",
  "subprocess", "itertools", "functools", "collections", "typing", "dataclasses", "enum", "abc",
  "asyncio", "uuid", "hashlib", "base64", "copy", "csv", "io", "textwrap", "string", "inspect",
  "warnings", "contextlib", "tempfile", "glob", "argparse", "pickle", "struct", "threading",
  "concurrent", "statistics", "operator", "types", "traceback", "unicodedata", "difflib", "html",
  "urllib", "http", "socket", "signal", "platform", "importlib", "pytest", "unittest", "mock"
]);

/**
 * PY-8b: a Python module symbol's signature when the module assigns `__all__`: this prefix, then the listed
 * names comma-joined, or `?` when the assignment is not a literal list (export set unknown, nothing filtered).
 */
export const PYTHON_DUNDER_ALL_PREFIX = "__all__:";

/**
 * PY-6b: hints a Python CALLS edge carries in `assignedExpression` (space-separated parts), read by
 * `rebuildPythonUntypedReceiverEdges`:
 *   - `pyrecv:<member>|<pos>:<param>,…` — a bare `<member>` token whose receiver is the caller's untyped parameter,
 *     or (`@<pos>:<param>`, row #16) a `self.<field>` its class's `__init__` sets from that untyped parameter;
 *   - `pyargs:<site>;<site>` — per call site, `#<i>=<Class>` / `<kw>=<Class>` / `…=^<pos>:<param>` argument types.
 */
export const PYTHON_RECEIVER_HINT = "pyrecv:";
export const PYTHON_ARGS_HINT = "pyargs:";

/**
 * MCP-ISSUE-128 row #16: a part of a Python CALLS edge's `assignedExpression` meaning "a bare token from
 * `obj.m()` on a receiver that is neither `self` / `cls` nor a module". `resolveIntraFileEdges` does not bind
 * such a token to a same-file `m` (nothing proves the receiver holds that file's class) and strips the mark, so
 * it never reaches the store; the call pass binds the token, flagged as an untyped receiver.
 */
export const PYTHON_OBJECT_RECEIVER_MARK = "pyobj";
