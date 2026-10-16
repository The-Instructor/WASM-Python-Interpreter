// ---------------------------------------------------------------------------
// Pyodide Web Worker. Core system file (instructors do not edit).
// Messages in:
//   {cmd:'sync',  files:{path:content|null}, binary:[paths], readonly:[paths], keep:[paths]}
//   {cmd:'run',   entrypoint, inputs:[...], seed}
//   {cmd:'grade', files, binary, readonly, test, nonce}
//   {cmd:'shell', line, cwd}
// Messages out: ready | stdout | stderr | needInput | done | gradeResult | fatal
//               shellResult | fsChanges
// After a shell command or a finished run, the worker reports files that were
// created, changed or removed in /workspace so the page can update its tree.
// ---------------------------------------------------------------------------
importScripts("https://cdn.jsdelivr.net/pyodide/v0.27.3/full/pyodide.js");

let pyodide = null;
let shellRules = { readonly: [], keep: [] }; // from the last sync: what the shell may not change/remove
let baseline = new Map(); // /workspace snapshot after the last sync or report
const MAX_ADOPT_BYTES = 2 * 1024 * 1024;
let resolveReady;
const readyPromise = new Promise((res) => { resolveReady = res; });

async function initializePyodide() {
    try {
        pyodide = await loadPyodide();
        pyodide.FS.mkdir("/workspace", 0o755);
        pyodide.FS.chdir("/workspace");
        pyodide.setStdout({ batched: (msg) => postMessage({ type: 'stdout', data: msg + "\n" }) });
        pyodide.setStderr({ batched: (msg) => postMessage({ type: 'stderr', data: msg + "\n" }) });
        const harnessUrl = new URL('harness.py', self.location.href).href;
        const src = await (await fetch(harnessUrl)).text();
        pyodide.runPython(src);
        resolveReady();
        postMessage({ type: 'ready', commands: JSON.parse(pyodide.globals.get('_ws_shell_commands')()) });
    } catch (err) {
        postMessage({ type: 'fatal', data: "Python runtime failed to load: " + String(err) });
    }
}
initializePyodide();

// Lists /workspace recursively; paths are relative to it.
function walkFS(rel = "", fileList = []) {
    const dir = rel ? "/workspace/" + rel : "/workspace";
    try {
        for (const entry of pyodide.FS.readdir(dir)) {
            if (entry === "." || entry === ".." || entry === "__pycache__") continue;
            const path = rel ? `${rel}/${entry}` : entry;
            try {
                const stat = pyodide.FS.stat("/workspace/" + path);
                if (pyodide.FS.isDir(stat.mode)) {
                    fileList.push({ path, isDir: true });
                    walkFS(path, fileList);
                } else if (pyodide.FS.isFile(stat.mode)) {
                    fileList.push({ path, isDir: false, size: stat.size });
                }
            } catch (err) {}
        }
    } catch (err) {}
    return fileList;
}

function bytesToB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

function snapshot() {
    const snap = new Map();
    for (const item of walkFS()) {
        if (item.isDir) snap.set(item.path, null);
        else if (item.size > MAX_ADOPT_BYTES) snap.set(item.path, { tooLarge: true, size: item.size });
        else { try { snap.set(item.path, pyodide.FS.readFile("/workspace/" + item.path)); } catch (err) {} }
    }
    return snap;
}

function sameBytes(a, b) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

// What changed in /workspace since the last baseline. Resets the baseline.
function diffFS() {
    const now = snapshot();
    const changes = { written: {}, dirs: [], removed: [], skipped: [] };
    let any = false;
    for (const [path, data] of now) {
        const before = baseline.get(path);
        if (data === null) {
            if (before !== null) { changes.dirs.push(path); any = true; }
            if (before !== undefined && before !== null) { changes.removed.push(path); }
            continue;
        }
        if (data.tooLarge) {
            if (!baseline.has(path)) { changes.skipped.push(path); any = true; }
            continue;
        }
        if (sameBytes(before, data)) continue;
        let text = null;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch (err) {}
        changes.written[path] = text !== null ? { text } : { b64: bytesToB64(data) };
        any = true;
    }
    for (const path of baseline.keys()) {
        if (!now.has(path)) { changes.removed.push(path); any = true; }
    }
    baseline = now;
    return any ? changes : null;
}

