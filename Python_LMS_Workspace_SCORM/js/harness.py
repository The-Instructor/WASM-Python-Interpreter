# ---------------------------------------------------------------------------
# Python-side runtime helpers for the Python Lab Workspace.
# Loaded once into each Pyodide worker (js/worker.js). Core system file:
# instructors do not need to edit this.
#
#   _ws_run(entry, inputs, seed, emit)  -> interactive "Run Code"
#   _ws_grade(test_json)                -> run one autograder test, return JSON
#   _ws_shell(line, cwd, protected, color) -> terminal command, return JSON
#
# Comparisons for grading happen in JavaScript (js/app.js); this file only
# executes student code in a clean environment and reports what happened.
# ---------------------------------------------------------------------------
import sys, os, io, json, ast, builtins, runpy, traceback, random, types
import re, stat, fnmatch, glob, shutil, time

WS = "/workspace"
sys.dont_write_bytecode = True  # no __pycache__ folders in the student's file tree
os.umask(0o022)  # files 644, folders 755, like a normal Linux account

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


# ---------------------------------------------------------------------------
# Terminal shell
# A small Linux-like shell over the real /workspace file system, shown to the
# student as /home/student (~). It cannot leave the workspace, and it refuses
# to change read-only files. JS diffs the file system afterwards, so files
# created here show up in the file tree.
# ---------------------------------------------------------------------------
HOME = "/home/student"
_COMMANDS = {}


class _ShellError(Exception):
    pass


def _command(summary):
    def deco(fn):
        _COMMANDS[fn.__name__[4:]] = (fn, summary)
        return fn
    return deco


class _Shell:
    def __init__(self, cwd, rules, color):
        self.cwd = cwd.strip("/")
        self.protected = set(rules.get("readonly", []))  # cannot be changed at all
        self.keep = set(rules.get("keep", []))           # assignment files: editable, not deletable
        self.color = color
        self.errors = []

    def path(self, p):
        """User path -> absolute path inside WS."""
        if p == "~" or p.startswith("~/"):
            full = WS + p[1:]
        elif p == HOME or p.startswith(HOME + "/"):
            full = WS + p[len(HOME):]
        elif p.startswith("/"):
            full = p
        else:
            full = os.path.join(WS, self.cwd, p)
        full = os.path.normpath(full)
        if full != WS and not full.startswith(WS + "/"):
            raise _ShellError(f"{p}: Permission denied (outside your workspace)")
        return full

    @staticmethod
    def rel(full):
        return "" if full == WS else full[len(WS) + 1:]

    def guard(self, full, name, removing=False):
        """Refuse to change read-only files, or to remove assignment files (or folders holding them)."""
        r = self.rel(full)
        inside = lambda paths: r in paths or any(r == "" or p.startswith(r + "/") for p in paths)
        if inside(self.protected):
            raise _ShellError(f"{name}: Permission denied (read-only)")
        if removing and inside(self.keep):
            raise _ShellError(f"{name}: Permission denied (assignment file; you can edit it but not remove it)")

    def warn(self, msg):
        self.errors.append(msg)

    def paint(self, text, code):
        return f"\x1b[{code}m{text}\x1b[0m" if self.color else text

    def read(self, name):
        full = self.path(name)
        if os.path.isdir(full):
            raise _ShellError(f"{name}: Is a directory")
        if not os.path.exists(full):
            raise _ShellError(f"{name}: No such file or directory")
        with open(full, "rb") as fh:
            data = fh.read()
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError:
            raise _ShellError(f"{name}: binary file")

    def inputs(self, files, stdin):
        """(label, text) for each file, or stdin when no files are given."""
        if not files:
            return [("", stdin or "")]
        out = []
        for f in files:
            try:
                out.append((f, self.read(f)))
            except _ShellError as e:
                self.warn(str(e))
        return out


