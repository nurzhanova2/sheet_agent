/**
 * §16 — shut the bridge, and build the restricted namespace user code will get.
 *
 * `sys.modules` poisoning closes `importlib.import_module("js")`; the guarded
 * `__import__` — installed only in the user namespace — closes `import js`,
 * `from js import fetch` and `__import__("js")`. Both are needed: neither
 * alone covers all four routes.
 */
export const HARDEN_SOURCE = String.raw`
import sys, builtins

# The JS bridge and the loader that hands it back. Poisoned rather than
# deleted: a None entry makes importlib refuse rather than re-import.
for _m in ("js", "pyodide_js", "pyodide", "pyodide.ffi", "pyodide.http", "pyodide.webloop"):
    sys.modules[_m] = None

# §15 — an ALLOW-list, not a block-list. A block-list is a promise to have
# thought of every module in the standard library; this is a promise about the
# handful an analytical script legitimately needs.
_SA_ALLOWED_ROOTS = frozenset({
    "math", "cmath", "statistics", "json", "itertools", "functools", "operator",
    "collections", "heapq", "bisect", "array", "dataclasses", "enum", "decimal",
    "fractions", "numbers", "random", "re", "datetime", "time", "calendar",
    "typing", "copy", "abc", "string", "textwrap", "unicodedata", "warnings",
    "numpy", "pandas", "scipy", "sklearn", "joblib", "threadpoolctl", "pytz",
    "dateutil", "six", "packaging", "zoneinfo",
})

_sa_real_import = builtins.__import__

def _sa_guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".")[0]
    if level and level > 0:
        raise ImportError("relative imports are not available in the analytical sandbox")
    if root not in _SA_ALLOWED_ROOTS:
        raise ImportError("module '%s' is not available in the analytical sandbox" % name)
    return _sa_real_import(name, globals, locals, fromlist, level)

# Exactly what an analytical script needs, and nothing that executes text,
# opens a file, or walks the object graph. Absent names are absent: user code
# does not get a None it could test for, it gets a NameError.
_SA_SAFE_BUILTIN_NAMES = (
    "abs", "all", "any", "ascii", "bin", "bool", "bytes", "callable", "chr",
    "complex", "dict", "divmod", "enumerate", "filter", "float", "format",
    "frozenset", "hash", "hex", "id", "int", "isinstance", "issubclass", "iter",
    "len", "list", "map", "max", "min", "next", "object", "oct", "ord", "pow",
    "print", "range", "repr", "reversed", "round", "set", "slice", "sorted",
    "str", "sum", "tuple", "type", "zip", "hasattr",
    # class and exception machinery a script legitimately uses
    "__build_class__", "property", "staticmethod", "classmethod", "super",
    "Exception", "BaseException", "ValueError", "TypeError", "KeyError",
    "IndexError", "AttributeError", "ZeroDivisionError", "ArithmeticError",
    "RuntimeError", "StopIteration", "NotImplementedError", "ImportError",
    "True", "False", "None",
)

_SA_SAFE_BUILTINS = {}
for _n in _SA_SAFE_BUILTIN_NAMES:
    if hasattr(builtins, _n):
        _SA_SAFE_BUILTINS[_n] = getattr(builtins, _n)
_SA_SAFE_BUILTINS["__import__"] = _sa_guarded_import
_SA_SAFE_BUILTINS["__name__"] = "sandbox_analysis"
`;

/**
 * §15 — the AST contract, expressed with Python's own parser.
 *
 * Deliberately not a regex over the source (§15 says so): `getattr(obj, "ev" +
 * "al")` defeats every regex anyone will write, and an AST walk sees the call
 * either way. What an AST cannot see is a string assembled at runtime — which
 * is exactly why the restricted namespace has no `eval` to hand it to.
 */
