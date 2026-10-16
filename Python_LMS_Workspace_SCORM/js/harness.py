# ---------------------------------------------------------------------------
# Python-side runtime helpers for the Python Lab Workspace.
# Loaded once into each Pyodide worker (js/worker.js). Core system file:
# instructors do not need to edit this.
#
#   _ws_run(entry, inputs, seed, emit)  -> interactive "Run Code"
#   _ws_grade(test_json)                -> run one autograder test, return JSON
#
# Comparisons for grading happen in JavaScript (js/app.js); this file only
# executes student code in a clean environment and reports what happened.
# ---------------------------------------------------------------------------
import sys, os, io, json, ast, builtins, runpy, traceback, random, types

WS = "/workspace"

# References captured before any student code runs.
_BUILTINS_SNAPSHOT = dict(builtins.__dict__)
_dumps = json.dumps
_loads = json.loads
_repr = repr
_StringIO = io.StringIO
_isinstance = isinstance
_sorted = sorted
_literal_eval = ast.literal_eval
_BLOCKED = ("js", "pyodide", "pyodide_js", "_pyodide")


class _NeedInput(BaseException):
    """Raised when a program asks for input that has not been typed yet.
    BaseException so student `except Exception:` blocks cannot swallow it."""
    def __init__(self, prompt):
        super().__init__(prompt)
        self.prompt = prompt


class _ImportBlocker:
    """Keeps student code from reaching the JS bridge while it is graded."""
    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in _BLOCKED:
            raise ImportError(f"Module '{name}' is not available in this workspace")
        return None


def _reset_env():
    """Fresh interpreter state: original builtins, no cached student modules."""
    builtins.__dict__.clear()
    builtins.__dict__.update(_BUILTINS_SNAPSHOT)
    for name, mod in list(sys.modules.items()):
        f = getattr(mod, "__file__", None) or ""
        if f.startswith(WS + "/"):
            del sys.modules[name]
    try:
        os.chdir(WS)
    except Exception:
        pass
    if WS not in sys.path:
        sys.path.insert(0, WS)