def _opts(args, flags="", valued=""):
    """Parse -abc / -n 5 / -n5 / -5 style options. Returns (set, dict, rest)."""
    on, vals, rest, i = set(), {}, [], 0
    while i < len(args):
        a = args[i]
        if a == "--":
            rest += args[i + 1:]
            break
        if a.startswith("-") and len(a) > 1:
            if a[1:].isdigit() and "n" in valued:
                vals["n"] = a[1:]
            else:
                for j, c in enumerate(a[1:], 1):
                    if c in valued:
                        v = a[j + 1:]
                        if not v:
                            i += 1
                            if i >= len(args):
                                raise _ShellError(f"option requires an argument -- '{c}'")
                            v = args[i]
                        vals[c] = v
                        break
                    if c not in flags:
                        raise _ShellError(f"invalid option -- '{c}'")
                    on.add(c)
        else:
            rest.append(a)
        i += 1
    return on, vals, rest


def _count(vals, default=10):
    try:
        return int(vals.get("n", default))
    except ValueError:
        raise _ShellError(f"invalid number of lines: '{vals['n']}'")


def _lines(text):
    return text.splitlines(keepends=True)


def _join(lines):
    s = "".join(lines)
    return s if not s or s.endswith("\n") else s + "\n"


def _mode_str(st):
    kind = "d" if stat.S_ISDIR(st.st_mode) else "-"
    bits = "".join(ch if st.st_mode & (1 << (8 - i)) else "-" for i, ch in enumerate("rwxrwxrwx"))
    return kind + bits


# --- commands ---------------------------------------------------------------
@_command("show available commands")
def _sh_help(sh, args, stdin):
    rows = sorted((n, s) for n, (f, s) in _COMMANDS.items())
    rows += [("python", "run a file: python main.py"), ("history", "list previous commands"), ("clear", "clear the screen")]
    width = max(len(n) for n, _ in rows)
    lines = ["Commands (a small Linux-style shell for your workspace):"]
    lines += [f"  {sh.paint(n.ljust(width), '1')}  {s}" for n, s in rows]
    lines += ["",
              "Pipes and redirects work: grep def main.py | wc -l,  echo hi > note.txt",
              "Keys: Up/Down history, Tab completes names, Ctrl+C cancels, Ctrl+L clears."]
    return "\n".join(lines) + "\n"


@_command("print the current folder")
def _sh_pwd(sh, args, stdin):
    return HOME + ("/" + sh.cwd if sh.cwd else "") + "\n"


@_command("change folder: cd data, cd .., cd ~")
def _sh_cd(sh, args, stdin):
    target = sh.path(args[0] if args else "~")
    if not os.path.exists(target):
        raise _ShellError(f"{args[0]}: No such file or directory")
    if not os.path.isdir(target):
        raise _ShellError(f"{args[0]}: Not a directory")
    sh.cwd = sh.rel(target)
    return ""


@_command("list files: ls -l, ls -a, ls data")
def _sh_ls(sh, args, stdin):
    on, _, paths = _opts(args, "laA1h")
    paths = paths or ["."]
    blocks = []
    for p in paths:
        full = sh.path(p)
        if not os.path.exists(full):
            sh.warn(f"cannot access '{p}': No such file or directory")
            continue
        if os.path.isdir(full):
            names = sorted(os.listdir(full), key=str.lower)
            if "a" not in on and "A" not in on:
                names = [n for n in names if not n.startswith(".")]
            if "a" in on:
                names = [".", ".."] + names
            entries = [(n, os.path.join(full, n)) for n in names]
        else:
            entries = [(p, full)]
        blocks.append((p, os.path.isdir(full), entries))
    out = []
    for p, is_dir, entries in blocks:
        if len(blocks) > 1 and is_dir:
            out.append(f"{p}:")
        names = []
        for n, f in entries:
            st = os.stat(WS if n == ".." and os.path.dirname(f) == WS else f)
            shown = n
            if stat.S_ISDIR(st.st_mode):
                shown = sh.paint(n, "1;34")
            elif st.st_mode & 0o111:
                shown = sh.paint(n, "1;32")
            if "l" in on:
                when = time.strftime("%b %d %H:%M", time.localtime(st.st_mtime))
                out.append(f"{_mode_str(st)} 1 student student {st.st_size:>6} {when} {shown}")
            else:
                names.append(shown)
        if names:
            out.append("\n".join(names) if "1" in on else "  ".join(names))
        if len(blocks) > 1 and is_dir:
            out.append("")
    return _join(l + "\n" for l in out)


@_command("show a file: cat main.py")
def _sh_cat(sh, args, stdin):
    _, _, files = _opts(args, "")
    return _join(t for _, t in sh.inputs(files, stdin))


