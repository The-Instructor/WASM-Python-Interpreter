// Initialize xterm.js Terminal UI
const term = new Terminal({
    cursorBlink: true,
    theme: { background: '#181818', foreground: '#f0f0f0' },
    fontFamily: 'Consolas, "Courier New", monospace',
    fontSize: 13
});
term.open(document.getElementById('terminal-container'));
term.writeln('\x1b[33mSystem: Loading background worker runtime...\x1b[0m\r\n');

let worker = null;
let isRunning = false;

function spawnWorker() {
    worker = new Worker('js/worker.js');

    worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === 'ready') {
            term.writeln('\x1b[32m[Container Ready]\x1b[0m Ready for execution.\r\n');
        } else if (msg.type === 'stdout') {
            term.writeln(msg.data);
        } else if (msg.type === 'stderr') {
            term.writeln(`\x1b[31m${msg.data}\x1b[0m`);
        } else if (msg.type === 'done') {
            setButtonState(false);
        }
    };
}

function toggleExecution() {
    if (isRunning) {
        // Immediate termination safety hatch for infinite loops
        worker.terminate();
        term.writeln('\r\n\x1b[31m[Process Terminated by User]\x1b[0m\r\n');
        setButtonState(false);
        spawnWorker(); // Reboot clean worker instance
    } else {
        setButtonState(true);
        term.writeln('\x1b[36m$ python3 main.py\x1b[0m');
        const code = document.getElementById('code-editor').value;
        worker.postMessage({ cmd: 'run', code: code });
    }
}

function setButtonState(running) {
    isRunning = running;
    const btn = document.getElementById('action-btn');
    btn.className = running ? 'stop-btn' : 'run-btn';
    btn.innerText = running ? '⏹ Stop Process' : '▶ Run Code';
}

// Initial boot
spawnWorker();
