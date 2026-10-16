# HANDOFF — Python LMS Workspace (SCORM Template)

_Last updated: 2026-10-16_

## Purpose
A SCORM 1.2 template that instructors use to **author, test and auto-grade** Python assignments for **D2L Brightspace**. Python runs in the browser through Pyodide (WASM).

* **Instructor Mode:** used inside the template to build an assignment, check it, and **export** a student package.
* **Student package:** the exported zip, which reports scores to D2L.

Priorities set by the instructor:

1. Students must not be able to tamper with tests or instructions.
2. Setup must be easy and low-maintenance, with a smooth UX.
3. Instructor Mode is used to set up and preview assignments.

## Sources of truth
| What | Where |
|---|---|
| Repo | https://github.com/The-Instructor/WASM-Python-Interpreter (`main`) |
| Project folder in repo | `Python_LMS_Workspace_SCORM/` |
| Instructor's local copy | `~/Documents/CSC1019/WASM_Python_Workspace/WASM-Python-Interpreter-main/Python_LMS_Workspace_SCORM` (not a git repo) |
| Git working clone | `~/Documents/CSC1019/WASM_Python_Workspace/WASM-Python-Interpreter-repo` — make changes and commit here, push `main`, then copy into the local copy |
| Old D2L zip (`Python_Workspace.zip`) | Instructor's own file. **Ignore it; it is not tracked** (see `.gitignore`). |
| E2E tests | `dev/e2e/` (repo only; see the README there) |
| Instructor download | https://github.com/The-Instructor/WASM-Python-Interpreter/releases/download/template-latest/Python_LMS_Workspace_SCORM.zip — built by `dev/build_release.py`, published by `.github/workflows/release-zip.yml` on every push to `main` that touches the template |