@_command("first lines: head -n 5 file")
def _sh_head(sh, args, stdin):
    _, vals, files = _opts(args, "", "n")
    n = _count(vals)
    return _join(l for _, t in sh.inputs(files, stdin) for l in _lines(t)[:n])


@_command("last lines: tail -n 5 file")
def _sh_tail(sh, args, stdin):
    _, vals, files = _opts(args, "", "n")
    n = _count(vals)
    return _join(l for _, t in sh.inputs(files, stdin) for l in (_lines(t)[-n:] if n else []))


@_command("count lines/words/chars: wc -l file")
def _sh_wc(sh, args, stdin):
    on, _, files = _opts(args, "lwc")
    on = on or {"l", "w", "c"}
    out = []
    for label, t in sh.inputs(files, stdin):
        cols = [str(v).rjust(7) for k, v in (("l", t.count("\n")), ("w", len(t.split())), ("c", len(t.encode()))) if k in on]
        out.append("".join(cols) + (" " + label if label else ""))
    return _join(l + "\n" for l in out)


@_command("search text: grep -n def main.py, grep -ri todo .")
def _sh_grep(sh, args, stdin):
    on, _, rest = _opts(args, "invcrlwE")
    if not rest:
        raise _ShellError("usage: grep [-invcrlw] PATTERN [FILE...]")
    pattern, files = rest[0], rest[1:]
    if "E" not in on:
        # Basic regex like GNU grep: ( ) { } | + ? are literal; \( \| ... are operators.
        pattern = re.sub(r"\\([(){}|+?])|([(){}|+?])", lambda m: m.group(1) or "\\" + m.group(2), pattern)
    if "w" in on:
        pattern = rf"\b(?:{pattern})\b"
    try:
        rx = re.compile(pattern, re.IGNORECASE if "i" in on else 0)
    except re.error as e:
        raise _ShellError(f"invalid pattern: {e}")
    if "r" in on:
        expanded = []
        for f in files or ["."]:
            full = sh.path(f)
            if os.path.isdir(full):
                for root, dirs, names in os.walk(full):
                    dirs.sort()
                    for n in sorted(names):
                        p = os.path.join(root, n)
                        expanded.append(os.path.relpath(p, os.path.join(WS, sh.cwd)))
            else:
                expanded.append(f)
        files = expanded
    sources = []
    for label, text in sh.inputs(files, stdin):
        sources.append((label, text))
    many = len(files) > 1 or "r" in on
    out, found = [], False
    for label, text in sources:
        hits = 0
        for no, line in enumerate(text.splitlines(), 1):
            if bool(rx.search(line)) == ("v" in on):
                continue
            hits += 1
            found = True
            if "l" in on or "c" in on:
                continue
            shown = line if "v" in on else rx.sub(lambda m: sh.paint(m.group(0), "1;31"), line)
            prefix = (sh.paint(label, "35") + ":" if many else "") + (sh.paint(str(no), "32") + ":" if "n" in on else "")
            out.append(prefix + shown)
        if "l" in on and hits:
            out.append(sh.paint(label, "35"))
        elif "c" in on:
            out.append((label + ":" if many else "") + str(hits))
    return _join(l + "\n" for l in out), (0 if found else 1)


@_command("find files: find . -name '*.py'")
def _sh_find(sh, args, stdin):
    start, name, kind, i = ".", None, None, 0
    if args and not args[0].startswith("-"):
        start, i = args[0], 1
    while i < len(args):
        if args[i] in ("-name", "-iname", "-type") and i + 1 < len(args):
            if args[i] == "-type":
                kind = args[i + 1]
            else:
                name = (args[i + 1], args[i] == "-iname")
            i += 2
        else:
            raise _ShellError(f"unknown option '{args[i]}' (use -name, -iname, -type f|d)")
    root = sh.path(start)
    if not os.path.isdir(root):
        raise _ShellError(f"'{start}': No such directory")

    def keep(path, is_dir):
        if kind == "f" and is_dir or kind == "d" and not is_dir:
            return False
        if name:
            base = os.path.basename(path)
            pat, ci = name
            return fnmatch.fnmatchcase(base.lower(), pat.lower()) if ci else fnmatch.fnmatchcase(base, pat)
        return True

    out = [start] if keep(root, True) and not name else []
    for dirpath, dirs, files in os.walk(root):
        dirs.sort()
        for n in dirs + sorted(files):
            full = os.path.join(dirpath, n)
            if keep(full, n in dirs):
                out.append(os.path.join(start, os.path.relpath(full, root)) if start != "." else "./" + os.path.relpath(full, root))
    return _join(l + "\n" for l in out)