function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

// Mirror the given file map into /workspace exactly (adds, updates, removes).
function syncFiles(newFiles, binaryList, readonlyList) {
    const binary = new Set(binaryList || []);
    const readonly = new Set(readonlyList || []);
    pyodide.FS.chdir("/workspace");
    for (const [path, content] of Object.entries(newFiles)) {
        const targetPath = "/workspace/" + path;
        if (content === null) {
            try { pyodide.FS.mkdirTree(targetPath, 0o755); } catch (err) {}
        } else {
            const parts = path.split('/'); parts.pop();
            if (parts.length) { try { pyodide.FS.mkdirTree("/workspace/" + parts.join('/'), 0o755); } catch (err) {} }
            // Keep permissions the student set with chmod; protected files are always 0444.
            let mode = 0o644;
            try { const st = pyodide.FS.stat(targetPath); if (pyodide.FS.isFile(st.mode)) mode = (st.mode & 0o777) | 0o200; } catch (err) {}
            try { pyodide.FS.chmod(targetPath, 0o644); } catch (err) {}
            pyodide.FS.writeFile(targetPath, binary.has(path) ? b64ToBytes(content) : content);
            // Protected (read-only / hidden) files cannot be overwritten by student code.
            try { pyodide.FS.chmod(targetPath, readonly.has(path) ? 0o444 : mode); } catch (err) {}
        }
    }
    const existing = walkFS();
    existing.sort((a, b) => b.path.split('/').length - a.path.split('/').length);
    const keep = new Set(Object.keys(newFiles));
    // keep parent folders of kept files
    for (const p of Object.keys(newFiles)) {
        const parts = p.split('/');
        for (let i = 1; i < parts.length; i++) keep.add(parts.slice(0, i).join('/'));
    }
    for (const item of existing) {
        if (keep.has(item.path)) continue;
        const full = "/workspace/" + item.path;
        try {
            if (!item.isDir) { try { pyodide.FS.chmod(full, 0o644); } catch (err) {} }
            if (item.isDir) pyodide.FS.rmdir(full); else pyodide.FS.unlink(full);
        } catch (err) {}
    }
}

self.onmessage = async (e) => {
    await readyPromise;
    const msg = e.data;
    if (msg.cmd === 'sync') {
        syncFiles(msg.files, msg.binary, msg.readonly);
        shellRules = { readonly: msg.readonly || [], keep: msg.keep || [] };
        baseline = snapshot();
    } else if (msg.cmd === 'shell') {
        let result;
        try {
            const shellFn = pyodide.globals.get('_ws_shell');
            result = JSON.parse(shellFn(msg.line, msg.cwd || '', JSON.stringify(shellRules), true));
            shellFn.destroy();
        } catch (err) {
            result = { out: String(err) + "\n", cwd: msg.cwd, code: 1 };
        }
        try { pyodide.FS.chdir("/workspace"); } catch (err) {}
        postMessage({ type: 'shellResult', result, changes: diffFS() });
    } else if (msg.cmd === 'run') {
        try {
            const runFn = pyodide.globals.get('_ws_run');
            const status = runFn(
                msg.entrypoint,
                JSON.stringify(msg.inputs || []),
                msg.seed || 0,
                (text) => postMessage({ type: 'stdout', data: text }),
                (text) => postMessage({ type: 'stderr', data: text })
            );
            runFn.destroy();
            if (status === 'need_input') {
                postMessage({ type: 'needInput' });
            } else {
                postMessage({ type: 'done', changes: diffFS() });
            }
        } catch (err) {
            postMessage({ type: 'stderr', data: String(err) + "\n" });
            postMessage({ type: 'done', changes: diffFS() });
        }
    } else if (msg.cmd === 'grade') {
        const nonce = msg.nonce; // kept in local scope only
        let result;
        try {
            syncFiles(msg.files, msg.binary, msg.readonly);
            const gradeFn = pyodide.globals.get('_ws_grade');
            result = JSON.parse(gradeFn(JSON.stringify(msg.test)));
            gradeFn.destroy();
        } catch (err) {
            result = { error: "Test runner error: " + String(err) };
        }
        postMessage({ type: 'gradeResult', nonce, result });
    }
};
