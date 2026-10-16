importScripts("https://cdn.jsdelivr.net/pyodide/v0.27.3/full/pyodide.js");

let pyodide = null;
let resolveReady;
const readyPromise = new Promise((res) => { resolveReady = res; });

async function initializePyodide() {
    pyodide = await loadPyodide();
    pyodide.FS.mkdir("/workspace");
    pyodide.FS.chdir("/workspace");
    
    pyodide.setStdout({ batched: (msg) => postMessage({ type: 'stdout', data: msg }) });
    pyodide.setStderr({ batched: (msg) => postMessage({ type: 'stderr', data: msg }) });
    
    resolveReady();
    postMessage({ type: 'ready' });
}

initializePyodide();

// Helper to walk FS starting at relative dir and return paths relative to /workspace
function walkFS(dir = ".", fileList = []) {
    try {
        const entries = pyodide.FS.readdir(dir);
        for (const entry of entries) {
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

self.onmessage = async (e) => {
    await readyPromise;
    if (e.data.cmd === 'sync') {
        const newFiles = e.data.files;
        
        // Write files to "/workspace/" + path
        for (const [path, content] of Object.entries(newFiles)) {
            const targetPath = "/workspace/" + path;
            if (content === null) {
                try {
                    pyodide.FS.mkdir(targetPath);
                } catch (err) {}
            } else {
                const parts = path.split('/');
                parts.pop();
                let curr = "/workspace";
                for (let p of parts) {
                    curr = `${curr}/${p}`;
                    try {
                        pyodide.FS.mkdir(curr);
                    } catch (err) {}
                }
                pyodide.FS.writeFile(targetPath, content);
            }
        }

        // Mirror cleanup inside /workspace (deepest paths first)
        const existingItems = walkFS(".");
        existingItems.sort((a, b) => b.path.split('/').length - a.path.split('/').length);

        for (const item of existingItems) {
            if (!(item.path in newFiles)) {
                try {
                    if (item.isDir) {
                        pyodide.FS.rmdir(item.path);
                    } else {
                        pyodide.FS.unlink(item.path);
                    }
                } catch (err) {
                    console.error("FS deletion failed for path:", item.path, err);
                }
            }
        }

        const finalListing = walkFS(".");
        console.log("Pyodide Virtual FS Mirror:", finalListing.map(i => i.path));

    } else if (e.data.cmd === 'run') {
        try {
            const entrypoint = "/workspace/" + e.data.entrypoint;
            const code = pyodide.FS.readFile(entrypoint, { encoding: 'utf8' });
            await pyodide.runPythonAsync(code);
            postMessage({ type: 'done' });
        } catch (err) {
            postMessage({ type: 'stderr', data: String(err) });
            postMessage({ type: 'done' });
        }
    }
};