@_command("folder tree: tree, tree data")
def _sh_tree(sh, args, stdin):
    _, _, paths = _opts(args, "")
    root = sh.path(paths[0] if paths else ".")
    if not os.path.isdir(root):
        raise _ShellError(f"{paths[0]}: Not a directory")
    out, counts = [sh.paint(paths[0] if paths else ".", "1;34")], [0, 0]

    def walk(d, prefix):
        names = sorted((n for n in os.listdir(d) if not n.startswith(".")), key=str.lower)
        for i, n in enumerate(names):
            full = os.path.join(d, n)
            last = i == len(names) - 1
            is_dir = os.path.isdir(full)
            counts[0 if is_dir else 1] += 1
            out.append(prefix + ("└── " if last else "├── ") + (sh.paint(n, "1;34") if is_dir else n))
            if is_dir:
                walk(full, prefix + ("    " if last else "│   "))

    walk(root, "")
    out.append(f"\n{counts[0]} directories, {counts[1]} files")
    return "\n".join(out) + "\n"


@_command("locate a command: which python")
def _sh_which(sh, args, stdin):
    out, code = [], 0
    for a in args:
        if a in _COMMANDS or a in ("python", "python3", "history", "clear"):
            out.append(f"/usr/bin/{'python3' if a == 'python' else a}")
        else:
            code = 1
    return _join(l + "\n" for l in out), code


@_command("print text: echo hello > note.txt")
def _sh_echo(sh, args, stdin):
    newline = True
    if args[:1] == ["-n"]:
        newline, args = False, args[1:]
    return " ".join(args) + ("\n" if newline else "")


@_command("print your user name")
def _sh_whoami(sh, args, stdin):
    return "student\n"


@_command("create empty files: touch notes.txt")
def _sh_touch(sh, args, stdin):
    if not args:
        raise _ShellError("missing file operand")
    for a in args:
        full = sh.path(a)
        if os.path.exists(full):
            os.utime(full)
        elif not os.path.isdir(os.path.dirname(full)):
            sh.warn(f"cannot touch '{a}': No such file or directory")
        else:
            open(full, "a").close()
    return ""


@_command("make folders: mkdir -p data/raw")
def _sh_mkdir(sh, args, stdin):
    on, _, dirs = _opts(args, "p")
    if not dirs:
        raise _ShellError("missing operand")
    for d in dirs:
        full = sh.path(d)
        if os.path.exists(full):
            if "p" not in on:
                sh.warn(f"cannot create directory '{d}': File exists")
        elif "p" in on:
            os.makedirs(full)
        elif not os.path.isdir(os.path.dirname(full)):
            sh.warn(f"cannot create directory '{d}': No such file or directory")
        else:
            os.mkdir(full)
    return ""


@_command("delete: rm file, rm -r folder")
def _sh_rm(sh, args, stdin):
    on, _, paths = _opts(args, "rRf")
    if not paths:
        raise _ShellError("missing operand")
    for p in paths:
        full = sh.path(p)
        if not os.path.exists(full):
            if "f" not in on:
                sh.warn(f"cannot remove '{p}': No such file or directory")
            continue
        if full == WS:
            sh.warn("refusing to remove your home folder")
            continue
        try:
            sh.guard(full, f"cannot remove '{p}'", removing=True)
        except _ShellError as e:
            sh.warn(str(e))
            continue
        if os.path.isdir(full):
            if not on & {"r", "R"}:
                sh.warn(f"cannot remove '{p}': Is a directory (use rm -r)")
                continue
            shutil.rmtree(full)
        else:
            os.unlink(full)
    return ""


@_command("remove empty folders")
def _sh_rmdir(sh, args, stdin):
    for d in args:
        full = sh.path(d)
        if not os.path.isdir(full):
            sh.warn(f"failed to remove '{d}': Not a directory")
        elif os.listdir(full):
            sh.warn(f"failed to remove '{d}': Directory not empty")
        elif full != WS:
            os.rmdir(full)
    return ""


