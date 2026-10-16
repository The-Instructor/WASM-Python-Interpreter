# End-to-end tests (developer only)

`run_tests.js` drives the real workspace in headless Chromium (Playwright):
instructor template → validate tests on solution/starter → export → load the
exported package inside a mock D2L SCORM 1.2 API (`scorm_host.html`) → grade,
tamper attempts, timeouts, interactive input, autosave, LMSFinish, legacy package.

The sandbox this was built in had no CDN access, so CDN URLs are routed to local
copies. To prepare `$E2E_DIR` (default `/home/claude/testenv`):

| Library | Source used |
|---|---|
| Pyodide 0.27.3 core | `github.com/pyodide/pyodide/releases/download/0.27.3/pyodide-core-0.27.3.tar.bz2` → `$E2E_DIR/pyodide/` |
| CodeMirror 5.65.16 | clone tag `5.65.16` → `$E2E_DIR/cm/`; bundle `src/codemirror.js` with `bun build --format=iife` → `$E2E_DIR/vendor/codemirror.js` |
| JSZip 3.10.1 | `Stuk/jszip` tag `v3.10.1` `dist/jszip.min.js` → `$E2E_DIR/vendor/` |
| marked | any UMD build → `$E2E_DIR/vendor/marked.min.js` |
| xterm | `xterm-stub.js` (records output, simulates typing) → `$E2E_DIR/vendor/` |

Then serve `$E2E_DIR/site` (containing `scorm_host.html` and a `template` symlink to
`Python_LMS_Workspace_SCORM`) on `127.0.0.1:8899` and run
`PLAYWRIGHT_PATH=<playwright module> node run_tests.js`.
