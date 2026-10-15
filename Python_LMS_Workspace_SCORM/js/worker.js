importScripts("https://cdn.jsdelivr.net/pyodide/v0.27.3/full/pyodide.js");

let pyodide = null;

async function initializePyodide() {
    pyodide = await loadPyodide();
    
    pyodide.setStdout({ batched: (msg) => postMessage({ type: 'stdout', data: msg }) });
    pyodide.setStderr({ batched: (msg) => postMessage({ type: 'stderr', data: msg }) });
    
    postMessage({ type: 'ready' });
}

initializePyodide();

self.onmessage = async (e) => {
    if (e.data.cmd === 'run') {
        try {
            const files = e.data.files;
            // Synchronize all virtual files into Pyodide's MEMFS
            for (const [filename, content] of Object.entries(files)) {
                pyodide.FS.writeFile(filename, content);
            }

            // Execute the designated entrypoint script
            await pyodide.runPythonAsync(files[e.data.entrypoint]);
            postMessage({ type: 'done' });
        } catch (err) {
            postMessage({ type: 'stderr', data: String(err) });
            postMessage({ type: 'done' });
        }
    }
};