def _copy_or_move(sh, args, move):
    on, _, paths = _opts(args, "rR" if not move else "")
    if len(paths) < 2:
        raise _ShellError("missing destination file operand")
    *srcs, dst = paths
    dst_full = sh.path(dst)
    if len(srcs) > 1 and not os.path.isdir(dst_full):
        raise _ShellError(f"target '{dst}' is not a directory")
    for s in srcs:
        src = sh.path(s)
        if not os.path.exists(src):
            sh.warn(f"cannot stat '{s}': No such file or directory")
            continue
        target = os.path.join(dst_full, os.path.basename(src)) if os.path.isdir(dst_full) else dst_full
        try:
            if move:
                sh.guard(src, f"cannot move '{s}'", removing=True)
            if os.path.exists(target):
                sh.guard(target, f"cannot overwrite '{dst}'")
            if target == src or target.startswith(src + "/"):
                raise _ShellError(f"cannot copy '{s}' into itself")
        except _ShellError as e:
            sh.warn(str(e))
            continue
        if move:
            shutil.move(src, target)
        elif os.path.isdir(src):
            if not on & {"r", "R"}:
                sh.warn(f"-r not specified; omitting directory '{s}'")
                continue
            shutil.copytree(src, target)
        else:
            shutil.copyfile(src, target)
    return ""


@_command("copy: cp a.py b.py, cp -r src dst")
def _sh_cp(sh, args, stdin):
    return _copy_or_move(sh, args, False)


@_command("move or rename: mv old.py new.py")
def _sh_mv(sh, args, stdin):
    return _copy_or_move(sh, args, True)


@_command("change permissions: chmod 755 run.py, chmod u+x run.py")
def _sh_chmod(sh, args, stdin):
    if len(args) < 2:
        raise _ShellError("usage: chmod MODE FILE...")
    spec, files = args[0], args[1:]
    for f in files:
        full = sh.path(f)
        if not os.path.exists(full):
            sh.warn(f"cannot access '{f}': No such file or directory")
            continue
        if sh.rel(full) in sh.protected:
            sh.warn(f"changing permissions of '{f}': Operation not permitted (read-only file)")
            continue
        mode = stat.S_IMODE(os.stat(full).st_mode)
        if re.fullmatch(r"[0-7]{1,4}", spec):
            mode = int(spec, 8)
        else:
            for part in spec.split(","):
                m = re.fullmatch(r"([ugoa]*)([+\-=])([rwx]*)", part)
                if not m:
                    raise _ShellError(f"invalid mode: '{spec}'")
                who = m.group(1) or "a"
                bits = 0
                for w in ("ugo" if "a" in who else who):
                    shift = {"u": 6, "g": 3, "o": 0}[w]
                    for p in m.group(3):
                        bits |= {"r": 4, "w": 2, "x": 1}[p] << shift
                if m.group(2) == "+":
                    mode |= bits
                elif m.group(2) == "-":
                    mode &= ~bits
                else:
                    mask = sum(7 << {"u": 6, "g": 3, "o": 0}[w] for w in ("ugo" if "a" in who else who))
                    mode = (mode & ~mask) | bits
        os.chmod(full, mode)
    return ""


# --- parser / runner ----------------------------------------------------------
def _tokenize(line):
    """Split a command line into (word, quoted) pairs; operators get quoted=None."""
    toks, cur, state, i = [], [], {"q": False, "has": False}, 0

    def flush():
        if state["has"]:
            toks.append(("".join(cur), state["q"]))
        cur.clear()
        state.update(q=False, has=False)

    while i < len(line):
        c = line[i]
        if c in " \t":
            flush()
        elif c in "'\"":
            j = line.find(c, i + 1)
            if j < 0:
                raise ValueError("No closing quotation")
            seg = line[i + 1:j]
            cur.append(re.sub(r'\\(["\\$`])', r"\1", seg) if c == '"' else seg)
            state.update(q=True, has=True)
            i = j
        elif c == "\\" and i + 1 < len(line):
            i += 1
            cur.append(line[i])
            state.update(q=True, has=True)
        elif c in "|;>&":
            flush()
            op = line[i:i + 2] if line[i:i + 2] in (">>", "&&", "||") else c
            toks.append((op, None))
            i += len(op) - 1
        else:
            cur.append(c)
            state["has"] = True
        i += 1
    flush()
    return toks