**Rule:** the repo holds the latest *working* version. After each verified change, push to `main` and update this file. **Don't copy files into the instructor's local folder** (instructor's request, 2026-10-16); they get the template from the release download link.

**Docs standard:** INSTRUCTOR_GUIDE.md and README.md are for non-developer instructors. Keep them to short numbered steps, use the button names exactly as shown in the UI, and explain any file, folder or command in one line. Update the guide whenever a visible label or workflow changes.

## Architecture
```
Template folder (instructor)                 Exported student package (D2L)
├─ index.html, css/, js/app.js  ──────────►  same core files
├─ js/worker.js, js/harness.py, js/scorm.js  (index.html body gets data-package="1")
├─ js/instructor.js        (template only)   ✗ not exported
├─ assignment/assignment.json  ┐             assignment.dat  (settings + tests + files,
├─ assignment/instructions.md  ├─ export ──►   XOR+base64 encoded; no solutions)
├─ assignment/files/<path>     │             imsmanifest.xml (generated)
├─ assignment/solution/<path>  ┘ ✗ never exported
└─ imsmanifest.xml (template manifest), Start-Instructor-Workspace-{Mac.command,Windows.bat}
```
**How `js/app.js` finds the assignment:**

1. `body[data-package]` is present → load `assignment.dat` (student mode, SCORM on).
2. Otherwise → load `assignment/assignment.json` (template); load `js/instructor.js`; start in Instructor Mode.
3. Otherwise → **legacy**: read the `<file>` tags in `imsmanifest.xml` plus a root `instructions.md`. This keeps old packages working.

**Modes:** `instructor`, `preview` (exactly what students see, with no SCORM), and `student`.

**File roles:**

* `starter`: editable by students.
* `readonly`: visible to students but locked. The editor is read-only, the file is `chmod 444` in the Pyodide FS, and it is restored before every test.
* `hidden`: never shown to students. It exists only in the grader's file system.

**Run Code:** runs in the persistent `worker.js` through `harness._ws_run`.

* `input()` is interactive and uses a **replay model**. When the program asks for input, it stops. The student types a line, and the program is re-run with all inputs so far; output already shown is skipped. `random` is seeded per session so replays are deterministic.
* Workspace modules are purged before each run, so edits to helper modules take effect.

**Grading (`runTestSuite` in app.js):**

* A **fresh grader worker** starts each time tests run.
* For each test, the file set is re-synced. The student's files are used, with read-only and hidden files overlaid.
* The worker calls `harness._ws_grade`. Builtins are reset, cached modules are cleared, imports of `js`/`pyodide` are blocked, and stdin is fed from the test. Prompts are not echoed.
* The result is matched to the request with a nonce. If a test exceeds its time limit, the main thread terminates the worker, marks the test failed, and starts a new worker for the next test.
* **Comparison happens in JS.** Output tests support `normalized`, `contains`, `exact` and `regex` matching. Function tests compare canonical values with a float tolerance. Custom code tests pass when no assertion fails.

**SCORM (`js/scorm.js`):**

* On load: `LMSInitialize`, then status is set to `incomplete`.
* Each time tests run: `score.raw/min/max` and `lesson_status` are set. Status is `passed`/`failed` if a passing score is set, otherwise `completed`. `suspend_data` stores `{best,last,runs}`.
* Grade policy is `best` (the default) or `last`. The best score is also seeded from the existing `score.raw`.
* On exit: `exit=suspend`, `session_time`, then `LMSFinish`.

**Terminal shell (`_ws_shell` in harness.py; line editing in app.js "Terminal shell"):**

* A small Linux-style shell over the real Pyodide file system, shown as `/home/student` (`~`). Commands: `ls -la`, `cd`, `pwd`, `cat`, `head`/`tail -n`, `wc`, `grep -invcrlwE` (basic regex unless `-E`), `find -name/-type`, `tree`, `which`, `echo`, `touch`, `mkdir -p`, `rm -r`, `rmdir`, `cp -r`, `mv`, `chmod` (octal or `u+x`), `whoami`, `help`, `python file.py`; JS handles `history` and `clear`. Pipes, `>`/`>>`, `;` and `&&` work, and quoted text is never globbed.
* The prompt, cursor keys, Up/Down history, Tab completion (from the file tree) and Ctrl+C/L/A/E/U run in JS. Keys typed while a command runs are buffered and replayed.
* Rules come from each `sync`: `readonly` files can't be written, moved, removed or chmod'ed; `keep` (assignment files, student modes only) can be edited but not removed. The shell can't leave `/workspace`. Instructor mode has no restrictions.
* **File changes flow back:** after every shell command and every finished run, `worker.js` diffs `/workspace` against the last sync (`diffFS`) and `applyFsChanges` folds new/changed/removed files into the tree under the usual rules (protected files, `allowNewFiles`, no shadowing package files). Anything rejected is reverted by re-syncing. Files over 2 MB aren't adopted. `sys.dont_write_bytecode` keeps `__pycache__` out; `umask 022` gives normal permissions.
* Each input replay re-syncs first, so a program that appends to a file doesn't append twice.

**Theme and UI kit (top of app.js):** `data-theme` on `<html>` is set by an inline script in `index.html` before first paint, from `localStorage['pyws:theme']` (`system` | `light` | `dark`, default `system`, which follows `prefers-color-scheme` live). All colors are tokens in `css/styles.css` (`:root`/`[data-theme=dark]` and `[data-theme=light]`), including CodeMirror syntax colors; xterm gets its palette from `terminalTheme()`. Icons are inline SVG (`ICON_PATHS`, `icon()`), buttons are set with `setBtn()`, and `menuButton()` is the accessible dropdown (arrow keys, Esc, click-outside). `App.icon/setBtn/menuButton` are exposed for instructor.js.

**Student conveniences:** work autosaves to `localStorage` under the key `pyws:work:<id>:<title>`. Students can reset a single file to the starter code, and a "Start over" banner appears when saved work is restored.

## Instructor Mode features (`js/instructor.js`)
* **Toolbar:** Instructor / Student preview switch, a **Project** menu (New assignment, Open…, Save Project), and **Publish**. Students see only Run, Run Tests, theme and Exit.
* **File tree:** S/R/H role badges (click to change), a ★ marker on files with a solution, and upload or drag-and-drop.
* **Editor header:** a Starter / ★ Solution toggle, with prompts to create or remove a solution version.
* **Tabs:**
  * **Instructions:** Markdown editor with a preview.
  * **Tests:** add, edit, reorder, duplicate and delete tests; run one test or all tests against the solution or the starter; **Fill from solution** for expected values; status chips that show when results are stale.
  * **Settings:** title, entry file, passing score, grade policy, whether students can create files.
  * **Publish:** checklist, export, and D2L steps.
* **Drafts:** the project autosaves to `localStorage` under the key `pyws:instructor-draft:<path>`. A banner offers "Discard draft".
* **Export:** if the project still has the sample's id (`sample-assignment`), export generates a new id so student autosave keys don't collide between packages.

## Current state
* **Done and verified:** 43/43 automated E2E checks pass in headless Chromium against the real Pyodide 0.27.3 runtime, with a mock D2L SCORM API. They cover:
  * instructor boot
  * validating tests against the solution and the starter
  * fill from solution
  * the checklist
  * preview
  * export contents
  * save/open round trip
  * opening an exported package
  * the student package in an iframe with the SCORM API
  * starter scores 0%; the solution with tamper attempts scores 100%
  * the best-score policy
  * infinite-loop timeouts
  * interactive input
  * helper-module reload
  * traceback highlighting
  * autosave and restore
  * `LMSFinish`
  * legacy packages
* **Sample assignment:** Temperature Converter. It has 7 tests worth 9 points and uses all three file roles.
* **First D2L test (2026-10-16, exported sample lab, "View as Student", player opened in a new window, review/retake on; grade item Yes on the exported sample lab, No on a separately uploaded instructor template):** the package loads from the real CDNs, Run Code and Run Tests work, a grade item was created, and work persists across close/reopen (browser autosave). **The grade item stayed empty.** The results panel showed **"Score sent to D2L: 67% (your best score counts)."** That means the D2L SCORM API was found and `LMSCommit` returned `true`, so the package side works. The missing grade is attributed to View as Student not saving gradebook data. **Next:** retest with a demo or real student account and confirm the grade item fills in.
* **Possible gap:** `js/scorm.js` ignores `cmi.core.lesson_mode`. If D2L reopens a completed attempt in review mode, later score updates may be dropped.
* **Not yet verified on real D2L grade reporting:** the sandbox had no CDN access, so tests used local copies with an xterm stub. **Next step: the instructor should run the template locally, export, upload to a D2L sandbox course, and confirm the grade item updates.**

## Release zip
* `dev/build_release.py` zips the **git-tracked** files of `Python_LMS_Workspace_SCORM/` with `imsmanifest.xml` at the zip root, so it is a valid SCORM package and also runs locally after unzipping. It leaves out `HANDOFF.md`, keeps the Mac `.command` executable, and writes fixed timestamps so identical sources give identical zips.
* The build **fails if `imsmanifest.xml` lists a file that isn't packaged.** When you add or rename a template file, update the template manifest.
* The Action moves the `template-latest` tag to the pushed commit and replaces the release asset (`--clobber`), so the download URL never changes.
* Uploading this template zip to D2L gives an **instructor sandbox**: it includes Instructor Mode and `assignment/solution/`. Students should get only packages made with **Publish → Export for D2L**.

## Known limitations / ideas
1. Client-side grading is tamper-*resistant*, not tamper-proof. A student with devtools can call `API.LMSSetValue` directly. This is documented in INSTRUCTOR_GUIDE.md, with a mitigation: also collect the downloaded zip.
2. The replay input model assumes deterministic programs. Time-based output may differ between replays.
3. ~~Runtime-created files aren't added to the tree~~ — fixed: they are adopted (see Terminal shell). Files a program creates are still kept only if the assignment allows new files.
4. Everything loads from CDNs (jsdelivr, cdnjs), so students need internet access. Vendoring the libraries is possible if needed (~10 MB for Pyodide).
5. Empty folders aren't saved in projects.
6. No per-test `stdin` for Run Code presets, and no attempt limits.
7. The shell is simulated: no environment variables, `$(...)`, `||`, background jobs, or interactive Python REPL. `chmod` changes stick for the session but aren't saved with student work.
8. The in-app browser pane used for checking sometimes doesn't repaint after a theme switch; the page state is correct (verified with computed styles). Not seen in normal browsers.

## Change log
| Date | Change |
|---|---|
| 2026-10-16 | Recorded the recommended D2L upload settings (new window, built-in navigation, add review/retake, grade item Yes + Highest Attempt, always latest version) in INSTRUCTOR_GUIDE.md and the in-app Publish tab. |
| 2026-10-16 | Rewrote INSTRUCTOR_GUIDE.md: short steps, current button names, what the start script does, D2L grade-item/review-retake answers, new "Update to a new version" section. |
| 2026-10-16 | Workflow: changes go to the repo only; the instructor's local folder is no longer synced. |
| 2026-10-16 | **Terminal shell** (Linux-style commands with permissions; runtime files now appear in the tree), **light/dark theme** following the device with a System/Light/Dark menu, and a **modern UI**: token-based styles, SVG icons, Project dropdown, segmented switches, softer shadows, quieter file tree. Verified in the browser: shell + protections in Instructor, Preview and an exported package under a mock SCORM API; tests on solution 7/7; interactive input; score commit. E2E suite updated (Project menu, lock icon, 3 shell checks) but **not re-run** (needs the local CDN mirror described in dev/e2e). |
| 2026-10-16 | Recorded the first D2L upload test. In View as Student, D2L accepts the score commit, but no grade is recorded (expected). |
| 2026-10-16 | Added the instructor release zip: `dev/build_release.py`, the `release-zip` GitHub Action (`template-latest` release), a root README.md with the download link, and a download step in INSTRUCTOR_GUIDE.md. |
| 2026-10-16 | Cloned the repo to `WASM-Python-Interpreter-repo` and applied the unpushed v2 commits from `Claude outputs/WASM-Python-Interpreter-unpushed.bundle` (contents match the local copy). Instructor set up GitHub credentials and pushed; `origin/main` now includes v2. |
| 2026-10-16 | Confirmed the local folder matches the repo baseline (`04c44d0`). Added HANDOFF.md. |
| 2026-10-16 | **v2 architecture:** Instructor Mode, autograder (output, function and custom code tests), SCORM 1.2 reporting, file roles, interactive `input()`, student autosave, export/save/open, sample assignment, start scripts, INSTRUCTOR_GUIDE.md, E2E suite (`dev/e2e`). Pinned `marked@12.0.2`. Moved `instructions.md` to `assignment/`. |
