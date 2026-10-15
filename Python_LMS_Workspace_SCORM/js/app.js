// Initialize xterm.js Terminal UI
const term = new Terminal({
    cursorBlink: true,
    theme: { background: '#181818', foreground: '#f0f0f0' },
    fontFamily: 'Consolas, "Courier New", monospace',
    fontSize: 13
});
term.open(document.getElementById('terminal-container'));
term.writeln('\x1b[33mSystem: Loading background worker runtime...\x1b[0m\r\n');

// =========================================================================
// INSTRUCTOR PLACEHOLDER: Define starter files and virtual workspace here.
// Use comments to indicate editable zones vs. danger zones.
// =========================================================================
let virtualFiles = {
    "main.py": 
`# ==========================================
# DANGER ZONE: DO NOT MODIFY BELOW THIS LINE
# Automated test runner and environment hooks.
# ==========================================
import sys

def _run_tests():
    print("--- Running Test Suite ---")
    try:
        from solution import calculate_total
        assert calculate_total([10, 20, 30]) == 60
        print("Test 1 Passed: calculate_total()")
    except Exception as e:
        print(f"Test Failed: {e}")

# ==========================================
# STUDENT EDITABLE ZONE: Complete your code below
# ==========================================
if __name__ == "__main__":
    print("Starting Assignment execution...")
    _run_tests()
`,
    "solution.py":
`# ==========================================
# STUDENT EDITABLE ZONE
# Implement your solution functions here.
# ==========================================

def calculate_total(items):
    """
    TODO: Implement logic to sum up items and return the total.
    """
    # Write your code here
    return 0
`
};

let activeFile = "main.py";
let worker = null;
let isRunning = false;

// Render Markdown instructions on load
document.addEventListener("DOMContentLoaded", () => {
    const rawMarkdown = document.getElementById("instructions-content").innerHTML;
    document.getElementById("instructions-content").innerHTML = marked.parse(rawMarkdown);
});

function initFileExplorer() {
    const listEl = document.getElementById('file-list');
    listEl.innerHTML = '';
    
    Object.keys(virtualFiles).forEach(filename => {
        const li = document.createElement('li');
        li.className = `file-item ${filename === activeFile ? 'active' : ''}`;
        
        const span = document.createElement('span');
        span.innerText = filename;
        span.onclick = () => switchFile(filename);
        li.appendChild(span);

        if (filename !== 'main.py' && filename !== 'solution.py') {
            const delBtn = document.createElement('button');
            delBtn.className = 'file-delete';
            delBtn.innerText = '✕';
            delBtn.onclick = (e) => {
                e.stopPropagation();
                deleteFile(filename);
            };
            li.appendChild(delBtn);
        }

        listEl.appendChild(li);
    });

    document.getElementById('code-editor').value = virtualFiles[activeFile] || '';
}

function switchFile(filename) {
    activeFile = filename;
    initFileExplorer();
}

function updateActiveFileContent() {
    if (activeFile) {
        virtualFiles[activeFile] = document.getElementById('code-editor').value;
    }
}

function createNewFile() {
    const filename = prompt("Enter new filename (e.g., utils.py, data.csv):");
    if (!filename) return;
    const cleanName = filename.trim();
    
    if (virtualFiles[cleanName]) {
        alert("A file with that name already exists.");
        return;
    }

    virtualFiles[cleanName] = `# ==========================================\n# STUDENT FILE: ${cleanName}\n# ==========================================\n`;
    switchFile(cleanName);
}

function deleteFile(filename) {
    if (confirm(`Are you sure you want to delete ${filename}?`)) {
        delete virtualFiles[filename];
        if (activeFile === filename) {
            activeFile = 'main.py';
        }
        initFileExplorer();
    }
}

function toggleSidebar() {
    const sidebar = document.getElementById('file-sidebar');
    sidebar.classList.toggle('collapsed');
}

function spawnWorker() {
    worker = new Worker('js/worker.js');

    worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === 'ready') {
            term.writeln('\x1b[32m[Container Ready]\x1b[0m Virtual file system loaded.\r\n');
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
    updateActiveFileContent();
    if (isRunning) {
        worker.terminate();
        term.writeln('\r\n\x1b[31m[Process Terminated by User]\x1b[0m\r\n');
        setButtonState(false);
        spawnWorker();
    } else {
        setButtonState(true);
        term.writeln(`\x1b[36m$ python3 ${activeFile}\x1b[0m`);
        worker.postMessage({ cmd: 'run', files: virtualFiles, entrypoint: activeFile });
    }
}

function setButtonState(running) {
    isRunning = running;
    const btn = document.getElementById('action-btn');
    btn.className = running ? 'stop-btn' : 'run-btn';
    btn.innerText = running ? '⏹ Stop Process' : '▶ Run Code';
}

function returnToCourse() {
    if (confirm("Are you sure you want to exit this lab?")) {
        window.close();
    }
}

// Initial boot
initFileExplorer();
spawnWorker();
