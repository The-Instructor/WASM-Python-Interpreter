importScripts("https://cdn.jsdelivr.net/pyodide/v0.27.3/full/pyodide.js");

let pyodide = null;
let currentFiles = {};

async function initializePyodide() {
    pyodide = await loadPyodide();
    
    pyodide.setStdout({ batched: (msg) => postMessage({ type: 'stdout', data: msg }) });
    pyodide.setStderr({ batched: (msg) => postMessage({ type: 'stderr', data: msg }) });
    
    postMessage({ type: 'ready' });
}

initializePyodide();

self.onmessage = async (e) => {
    if (e.data.cmd === 'sync') {
        const newFiles = e.data.files;
        
        // Remove files/folders from MEMFS that no longer exist in virtualFiles
        for (const path of Object.keys(currentFiles)) {
            if (!(path in newFiles)) {
                try {
                    if (currentFiles[path] === null) {
                        pyodide.FS.rmdir(path);
                    } else {
                        pyodide.FS.unlink(path);
                    }
                } catch (err) {
                    // Ignore if already unlinked or parent removed
                }
            }
        }

        // Add or update new/existing files and folders in MEMFS
        for (const [path, content] of Object.entries(newFiles)) {
            if (content === null) {
                // Folder
                try {
                    pyodide.FS.mkdir(path);
                } catch (err) {
                    // Directory may already exist
                }
            } else {
                // Ensure parent directories exist
                const parts = path.split('/');
                parts.pop();
                let curr = "";
                for (let p of parts) {
                    curr = curr ? `${curr}/${p}` : p;
                    try {
                        pyodide.FS.mkdir(curr);
                    } catch (err) {}
                }
                pyodide.FS.writeFile(path, content);
            }
        }
        currentFiles = JSON.parse(JSON.stringify(newFiles));
    } else if (e.data.cmd === 'run') {
        try {
            const entrypoint = e.data.entrypoint;
            await pyodide.runPythonAsync(currentFiles[entrypoint]);
            postMessage({ type: 'done' });
        } catch (err) {
            postMessage({ type: 'stderr', data: String(err) });
            postMessage({ type: 'done' });
        }
    }
};