def _format_exc(exc):
    """Traceback limited to frames inside the student's files."""
    tb = traceback.extract_tb(exc.__traceback__)
    frames = [f for f in tb if f.filename.startswith(WS + "/")]
    lines = []
    if frames:
        lines.append("Traceback (most recent call last):")
        for f in frames:
            lines.append(f'  File "{f.filename[len(WS) + 1:]}", line {f.lineno}, in {f.name}')
            if f.line:
                lines.append("    " + f.line.strip())
    if _isinstance(exc, SyntaxError) and exc.filename:
        fn = exc.filename[len(WS) + 1:] if exc.filename.startswith(WS + "/") else exc.filename
        lines.append(f'  File "{fn}", line {exc.lineno}')
        if exc.text:
            lines.append("    " + exc.text.rstrip())
    lines.append(f"{type(exc).__name__}: {exc}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Interactive Run Code (replay model)
# The program is re-run from the start each time the student types a new
# input line; JS hides the output that was already shown. `random` is seeded
# per session so replays are deterministic.
# ---------------------------------------------------------------------------
class _EmitWriter(io.TextIOBase):
    def __init__(self, emit):
        self._emit = emit
    def write(self, s):
        if s:
            self._emit(str(s))
        return len(s)
    def flush(self):
        pass


def _ws_run(entry, inputs_json, seed, emit, emit_err):
    _reset_env()
    inputs = _loads(inputs_json)
    state = {"i": 0}
    out = _EmitWriter(emit)

    def _input(prompt=""):
        prompt = str(prompt)
        if prompt:
            out.write(prompt)
        if state["i"] < len(inputs):
            value = inputs[state["i"]]
            state["i"] += 1
            out.write(value + "\n")
            return value
        raise _NeedInput(prompt)

    builtins.input = _input
    random.seed(seed)
    old = sys.stdout, sys.stderr, sys.stdin
    sys.stdout = out
    sys.stderr = _EmitWriter(emit_err)
    sys.stdin = _StringIO("\n".join(inputs) + "\n")
    status = "done"
    try:
        runpy.run_path(os.path.join(WS, entry), run_name="__main__")
    except _NeedInput:
        status = "need_input"
    except SystemExit as e:
        if e.code not in (None, 0):
            emit_err(f"Program exited with code {e.code}\n")
    except BaseException as e:  # noqa
        emit_err(_format_exc(e) + "\n")
    finally:
        sys.stdout, sys.stderr, sys.stdin = old
    return status


# ---------------------------------------------------------------------------
# Autograder
# ---------------------------------------------------------------------------
def _canon(v, depth=0):
    """JSON-safe canonical form so JS can compare values (type-aware)."""
    if depth > 50:
        return {"__repr__": _repr(v)}
    if v is None or _isinstance(v, (bool, str)):
        return v
    if _isinstance(v, int):
        return v if abs(v) < 2 ** 53 else {"__int__": str(v)}
    if _isinstance(v, float):
        if v != v or v in (float("inf"), float("-inf")):
            return {"__float__": _repr(v)}
        return v
    if _isinstance(v, list):
        return [_canon(x, depth + 1) for x in v]
    if _isinstance(v, tuple):
        return {"__tuple__": [_canon(x, depth + 1) for x in v]}
    if _isinstance(v, (set, frozenset)):
        items = [_canon(x, depth + 1) for x in v]
        return {"__set__": _sorted(items, key=lambda x: _dumps(x, sort_keys=True))}
    if _isinstance(v, dict):
        pairs = [[_canon(k, depth + 1), _canon(x, depth + 1)] for k, x in v.items()]
        return {"__dict__": _sorted(pairs, key=lambda p: _dumps(p[0], sort_keys=True))}
    return {"__repr__": _repr(v)}


def _short_repr(v, limit=300):
    try:
        r = _repr(v)
    except Exception:
        r = "<unprintable value>"
    return r if len(r) <= limit else r[:limit] + "..."


def _capture(fn, stdin_text):
    """Run fn() with fed stdin and captured stdout. Prompts are NOT echoed,
    so expected output only contains what the program prints."""
    lines = (stdin_text or "").splitlines()
    pos = {"i": 0}

    def _input(prompt=""):
        if pos["i"] >= len(lines):
            raise EOFError("The program asked for more input than this test provides")
        pos["i"] += 1
        return lines[pos["i"] - 1]

    builtins.input = _input
    out, err = _StringIO(), _StringIO()
    old = sys.stdout, sys.stderr, sys.stdin
    sys.stdout, sys.stderr, sys.stdin = out, err, _StringIO(stdin_text or "")
    blocker = _ImportBlocker()
    stashed = {k: sys.modules.pop(k) for k in list(sys.modules) if k.split(".")[0] in _BLOCKED}
    sys.meta_path.insert(0, blocker)
    result, error = None, None
    try:
        result = fn()
    except SystemExit as e:
        if e.code not in (None, 0):
            error = f"Program exited with code {e.code}"
    except BaseException as e:  # noqa
        error = _format_exc(e)
    finally:
        sys.stdout, sys.stderr, sys.stdin = old
        try:
            sys.meta_path.remove(blocker)
        except ValueError:
            pass
        sys.modules.update(stashed)
    return result, out.getvalue(), error


def _ws_grade(test_json):
    t = _loads(test_json)
    kind = t.get("type", "output")
    target = t.get("file") or "main.py"
    path = os.path.join(WS, target)
    stdin_text = t.get("stdin", "")
    res = {"type": kind}
    _reset_env()
    random.seed(0)

    if not os.path.exists(path):
        res["error"] = f"File '{target}' was not found"
        return _dumps(res)

    if kind == "output":
        _, stdout, error = _capture(lambda: runpy.run_path(path, run_name="__main__"), stdin_text)
        res.update(stdout=stdout, error=error)

    elif kind == "function":
        try:
            expected = _literal_eval((t.get("expected") or "").strip() or "None")
            res["expected"] = _canon(expected)
            res["expectedRepr"] = _short_repr(expected, 20000)
        except Exception as e:
            res["error"] = f"Instructor setup error: expected value is not a Python literal ({e})"
            return _dumps(res)
        call = (t.get("call") or "").strip()

        def _do():
            ns = runpy.run_path(path, run_name="__student__")
            return eval(compile(call, "<test>", "eval"), ns)

        value, stdout, error = _capture(_do, stdin_text)
        res.update(stdout=stdout, error=error)
        if error is None:
            res["actual"] = _canon(value)
            res["actualRepr"] = _short_repr(value, 20000)

    elif kind == "code":
        try:
            with open(path, encoding="utf-8") as fh:
                source = fh.read()
        except Exception:
            source = ""
        code = t.get("code") or ""

        def _run(stdin=""):
            _, o, e = _capture_inner(lambda: runpy.run_path(path, run_name="__main__"), stdin)
            if e:
                raise RuntimeError("The program crashed:\n" + e)
            return o

        def _do():
            ns = runpy.run_path(path, run_name="__student__")
            env = dict(ns)
            env.update(module=types.SimpleNamespace(**ns), source=source, run=_run)
            exec(compile(code, "<test>", "exec"), env)
            return True

        _, stdout, error = _capture(_do, stdin_text)
        if error:
            # Show assertion message cleanly
            last = error.strip().splitlines()[-1]
            if last.startswith("AssertionError"):
                msg = last[len("AssertionError"):].lstrip(": ").strip()
                error = msg or "Assertion failed"
        res.update(stdout=stdout, error=error)
    else:
        res["error"] = f"Unknown test type '{kind}'"
    return _dumps(res)


def _capture_inner(fn, stdin_text):
    """Nested capture used by run() inside custom code tests."""
    saved_input = builtins.input
    try:
        return _capture(fn, stdin_text)
    finally:
        builtins.input = saved_input
