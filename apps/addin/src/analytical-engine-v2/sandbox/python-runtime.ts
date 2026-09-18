// ---------------------------------------------------------------------------
// Stage 27 §15/§16/§23/§27/§28/§30 — the Python side of the sandbox.
//
// Three sources, applied in order, each doing one job:
//
//   HARDEN     closes the doors the runtime leaves open        (§16)
//   VALIDATOR  refuses code that asks for what is closed       (§15)
//   RUNNER     executes accepted code and collects structure   (§27)
//
// The order is also the argument. §16 insists AST validation is defence in
// depth and NOT the sandbox, and a measurement on this runtime shows why: a
// bare Pyodide instance genuinely denies the host filesystem and host
// processes — `os.popen` answers "emscripten does not support processes",
// `C:/Windows` does not exist, the working directory is a virtual
// `/home/pyodide` — and then hands Python the entire JavaScript global scope
// through `import js`. In Node that is `js.process`; in a browser worker it is
// `js.fetch`. The WASM boundary is real but incomplete.
//
// One design decision is worth stating because the obvious alternative is
// wrong. Hardening does NOT mutate the global `builtins` module. Deleting
// `eval` there would also delete it for pandas, which uses it internally for
// `df.query`, and for any library that calls `vars()` — the sandbox would
// "pass" its security tests by breaking the analysis it exists to run.
// Instead the restriction is applied where it belongs: generated code executes
// with its OWN `__builtins__` mapping, containing only what an analytical
// script needs. Libraries keep the real builtins, because libraries are not
// the untrusted party here.
// ---------------------------------------------------------------------------

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

# I/O-shaped library APIs. The runtime has no host filesystem and no working
# HTTP stack, so these fail anyway — but they fail with a confusing traceback,
# and a script that reaches for one has misunderstood its input (§9: the
# dataset is given, never fetched).
_SA_V_IO_CALLS = frozenset({
    "read_csv", "read_excel", "read_json", "read_html", "read_pickle", "read_sql",
    "read_parquet", "read_feather", "read_table", "read_clipboard", "read_fwf",
    "to_csv", "to_excel", "to_json", "to_pickle", "to_sql", "to_parquet",
    "to_clipboard", "urlopen", "urlretrieve", "request", "get", "post",
    "system", "popen", "spawn", "fork", "execv", "connect", "socket",
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

def _sa_violations(source):
    out = []
    try:
        tree = _sa_ast.parse(source)
    except SyntaxError as exc:
        return [{"code": "SYNTAX", "detail": str(exc), "line": exc.lineno or 0}]

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
            if isinstance(fn, _sa_ast.Name) and fn.id in _SA_V_CALLS:
                out.append({"code": "CALL", "detail": fn.id, "line": node.lineno})
            elif isinstance(fn, _sa_ast.Attribute):
                if fn.attr in _SA_V_CALLS:
                    out.append({"code": "CALL", "detail": fn.attr, "line": node.lineno})
                elif fn.attr in _SA_V_IO_CALLS:
                    out.append({"code": "IO", "detail": fn.attr, "line": node.lineno})
        elif isinstance(node, _sa_ast.Attribute):
            if node.attr in _SA_V_ATTRS:
                out.append({"code": "ATTR", "detail": node.attr, "line": node.lineno})
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


def _sa_collect(result, max_rows):
    if not isinstance(result, dict):
        raise ValueError("RESULT must be a dict; got %s" % type(result).__name__)

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

def __sa_run(source, dataset_json, max_rows):
    payload = _sa_j.loads(dataset_json)
    names = [c["name"] for c in payload["columns"]]
    # §23 — a missing observation arrives as null and becomes NaN. It is never
    # filled, here or anywhere upstream: once a gap is 0, no policy declared
    # later can tell it from a recorded zero.
    frame = _sa_pd.DataFrame(payload["rows"], columns=names)
    for spec in payload["columns"]:
        if spec["semanticType"] in _SA_NUMERIC_TYPES:
            frame[spec["name"]] = _sa_pd.to_numeric(frame[spec["name"]], errors="coerce")

    namespace = {
        "data": frame,
        "meta": payload["columns"],
        "periods": payload.get("periods"),
        "pd": _sa_pd,
        "np": _sa_np,
        "RESULT": {},
        # §16 — the restriction lives HERE, on the untrusted code's own
        # builtins, not on the global module every library shares.
        "__builtins__": _SA_SAFE_BUILTINS,
    }

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