def _expand(sh, words):
    out = []
    for a, quoted in words:
        if not quoted and any(c in a for c in "*?[") and not a.startswith(("~", "/")):
            base = os.path.join(WS, sh.cwd)
            hits = sorted(glob.glob(a, root_dir=base))
            if hits:
                out += hits
                continue
        out.append(a)
    return out


def _run_pipeline(sh, stages, redirect, res):
    data = None
    code = 0
    for i, argv in enumerate(stages):
        if not argv:
            raise _ShellError("syntax error near '|'")
        argv = _expand(sh, argv)
        name, args = argv[0], argv[1:]
        if name in ("python", "python3"):
            if len(stages) > 1 or redirect:
                raise _ShellError("python: pipes and redirects are not supported for programs")
            if not args:
                raise _ShellError("python: interactive Python isn't available here. Run a file: python main.py")
            full = sh.path(args[0])
            if not os.path.isfile(full):
                raise _ShellError(f"python: can't open file '{args[0]}': No such file")
            res["run"] = sh.rel(full)
            return "", 0
        if name == "clear":
            res["clear"] = True
            continue
        entry = _COMMANDS.get(name)
        if entry is None:
            raise _ShellError(f"{name}: command not found (type help for the list)")
        sh.color = res["color"] and i == len(stages) - 1 and not redirect
        try:
            r = entry[0](sh, args, data)
        except _ShellError as e:
            raise _ShellError(f"{name}: {e}")
        except OSError as e:
            raise _ShellError(f"{name}: {e.strerror or e}")
        data, code = r if isinstance(r, tuple) else (r, 0)
        if sh.errors:
            sh.errors = [f"{name}: {m}" for m in sh.errors]
            code = code or 1
    if redirect:
        op, target = redirect
        full = sh.path(target)
        if os.path.isdir(full):
            raise _ShellError(f"{target}: Is a directory")
        if os.path.exists(full):
            sh.guard(full, target)
        with open(full, "a" if op == ">>" else "w", encoding="utf-8") as fh:
            fh.write(data or "")
        data = ""
    return data or "", code


def _ws_shell(line, cwd, rules_json, color):
    sh = _Shell(cwd, _loads(rules_json), bool(color))
    res = {"out": "", "cwd": sh.cwd, "code": 0, "color": bool(color)}
    try:
        tokens = _tokenize(line)
    except ValueError as e:
        res["out"] = f"syntax error: {e}\n"
        res["code"] = 2
        return _dumps(res)
    # Split into "cmd ; cmd && cmd" groups, then pipelines, then a trailing redirect.
    groups, cur = [], []
    for tok in tokens + [(";", None)]:
        if tok[1] is None and tok[0] in (";", "&&"):
            if cur:
                groups.append((cur, tok[0]))
            cur = []
        else:
            cur.append(tok)
    out = []
    last_code = 0
    prev_op = ";"
    for toks, op in groups:
        if prev_op == "&&" and last_code != 0:
            prev_op = op
            continue
        prev_op = op
        try:
            redirect = None
            if len(toks) >= 2 and toks[-2][1] is None and toks[-2][0] in (">", ">>") and toks[-1][1] is not None:
                redirect, toks = (toks[-2][0], toks[-1][0]), toks[:-2]
            stages, stage = [], []
            for tok in toks:
                if tok[1] is None and tok[0] == "|":
                    stages.append(stage)
                    stage = []
                elif tok[1] is None:
                    raise _ShellError(f"syntax error near '{tok[0]}'")
                else:
                    stage.append(tok)
            stages.append(stage)
            text, last_code = _run_pipeline(sh, stages, redirect, res)
            out.append(text)
        except _ShellError as e:
            sh.errors.append(str(e))
            last_code = 1
        for msg in sh.errors:
            out.append(sh.paint(msg, "31") + "\n" if color else msg + "\n")
        sh.errors = []
        if "run" in res:
            break
    res.update(out="".join(out), cwd=sh.cwd, code=last_code)
    del res["color"]
    return _dumps(res)


def _ws_shell_commands():
    return _dumps(sorted(list(_COMMANDS) + ["python", "python3", "history", "clear"]))
