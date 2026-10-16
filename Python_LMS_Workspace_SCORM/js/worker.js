// ---------------------------------------------------------------------------
// Pyodide Web Worker. Core system file (instructors do not edit).
// Messages in:
//   {cmd:'sync',  files:{path:content|null}, binary:[paths], readonly:[paths]}
//   {cmd:'run',   entrypoint, inputs:[...], seed}
//   {cmd:'grade', files, binary, readonly, test, nonce}
// Messages out: ready | stdout | stderr | needInput | done | gradeResult | fatal
// ---------------------------------------------------------------------------
importScripts("https://cdn.jsdelivr.net/pyodide/v0.27.3/full/pyodide.js");

let pyodide = null;
let resolveReady;
const readyPromise = new Promise((res) => { resolveReady = res; });

async function initializePyodide() {
    try {
        pyodide = await loadPyodide();
        pyodide.FS.mkdir("/workspace");
        pyodide.FS.chdir("/workspace");
        pyodide.setStdout({ batched: (msg) => postMessage({ type: 'stdout', data: msg + "\n" }) });
        pyodide.setStderr({ batched: (msg) => postMessage({ type: 'stderr', data: msg + "\n" }) });
        const harnessUrl = new URL('harness.py', self.location.href).href;
        const src = await (await fetch(harnessUrl)).text();
        pyodide.runPython(src);
        resolveReady();
        postMessage({ type: 'ready' });
    } catch (err) {
        postMessage({ type: 'fatal', data: "Python runtime failed to load: " + String(err) });
    }
}
initializePyodide();

function walkFS(dir = ".", fileList = []) {
    try {
        for (const entry of pyodide.FS.readdir(dir)) {
            if (entry === "." || entry === "..") continue;
            const fullPath = dir === "." ? entry : `${dir}/${entry}`;
            try {
                const stat = pyodide.FS.stat(fullPath);
                if (pyodide.FS.isDir(stat.mode)) {
                    fileList.push({ path: fullPath, isDir: true });
                    walkFS(fullPath, fileList);
                } else if (pyodide.FS.isFile(stat.mode)) {
                    fileList.push({ path: fullPath, isDir: false });
                }
            } catch (err) {}
        }
    } catch (err) {}
    return fileList;
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
            try { pyodide.FS.mkdirTree(targetPath); } catch (err) {}
        } else {
            const parts = path.split('/'); parts.pop();
            if (parts.length) { try { pyodide.FS.mkdirTree("/workspace/" + parts.join('/')); } catch (err) {} }
            try { pyodide.FS.chmod(targetPath, 0o644); } catch (err) {}
            pyodide.FS.writeFile(targetPath, binary.has(path) ? b64ToBytes(content) : content);
            // Protected (read-only / hidden) files cannot be overwritten by student code.
            if (readonly.has(path)) { try { pyodide.FS.chmod(targetPath, 0o444); } catch (err) {} }
        }
    }
    const existing = walkFS(".");
    existing.sort((a, b) => b.path.split('/').length - a.path.split('/').length);
    const keep = new Set(Object.keys(newFiles));
    // keep parent folders of kept files
    for (const p of Object.keys(newFiles)) {
        const parts = p.split('/');
        for (let i = 1; i < parts.length; i++) keep.add(parts.slice(0, i).join('/'));
    }
    for (const item of existing) {
        if (keep.has(item.path)) continue;
        try {
            if (!item.isDir) { try { pyodide.FS.chmod(item.path, 0o644); } catch (err) {} }
            if (item.isDir) pyodide.FS.rmdir(item.path); else pyodide.FS.unlink(item.path);
        } catch (err) {}
    }
}

self.onmessage = async (e) => {
    await readyPromise;
    const msg = e.data;
    if (msg.cmd === 'sync') {
        syncFiles(msg.files, msg.binary, msg.readonly);
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
                postMessage({ type: 'done' });
            }
        } catch (err) {
            postMessage({ type: 'stderr', data: String(err) + "\n" });
            postMessage({ type: 'done' });
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