export const VALIDATOR_SOURCE = String.raw`
import ast as _sa_ast, json as _sa_json

_SA_V_ALLOWED = frozenset({
    "math", "cmath", "statistics", "json", "itertools", "functools", "operator",
    "collections", "heapq", "bisect", "array", "dataclasses", "enum", "decimal",
    "fractions", "numbers", "random", "re", "datetime", "time", "calendar",
    "typing", "copy", "abc", "string", "textwrap", "unicodedata", "warnings",
    "numpy", "pandas", "scipy", "sklearn", "joblib", "threadpoolctl", "pytz",
    "dateutil", "six", "packaging", "zoneinfo",
})

# Names whose appearance as a call is a request for a denied capability.
_SA_V_CALLS = frozenset({
    "eval", "exec", "compile", "open", "__import__", "input", "breakpoint",
    "globals", "locals", "vars", "memoryview", "getattr", "setattr", "delattr",
    "exit", "quit", "__build_class__",
})

_SA_V_CAPABILITY_MODULES = {
    "requests": "NETWORK", "httpx": "NETWORK", "urllib": "NETWORK", "urllib2": "NETWORK",
    "urllib3": "NETWORK", "http": "NETWORK", "aiohttp": "NETWORK", "socket": "NETWORK",
    "socketserver": "NETWORK", "ssl": "NETWORK", "ftplib": "NETWORK", "smtplib": "NETWORK",
    "poplib": "NETWORK", "imaplib": "NETWORK", "telnetlib": "NETWORK", "nntplib": "NETWORK",
    "xmlrpc": "NETWORK", "webbrowser": "NETWORK", "websocket": "NETWORK",
    "websockets": "NETWORK", "asyncio": "NETWORK", "selectors": "NETWORK",
    "os": "PROCESS", "subprocess": "PROCESS", "multiprocessing": "PROCESS",
    "pty": "PROCESS", "signal": "PROCESS", "ctypes": "PROCESS", "sys": "PROCESS",
    "platform": "PROCESS", "importlib": "PROCESS", "runpy": "PROCESS",
    "pickle": "PROCESS", "marshal": "PROCESS", "shelve": "PROCESS", "dbm": "PROCESS",
    "code": "PROCESS", "builtins": "PROCESS", "gc": "PROCESS", "inspect": "PROCESS",
    "types": "PROCESS", "traceback": "PROCESS", "threading": "PROCESS",
    "pathlib": "FILESYSTEM", "shutil": "FILESYSTEM", "tempfile": "FILESYSTEM",
    "glob": "FILESYSTEM", "fileinput": "FILESYSTEM", "io": "FILESYSTEM",
    "linecache": "FILESYSTEM", "sqlite3": "FILESYSTEM", "zipfile": "FILESYSTEM",
    "tarfile": "FILESYSTEM", "gzip": "FILESYSTEM", "bz2": "FILESYSTEM",
    "lzma": "FILESYSTEM", "csv": "FILESYSTEM", "configparser": "FILESYSTEM",
    "js": "BRIDGE", "pyodide": "BRIDGE", "pyodide_js": "BRIDGE", "micropip": "BRIDGE",
}

_SA_V_IO_METHODS = frozenset({
    "read_csv", "read_excel", "read_json", "read_html", "read_pickle", "read_sql",
    "read_sql_query", "read_sql_table", "read_parquet", "read_feather", "read_orc",
    "read_stata", "read_sas", "read_spss", "read_hdf", "read_xml", "read_gbq",
    "read_table", "read_clipboard", "read_fwf",
    "to_csv", "to_excel", "to_json", "to_pickle", "to_sql", "to_parquet",
    "to_feather", "to_orc", "to_stata", "to_hdf", "to_xml", "to_clipboard", "to_gbq",
    "read_text", "read_bytes", "write_text", "write_bytes",
    "urlopen", "urlretrieve", "urlcleanup", "getaddrinfo", "gethostbyname",
    "create_connection", "socketpair",
    "system", "popen", "startfile", "getoutput", "getstatusoutput",
    "check_output", "check_call", "execv", "execve", "execl", "execlp", "execvp",
    "spawn", "spawnv", "spawnl", "fork", "forkpty", "killpg",
})

# The classic escape chain: ().__class__.__bases__[0].__subclasses__(). Every
# link is an attribute nothing in an analytical script needs.
_SA_V_ATTRS = frozenset({
    "__class__", "__bases__", "__base__", "__subclasses__", "__mro__",
    "__globals__", "__code__", "__closure__", "__builtins__", "__loader__",
    "__spec__", "__dict__", "__getattribute__", "__reduce__", "__reduce_ex__",
    "__init_subclass__", "__self__", "__func__", "__wrapped__", "gi_frame",
    "cr_frame", "f_globals", "f_builtins", "f_locals",
})

def _sa_locally_bound(tree):
    names = set()
    for node in _sa_ast.walk(tree):
        if isinstance(node, _sa_ast.Name) and isinstance(node.ctx, (_sa_ast.Store, _sa_ast.Del)):
            names.add(node.id)
        elif isinstance(node, (_sa_ast.FunctionDef, _sa_ast.AsyncFunctionDef, _sa_ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, _sa_ast.arg):
            names.add(node.arg)
        elif isinstance(node, _sa_ast.ExceptHandler) and node.name:
            names.add(node.name)
        elif isinstance(node, _sa_ast.alias):
            names.add(node.asname or node.name.split(".")[0])
    return names


def _sa_capability_bindings(tree):
    aliases = {}
    members = {}
    for node in _sa_ast.walk(tree):
        if isinstance(node, _sa_ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                capability = _SA_V_CAPABILITY_MODULES.get(root)
                if capability is not None:
                    aliases[alias.asname or root] = capability
        elif isinstance(node, _sa_ast.ImportFrom):
            root = (node.module or "").split(".")[0]
            capability = _SA_V_CAPABILITY_MODULES.get(root)
            if capability is not None:
                for alias in node.names:
                    members[alias.asname or alias.name] = capability
    return aliases, members


def _sa_receiver_capability(name, aliases, bound):
    if name in aliases:
        return aliases[name]
    if name in bound:
        return None
    return _SA_V_CAPABILITY_MODULES.get(name)


def _sa_violations(source):
    out = []
    try:
        tree = _sa_ast.parse(source)
    except SyntaxError as exc:
        return [{"code": "SYNTAX", "detail": str(exc), "line": exc.lineno or 0}]
    bound = _sa_locally_bound(tree)
    aliases, members = _sa_capability_bindings(tree)

    for node in _sa_ast.walk(tree):
        if isinstance(node, _sa_ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root not in _SA_V_ALLOWED:
                    out.append({"code": "IMPORT", "detail": alias.name, "line": node.lineno})
        elif isinstance(node, _sa_ast.ImportFrom):
            if node.level and node.level > 0:
                out.append({"code": "IMPORT", "detail": "relative import", "line": node.lineno})
            else:
                root = (node.module or "").split(".")[0]
                if root not in _SA_V_ALLOWED:
                    out.append({"code": "IMPORT", "detail": node.module or "?", "line": node.lineno})
        elif isinstance(node, _sa_ast.Call):
            fn = node.func
            if isinstance(fn, _sa_ast.Name):
                if fn.id in _SA_V_CALLS:
                    out.append({"code": "CALL", "detail": fn.id, "line": node.lineno})
                elif fn.id in members:
                    out.append({"code": members[fn.id], "detail": fn.id, "line": node.lineno})
            elif isinstance(fn, _sa_ast.Attribute):
                if fn.attr in _SA_V_CALLS:
                    out.append({"code": "CALL", "detail": fn.attr, "line": node.lineno})
                elif fn.attr in _SA_V_IO_METHODS:
                    out.append({"code": "IO", "detail": fn.attr, "line": node.lineno})
        elif isinstance(node, _sa_ast.Attribute):
            if node.attr in _SA_V_ATTRS:
                out.append({"code": "ATTR", "detail": node.attr, "line": node.lineno})
            elif isinstance(node.value, _sa_ast.Name):
                capability = _sa_receiver_capability(node.value.id, aliases, bound)
                if capability is not None:
                    out.append({"code": capability, "detail": node.value.id + "." + node.attr, "line": node.lineno})
        elif isinstance(node, _sa_ast.Name):
            if node.id in _SA_V_ATTRS:
                out.append({"code": "NAME", "detail": node.id, "line": node.lineno})
    return out

def __sa_validate(source):
    return _sa_json.dumps(_sa_violations(source))
`;

