importScripts("https://cdn.jsdelivr.net/pyodide/v0.27.3/full/pyodide.js");

let pyodide = null;

async function initializePyodide() {
    pyodide = await loadPyodide();
    
    // Pipe Python stdout/stderr back to main thread instantly
    pyodide.setStdout({ batched: (msg) => postMessage({ type: 'stdout', data: msg }) });
    pyodide.setStderr({ batched: (msg) => postMessage({ type: 'stderr', data: msg }) });
    
    postMessage({ type: 'ready' });
}

initializePyodide();

self.onmessage = async (e) => {
    if (e.data.cmd === 'run') {
        try {
            await pyodide.runPythonAsync(e.data.code);
            postMessage({ type: 'done' });
        } catch (err) {
            postMessage({ type: 'stderr', data: String(err) });
            postMessage({ type: 'done' });
        }
    }
};
