# HANDOFF — Python LMS Workspace (SCORM Template)

_Last updated: 2026-10-16_

## Purpose
A SCORM 1.2 package that instructors use as a **template** to build, test, and auto-grade
Python assignments in **D2L Brightspace**. Students get an in-browser IDE (editor, terminal,
instructions); Python runs client-side via Pyodide (WASM). Goal: give instructors a guided
workspace for (1) writing assignment instructions, (2) testing assignments, (3) running
automated tests that report a grade to D2L.

## Sources of truth
| What | Where |
|---|---|
| Repo | https://github.com/The-Instructor/WASM-Python-Interpreter (branch `main`) |
| Project folder in repo | `Python_LMS_Workspace_SCORM/` |
| Instructor's local copy | `~/Documents/CSC1019/WASM_Python_Workspace/WASM-Python-Interpreter-main/Python_LMS_Workspace_SCORM` |
| D2L upload | `Python_Workspace.zip` in the local folder (instructor-built; **not tracked**, ignore it) |

**Rule:** the repo holds the latest *working* version of every project file. After each
verified change, sync local folder ⇄ repo and update this file.

## File map
| File | Role |
|---|---|
| `imsmanifest.xml` | SCORM 1.2 manifest, one SCO → `index.html`. Instructors declare starter files as `<file href="..."/>` in the marked block. |
| `index.html` | Layout: toolbar (Files / Run / Exit), file tree, CodeMirror editor + status bar, xterm terminal, Markdown instructions pane, exit modal. All libs via CDN. |
| `css/styles.css` | VS Code–style dark theme, splitters, modal, CodeMirror `vscode-dark` theme. |
| `js/app.js` | All UI logic: manifest-driven starter-file discovery, in-memory virtual FS, file tree CRUD, downloads (JSZip), splitters, traceback line highlighting, worker lifecycle. |
| `js/worker.js` | Pyodide 0.27.3 Web Worker. `sync` mirrors virtual FS into `/workspace`; `run` executes the chosen `.py` via `runPythonAsync`. Stop = terminate + respawn. |
| `instructions.md` | Placeholder assignment text rendered in the right pane. |
| `HANDOFF.md` | This file. Not declared in the manifest; harmless if zipped. |

## Current state (baseline)
- Local folder and repo `main` @ `04c44d0` were **byte-identical** on 2026-10-16 (all 6 project files).
- Working: editing, multi-file/folder tree, run/stop, stdout/stderr to terminal,
  error-line highlight, per-file and full-workspace zip download, collapsible panes.

## Known gaps (not yet implemented)
1. **No SCORM runtime calls** — no `LMSInitialize`/`LMSSetValue`/`LMSCommit`/`LMSFinish`; D2L receives no score or completion.
2. **No test runner / grading config** — nowhere to define, run, weight, or report tests.
3. **No instructor workflow** — no authoring mode, reference-solution check, or packaging/validation step; starter files are hand-declared in the manifest.
4. **`input()` unsupported** — terminal is output-only (no stdin bridge).
5. **Minor:** `marked.js` CDN URL is unpinned; package requires internet (all CDN); multi-file imports rely on `/workspace` being cwd.
6. **Security note:** any client-side grading is visible/spoofable by students; design must state the trust level.

## Open design decisions (awaiting instructor)
1. Grading trust level: practice/low-stakes vs. hidden/obfuscated tests + submission export.
2. Test style: stdin→stdout I/O cases, pytest-style asserts, or both (with point weights).
3. Instructor UX: built-in hidden **Instructor Mode** (edit instructions/tests, validate against reference solution, export D2L zip) vs. documented `assignment.json` + packaging script.

## Next steps
1. Get answers to the open decisions above.
2. Write architecture proposal (SCORM API wrapper, test-config schema, grader in worker, instructor flow).
3. Implement incrementally; verify each step in a browser; commit to `main`; update this file.

## Change log
| Date | Commit | Change |
|---|---|---|
| 2026-10-16 | — | Confirmed local == repo baseline (`04c44d0`). Added HANDOFF.md. |