/**
 * §27/§28 — run accepted code and collect a STRUCTURED envelope.
 *
 * The contract handed to generated code is deliberately small: `data` (a
 * DataFrame with NaN where the workbook had no observation, never a
 * substituted zero — §23), `meta` describing each column including how many
 * values are missing versus recorded zero (§25), and `RESULT` to fill.
 *
 * stdout is captured but is NOT the result (§27). A script that prints its
 * findings and assigns nothing has produced nothing, and is told so.
 */
export const RUNNER_SOURCE = String.raw`
import json as _sa_j, math as _sa_math, io as _sa_io, sys as _sa_sys
import numpy as _sa_np
import pandas as _sa_pd

def _sa_jsonable(value):
    if value is None:
        return None
    if isinstance(value, (bool, _sa_np.bool_)):
        return bool(value)
    if isinstance(value, (int, _sa_np.integer)):
        return int(value)
    if isinstance(value, (float, _sa_np.floating)):
        f = float(value)
        # §29 — no NaN or Infinity may leak into a result envelope.
        return None if (_sa_math.isnan(f) or _sa_math.isinf(f)) else f
    if isinstance(value, str):
        return value
    if isinstance(value, _sa_pd.Timestamp):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): _sa_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_sa_jsonable(v) for v in value]
    if isinstance(value, _sa_np.ndarray):
        return [_sa_jsonable(v) for v in value.tolist()]
    if isinstance(value, _sa_pd.Series):
        return [_sa_jsonable(v) for v in value.tolist()]
    if isinstance(value, _sa_pd.DataFrame):
        return {
            "columns": [str(c) for c in value.columns],
            "rows": [[_sa_jsonable(v) for v in row] for row in value.itertuples(index=False)],
        }
    return str(value)

def _sa_as_table(name, value):
    if isinstance(value, _sa_pd.DataFrame):
        frame = value.reset_index() if value.index.name else value
        return {
            "name": name,
            "columns": [str(c) for c in frame.columns],
            "rows": [[_sa_jsonable(v) for v in row] for row in frame.itertuples(index=False)],
        }
    if isinstance(value, dict) and "columns" in value and "rows" in value:
        return {
            "name": name,
            "columns": [str(c) for c in value["columns"]],
            "rows": [[_sa_jsonable(v) for v in row] for row in value["rows"]],
        }
    return None

def _sa_numbers(mapping):
    # §19 - only real, finite numbers count as a measurement. A NaN
    # silhouette is not evidence that a method ran, and True is not a metric.
    out = {}
    for key, value in (mapping or {}).items():
        if isinstance(value, bool):
            continue
        number = _sa_jsonable(value)
        if isinstance(number, (int, float)):
            out[str(key)] = number
    return out


def _sa_comparison(result):
    # §20 - the method comparison, if the script produced one. Accepts the
    # snake_case the prompt asks for and the camelCase a model reaches for
    # anyway; the shape it lands in is the TypeScript one either way.
    raw = result.get("method_comparison", result.get("methodComparison"))
    if not isinstance(raw, dict):
        return None
    methods = []
    for entry in (raw.get("methods") or []):
        if not isinstance(entry, dict):
            continue
        methods.append({
            "name": str(entry.get("name", "")),
            "parameters": _sa_jsonable(entry.get("parameters") or {}),
            "metrics": _sa_numbers(entry.get("metrics")),
            "warnings": [str(w) for w in (entry.get("warnings") or [])],
        })
    criteria = raw.get("selection_criteria", raw.get("selectionCriteria"))
    if criteria is None:
        criteria = raw.get("criteria") or []
    selected = raw.get("selected", raw.get("selected_method", raw.get("selectedMethod", "")))
    return {
        "methods": methods,
        "selectedMethod": str(selected or ""),
        "selectionCriteria": [str(c) for c in criteria],
        "selectionEvidence": _sa_numbers(raw.get("selection_evidence", raw.get("selectionEvidence"))),
    }


_SA_ENVELOPE_KEYS = (
    "tables", "scalars", "series", "groups", "models", "diagnostics",
    "findings", "findingsCandidates", "method", "method_comparison",
    "methodComparison", "preprocessing", "warnings", "artifacts",
)


def _sa_unwrap(result):
    # Stage 27.x.1 §36 - the right analysis, one level too deep.
    #
    # RESULT = {"analysis": {"scalars": {...}, "method": {...}}} computed
    # everything correctly and wrapped it. Collecting that yields an empty
    # envelope, the coverage check reports "did not return the requested
    # scalar", and a whole code generation is spent re-deriving numbers that
    # were already right.
    #
    # Unwrapped only when the choice is FORCED, which is the same rule the
    # TypeScript normalizer runs on (§14): the outer dict names nothing this
    # envelope knows, and exactly one of its values is a dict that does. Two
    # such candidates is a judgement, and a judgement belongs in the repair
    # loop, not here.
    if not isinstance(result, dict):
        return result
    if any(key in result for key in _SA_ENVELOPE_KEYS):
        return result
    inner = [v for v in result.values()
             if isinstance(v, dict) and any(key in v for key in _SA_ENVELOPE_KEYS)]
    return inner[0] if len(inner) == 1 else result


def _sa_collect(result, max_rows):
    if not isinstance(result, dict):
        raise ValueError("RESULT must be a dict; got %s" % type(result).__name__)
    result = _sa_unwrap(result)

    tables = []
    raw = result.get("tables") or {}
    pairs = raw.items() if isinstance(raw, dict) else [("table_%d" % i, t) for i, t in enumerate(raw)]
    for name, value in pairs:
        table = _sa_as_table(str(name), value)
        if table is not None:
            table["rows"] = table["rows"][:max_rows]
            tables.append(table)

    series = []
    for name, value in (result.get("series") or {}).items():
        if isinstance(value, _sa_pd.Series):
            series.append({
                "name": str(name),
                "index": [_sa_jsonable(i) for i in value.index.tolist()][:max_rows],
                "values": [_sa_jsonable(v) for v in value.tolist()][:max_rows],
            })
        elif isinstance(value, dict) and "index" in value and "values" in value:
            series.append({
                "name": str(name),
                "index": [_sa_jsonable(i) for i in value["index"]][:max_rows],
                "values": [_sa_jsonable(v) for v in value["values"]][:max_rows],
            })

    groups = []
    for group in (result.get("groups") or []):
        if isinstance(group, dict):
            groups.append({
                "label": str(group.get("label", "")),
                "members": [str(m) for m in (group.get("members") or [])],
                "profile": {str(k): _sa_jsonable(v) for k, v in (group.get("profile") or {}).items()},
            })

    candidates = []
    for cand in (result.get("findings") or result.get("findingsCandidates") or []):
        if isinstance(cand, dict):
            candidates.append({
                "kind": str(cand.get("kind", "observation")),
                "subject": str(cand.get("subject", "")),
                "values": {str(k): _sa_jsonable(v) for k, v in (cand.get("values") or {}).items()},
                "supporting": _sa_jsonable(cand.get("supporting") or {}),
            })

    comparison = _sa_comparison(result)

    method = result.get("method")
    if isinstance(method, dict):
        method = {
            "name": str(method.get("name", "")),
            "parameters": _sa_jsonable(method.get("parameters") or {}),
            "randomState": _sa_jsonable(method.get("random_state", method.get("randomState"))),
        }
    else:
        method = None

    return {
        "status": "ok",
        "method": method,
        "methodComparison": comparison,
        "tables": tables,
        "scalars": {str(k): _sa_jsonable(v) for k, v in (result.get("scalars") or {}).items()},
        "series": series,
        "groups": groups,
        "models": [_sa_jsonable(m) for m in (result.get("models") or [])],
        "diagnostics": _sa_jsonable(result.get("diagnostics") or {}),
        "findingsCandidates": candidates,
        "warnings": [str(w) for w in (result.get("warnings") or [])],
        "preprocessing": _sa_jsonable(result.get("preprocessing")) if result.get("preprocessing") else None,
        "artifacts": [_sa_jsonable(a) for a in (result.get("artifacts") or [])],
    }

_SA_NUMERIC_TYPES = ("amount", "count", "percent_fraction", "percent_scaled", "ratio", "index")
_SA_ENTITY_TYPES = ("metric_label", "entity_id", "category", "text")

def __sa_namespace(dataset_json):
    payload = _sa_j.loads(dataset_json)
    names = [c["name"] for c in payload["columns"]]
    # §23 — a missing observation arrives as null and becomes NaN. It is never
    # filled, here or anywhere upstream: once a gap is 0, no policy declared
    # later can tell it from a recorded zero.
    frame = _sa_pd.DataFrame(payload["rows"], columns=names)
    for spec in payload["columns"]:
        if spec["semanticType"] in _SA_NUMERIC_TYPES:
            frame[spec["name"]] = _sa_pd.to_numeric(frame[spec["name"]], errors="coerce")

    # Stage 27.x §3 — PREPARED VIEWS, from the schema and nothing else.
    #
    # data is unchanged and still authoritative: same columns, same order,
    # same index, gaps still NaN. What is added beside it is the split the
    # generated code kept getting wrong by hand. Nearly half of every failed
    # attempt in the live runs was one mistake — a numeric operation reaching
    # the text label column — wearing four different tracebacks (isnan not
    # supported, lstsq on dtype('O'), an unalignable boolean mask, fillna
    # on an ndarray).
    #
    # The split comes from semanticType, which schema induction already
    # decided, NEVER from column names: a table may label its subjects
    # Product, Manager, Region, Bank or Показатель, and a name-matching rule
    # would work on this benchmark and fail on the next workbook.
    #
    # All three views keep the ORIGINAL row index, so a mask built on one
    # aligns with the others and with data — that is what makes the
    # index-alignment error structurally impossible rather than discouraged.
    #
    # §4 — dtype only. Nothing here fills, interpolates, scales, drops or
    # otherwise decides anything analytical; NaN stays NaN all the way into X.
    numeric_columns = [c["name"] for c in payload["columns"] if c["semanticType"] in _SA_NUMERIC_TYPES]
    entity_columns = [c["name"] for c in payload["columns"] if c["semanticType"] in _SA_ENTITY_TYPES]
    numeric_data = frame[numeric_columns].astype("float64") if numeric_columns else _sa_pd.DataFrame(index=frame.index)
    entity_data = frame[entity_columns] if entity_columns else _sa_pd.DataFrame(index=frame.index)
    matrix = numeric_data.to_numpy(dtype="float64") if numeric_columns else _sa_np.empty((len(frame), 0), dtype="float64")

    namespace = {
        "data": frame,
        "numeric_data": numeric_data,
        "entity_data": entity_data,
        "X": matrix,
        "numeric_columns": numeric_columns,
        "entity_columns": entity_columns,
        "meta": payload["columns"],
        "periods": payload.get("periods"),
        "pd": _sa_pd,
        "np": _sa_np,
        "RESULT": {},
        # §16 — the restriction lives HERE, on the untrusted code's own
        # builtins, not on the global module every library shares.
        "__builtins__": _SA_SAFE_BUILTINS,
    }
    return namespace


def __sa_run(source, dataset_json, max_rows):
    # The one-shot path, unchanged in behaviour: build a namespace, run the
    # whole program in it, collect, discard. Stage 27.2 adds __sa_step beside
    # this rather than replacing it, so every existing caller and every
    # existing test keeps the semantics it was written against (§2).
    namespace = __sa_namespace(dataset_json)

    buffer = _sa_io.StringIO()
    real_stdout = _sa_sys.stdout
    _sa_sys.stdout = buffer
    try:
        _sa_exec(_sa_compile(source, "<analysis>", "exec"), namespace)
    finally:
        _sa_sys.stdout = real_stdout

    result = namespace.get("RESULT")
    if not result:
        raise ValueError("the script assigned nothing to RESULT; stdout is not an analytical result")
    envelope = _sa_collect(result, max_rows)
    envelope["stdout"] = buffer.getvalue()[:4000]
    return _sa_j.dumps(envelope)


# =====================================================================
# Stage 27.2 §13-§17, §22-§28 - the iterative agentic interface.
#
# Everything above executes ONE complete analysis and throws the namespace
# away. That shape forced the model to write a whole program before it could
# learn anything about the data, and made a NameError on line 40 cost the
# other 39 lines. Below is the same sandbox addressed one step at a time:
# the namespace survives between steps of a single turn, so step 2 can use
# what step 1 built, and a failure returns an OBSERVATION the agent reads
# rather than an exception that ends the turn (§16).
#
# The security properties are untouched (§47). Each step still arrives
# pre-validated by the same AST gate, still runs under _SA_SAFE_BUILTINS,
# and the session holds nothing a single execution could not already reach.
# What is new is the lifetime of a dict, bounded by one analytical turn.
# =====================================================================

_SA_SESSIONS = {}


def _sa_shape_of(value):
    # High signal, no contents (§17/§28). A shape and a dtype are what the
    # next line of code depends on; the rows are what the agent asks for
    # explicitly if it wants them.
    try:
        if isinstance(value, _sa_pd.DataFrame):
            return {"type": "DataFrame", "shape": list(value.shape),
                    "columns": [str(c) for c in value.columns][:40]}
        if isinstance(value, _sa_pd.Series):
            return {"type": "Series", "shape": [int(value.shape[0])], "dtype": str(value.dtype)}
        if isinstance(value, _sa_np.ndarray):
            return {"type": "ndarray", "shape": list(value.shape), "dtype": str(value.dtype)}
        if isinstance(value, (list, tuple)):
            return {"type": type(value).__name__, "shape": [len(value)]}
        if isinstance(value, dict):
            return {"type": "dict", "keys": [str(k) for k in list(value.keys())[:20]]}
        if isinstance(value, (int, float, bool, str)):
            return {"type": type(value).__name__, "value": _sa_jsonable(value)}
        return {"type": type(value).__name__}
    except Exception:
        return {"type": "unknown"}


_SA_HIDDEN = ("pd", "np", "meta", "periods", "RESULT", "table", "result", "__builtins__",
              "data", "numeric_data", "entity_data", "X", "numeric_columns", "entity_columns")


def _sa_environment(namespace):
    # §28 - what exists right now, so the agent never has to guess a name.
    # The prepared views are omitted: they are in every prompt already, and
    # repeating them each step is context spent on something known.
    out = {}
    for name, value in namespace.items():
        if name.startswith("_") or name in _SA_HIDDEN:
            continue
        out[name] = _sa_shape_of(value)
        if len(out) >= 25:
            break
    return out


class _SaTable:
    # §22/§23/§24 - the ergonomic facade. The old names still exist and still
    # work; this is a second way to reach the same objects, named so the agent
    # does not have to remember which of entity_data / entity_df is real.
    # NAMING HALLUCINATION WAS A MEASURED FAILURE (§27), not a hypothetical:
    # "NameError: name 'entity_df' is not defined. Did you mean: 'entity_data'?"
    def __init__(self, frame, numeric, entities, matrix, columns_meta):
        self.raw = frame
        self.numeric = numeric
        self.entities = entities
        self.matrix = matrix
        self.schema = [
            {"name": c["name"], "role": c["semanticType"],
             "missing": int(c.get("missingCount") or 0), "zeros": int(c.get("zeroCount") or 0)}
            for c in columns_meta
        ]

    def info(self):
        missing = {c["name"]: c["missing"] for c in self.schema if c["missing"] > 0}
        return {
            "shape": list(self.raw.shape),
            "entityColumns": [c["name"] for c in self.schema if c["role"] in _SA_ENTITY_TYPES],
            "numericColumns": [c["name"] for c in self.schema if c["role"] in _SA_NUMERIC_TYPES],
            "missing": missing,
            "matrixShape": list(self.matrix.shape),
        }


class _SaResult:
    # §25/§26 - a canonical emission helper. It reduces arbitrary dictionary
    # naming; it does NOT bypass anything. Everything emitted here lands in
    # the same RESULT dict the validators, the normalizer, the lineage and the
    # numeric verifier already read, and is checked exactly as before.
    _SHAPES = {
        "table": "tables", "series": "series", "scalar": "scalars",
        "group": "groups", "model": "models", "diagnostic": "diagnostics",
    }

    def __init__(self, sink):
        self._sink = sink

    def emit(self, kind, name=None, value=None, rows=None, columns=None):
        key = self._SHAPES.get(kind)
        if key is None:
            raise ValueError("unknown result kind %r; use one of %s" % (kind, sorted(self._SHAPES)))
        if key == "groups":
            self._sink.setdefault("groups", []).append(value)
        elif key == "models":
            self._sink.setdefault("models", []).append(value)
        elif key == "tables":
            payload = value if value is not None else {"columns": columns, "rows": rows}
            self._sink.setdefault("tables", {})[str(name)] = payload
        else:
            if name is None:
                raise ValueError("emit(%r) needs a name" % kind)
            self._sink.setdefault(key, {})[str(name)] = value
        return name

    def method(self, name, parameters=None, random_state=None):
        self._sink["method"] = {"name": name, "parameters": parameters or {}, "random_state": random_state}

    def missing_policy(self, method, rationale, affected_rows=0, affected_columns=None):
        self._sink.setdefault("preprocessing", {})["missingValuePolicy"] = {
            "method": method, "rationale": rationale,
            "affectedRows": int(affected_rows), "affectedColumns": list(affected_columns or []),
        }


def _sa_new_session(dataset_json):
    namespace = __sa_namespace(dataset_json)
    namespace["table"] = _SaTable(
        namespace["data"], namespace["numeric_data"], namespace["entity_data"],
        namespace["X"], namespace["meta"],
    )
    namespace["result"] = _SaResult(namespace["RESULT"])
    return namespace


_SA_PREPARED = ("data", "numeric_data", "entity_data", "X", "numeric_columns", "entity_columns", "table", "result")


def _sa_emitted_refs(namespace):
    # Every name a COMPLETE could legitimately point at, as the session
    # currently holds them. Mirrors availableResultRefs on the host side.
    sink = namespace.get("RESULT") or {}
    refs = []
    try:
        for key in ("tables", "series", "scalars", "diagnostics"):
            value = sink.get(key)
            if isinstance(value, dict):
                refs.extend(str(name) for name in value.keys())
        for key in ("groups", "models"):
            value = sink.get(key)
            if isinstance(value, list):
                for item in value:
                    if isinstance(item, dict):
                        label = item.get("label") or item.get("name")
                        if label is not None:
                            refs.append(str(label))
    except Exception:
        return []
    return refs[:40]


def _sa_prepared_shapes(namespace):
    # The names that ALWAYS exist, each with the one fact the next line of
    # code depends on. table and result have no shape and say what they are
    # instead, so no name in the list looks like it is missing something.
    #
    # NOTE: no backticks anywhere in this file. This whole module is a TS
    # template literal, and one backtick ends it.
    out = []
    for name in _SA_PREPARED:
        value = namespace.get(name)
        if value is None:
            out.append(name)
            continue
        info = _sa_shape_of(value)
        shape = info.get("shape")
        if shape:
            out.append("%s: %s (%s)" % (name, info.get("type", "?"), ", ".join(str(n) for n in shape)))
        elif name in ("table", "result"):
            out.append("%s: %s" % (name, type(value).__name__.lstrip("_")))
        else:
            out.append("%s: %s" % (name, info.get("type", "?")))
    return out


def __sa_step(session_id, source, dataset_json, max_rows):
    # §16 - THE ENTIRE POINT: a Python error is a return value here, not a
    # raised exception. The agent reads it and decides what to do next.
    namespace = _SA_SESSIONS.get(session_id)
    if namespace is None:
        namespace = _sa_new_session(dataset_json)
        _SA_SESSIONS[session_id] = namespace

    buffer = _sa_io.StringIO()
    real_stdout = _sa_sys.stdout
    _sa_sys.stdout = buffer
    try:
        _sa_exec(_sa_compile(source, "<step>", "exec"), namespace)
    except BaseException as exc:
        _sa_sys.stdout = real_stdout
        # §17 - a short, high-signal observation. Not a traceback dump: the
        # failing line, the type, the message, and what actually exists.
        line = None
        try:
            tb = exc.__traceback__
            while tb is not None:
                if tb.tb_frame.f_code.co_filename == "<step>":
                    line = tb.tb_lineno
                tb = tb.tb_next
        except Exception:
            line = None
        lines = source.split(chr(10))
        return _sa_j.dumps({
            "status": "error",
            "errorType": type(exc).__name__,
            "message": str(exc)[:400],
            "line": line,
            "failingLine": (lines[line - 1].strip()[:200] if line and 0 < line <= len(lines) else None),
            "stdout": buffer.getvalue()[:1000],
            "available": _sa_environment(namespace),
            # §30 - "the observation includes relevant shapes". A list of NAMES
            # is not shapes, and a shape mismatch is precisely the failure that
            # cannot be fixed without them: "Item wrong length 12 instead of
            # 15" says which numbers disagree and nothing about which variable
            # holds which. So the prepared views report their shapes too, and
            # only on the error path, where the agent needs them.
            "prepared": _sa_prepared_shapes(namespace),
        })
    finally:
        _sa_sys.stdout = real_stdout

    return _sa_j.dumps({
        "status": "ok",
        "stdout": buffer.getvalue()[:3000],
        "available": _sa_environment(namespace),
        "hasResult": bool(namespace.get("RESULT")),
        # The NAMES, not a boolean. A boolean is what this used to return, and
        # the observation therefore said "Emitted results: none" after a
        # successful result.emit - so the agent, told its work had not landed,
        # emitted again, and eventually tried to finish from inside Python.
        "emitted": _sa_emitted_refs(namespace),
    })


def __sa_finish(session_id, max_rows):
    # Collect the envelope the session accumulated, through the SAME
    # _sa_collect every non-iterative analysis goes through (§26).
    namespace = _SA_SESSIONS.get(session_id)
    if namespace is None:
        raise ValueError("no analytical session is open")
    result = namespace.get("RESULT")
    if not result:
        raise ValueError("the session assigned nothing to RESULT")
    envelope = _sa_collect(result, max_rows)
    envelope["stdout"] = ""
    return _sa_j.dumps(envelope)


def __sa_inspect(session_id, dataset_json):
    # §13 - look before computing, without serialising the whole frame.
    namespace = _SA_SESSIONS.get(session_id)
    if namespace is None:
        namespace = _sa_new_session(dataset_json)
        _SA_SESSIONS[session_id] = namespace
    info = namespace["table"].info()
    info["schema"] = namespace["table"].schema
    info["preview"] = [
        [_sa_jsonable(v) for v in row]
        for row in namespace["data"].head(3).itertuples(index=False)
    ]
    info["available"] = _sa_environment(namespace)
    return _sa_j.dumps(info)


def _sa_rows_of(frame, limit):
    # A bounded rectangle of a frame or series, as plain JSON scalars.
    head = frame.head(limit)
    if isinstance(head, _sa_pd.Series):
        return {"columns": [str(head.name or "value")],
                "rows": [[_sa_jsonable(v)] for v in head.tolist()]}
    return {"columns": [str(c) for c in head.columns],
            "rows": [[_sa_jsonable(v) for v in row] for row in head.itertuples(index=False)]}


def __sa_look(session_id, target, variable, dataset_json, limit):
    # Stage 27.2A §11/§12 - LOOK at one bounded thing.
    #
    # Every target here is capped in rows and columns by construction. There
    # is deliberately no target that serialises a whole frame: §11 forbids
    # arbitrary dumps, and an agent that wants an aggregate should compute it
    # in a step rather than read the table and do arithmetic in prose.
    #
    # An unknown name is NOT an exception. It is the same kind of observation
    # a NameError is (§16): the agent asked about something that is not there,
    # and what it needs back is the list of what IS.
    namespace = _SA_SESSIONS.get(session_id)
    if namespace is None:
        namespace = _sa_new_session(dataset_json)
        _SA_SESSIONS[session_id] = namespace

    cap = max(1, min(int(limit), 20))
    out = {"target": target, "status": "ok"}
    try:
        if target in ("table.info", "table.schema", "table.head"):
            tbl = namespace["table"]
            if target == "table.schema":
                out["schema"] = tbl.schema
            elif target == "table.head":
                out.update(_sa_rows_of(namespace["data"], min(cap, 10)))
            else:
                out.update(tbl.info())
            return _sa_j.dumps(out)

        if target == "result.preview":
            emitted = namespace.get("RESULT") or {}
            preview = {}
            for kind, value in emitted.items():
                if isinstance(value, dict):
                    preview[kind] = [str(k) for k in list(value.keys())[:20]]
                elif isinstance(value, list):
                    preview[kind] = [
                        str(item.get("name") or item.get("label") or item.get("subject") or "?")
                        if isinstance(item, dict) else str(item)
                        for item in value[:20]
                    ]
            out["emitted"] = preview
            return _sa_j.dumps(out)

        name = str(variable or "")
        if name not in namespace:
            out["status"] = "unknown_variable"
            out["variable"] = name
            out["available"] = _sa_environment(namespace)
            out["prepared"] = ["data", "numeric_data", "entity_data", "X", "table", "result"]
            return _sa_j.dumps(out)

        value = namespace[name]
        out["variable"] = name
        out.update(_sa_shape_of(value))

        if target == "variable.head":
            if isinstance(value, (_sa_pd.DataFrame, _sa_pd.Series)):
                out.update(_sa_rows_of(value, min(cap, 10)))
            elif isinstance(value, _sa_np.ndarray):
                flat = value[: min(cap, 10)]
                out["rows"] = [[_sa_jsonable(v) for v in _sa_np.atleast_1d(r)] for r in flat]
            else:
                out["status"] = "not_tabular"
        elif target == "variable.columns":
            if isinstance(value, _sa_pd.DataFrame):
                out["columns"] = [str(c) for c in value.columns]
            else:
                out["status"] = "not_tabular"
        elif target == "variable.summary":
            # §12 - the ground truth the next operation depends on: how big,
            # how much is missing, how much is finite. Not the contents.
            if isinstance(value, (_sa_pd.DataFrame, _sa_pd.Series)):
                out["missing"] = int(value.isna().sum().sum())
                numeric = value.select_dtypes("number") if isinstance(value, _sa_pd.DataFrame) else value
                try:
                    arr = _sa_np.asarray(numeric, dtype=float)
                    out["finite"] = [int(_sa_np.isfinite(arr).sum()), int(arr.size)]
                except Exception:
                    pass
                if isinstance(value, _sa_pd.DataFrame):
                    counts = {}
                    for _column, dtype in value.dtypes.astype(str).items():
                        counts[str(dtype)] = counts.get(str(dtype), 0) + 1
                    out["dtypes"] = counts
            elif isinstance(value, _sa_np.ndarray):
                try:
                    arr = _sa_np.asarray(value, dtype=float)
                    out["finite"] = [int(_sa_np.isfinite(arr).sum()), int(arr.size)]
                except Exception:
                    pass
        # variable.shape and variable.dtype are already covered by _sa_shape_of.
        return _sa_j.dumps(out)
    except Exception as exc:
        out["status"] = "error"
        out["errorType"] = type(exc).__name__
        out["message"] = str(exc)[:400]
        return _sa_j.dumps(out)


def __sa_dispose(session_id):
    # §15 - the session lives for ONE analytical turn. Nothing arbitrary
    # survives into an unrelated user turn.
    _SA_SESSIONS.pop(session_id, None)
    return "ok"
`;

/**
 * The compile/exec pair the runner needs, captured into module-private names.
 *
 * The sandbox must execute the script it just validated, so something has to
 * hold a usable `exec`. It lives here, in the runner module's globals — not in
 * the user namespace, and not reachable from it: `__globals__`, `__dict__` and
 * `getattr` are all refused by the validator, so generated code has no path
 * back to this reference.
 */
export const CAPTURE_SOURCE = String.raw`
_sa_compile = compile
_sa_exec = exec
`;

/** Order matters: capture and define first, harden last. */
export const BOOTSTRAP_SOURCES: readonly string[] = [CAPTURE_SOURCE, HARDEN_SOURCE, VALIDATOR_SOURCE, RUNNER_SOURCE];
