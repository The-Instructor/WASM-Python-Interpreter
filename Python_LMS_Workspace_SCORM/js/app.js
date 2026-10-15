// Initialize xterm.js Terminal UI
const term = new Terminal({
    cursorBlink: true,
    theme: { background: '#181818', foreground: '#f0f0f0' },
    fontFamily: 'Consolas, "Courier New", monospace',
    fontSize: 13
});
term.open(document.getElementById('terminal-container'));
term.writeln('\x1b[33mSystem: Loading background worker runtime...\x1b[0m\r\n');

// State Management
let virtualFiles = {};
let activeFile = null;
let worker = null;
let isRunning = false;

// Initialize Workspace on Load
document.addEventListener("DOMContentLoaded", async () => {
    await loadInstructions();
    await discoverManifestFiles();
    initSplitters();
});

// Load Instructions from instructions.md
async function loadInstructions() {
    try {
        const response = await fetch('instructions.md');
        if (!response.ok) throw new Error("Could not load instructions.md");
        const markdownText = await response.text();
        document.getElementById("instructions-content").innerHTML = marked.parse(markdownText);
    } catch (err) {
        document.getElementById("instructions-content").innerHTML = `<p style="color: #d12424;">Error loading instructions: ${err.message}</p>`;
    }
}

// Auto-discover starter files declared in imsmanifest.xml
async function discoverManifestFiles() {
    try {
        const response = await fetch('imsmanifest.xml');
        const text = await response.text();
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(text, "application/xml");
        
        const fileTags = xmlDoc.getElementsByTagName("file");
        const discovered = [];

        for (let tag of fileTags) {
            let href = tag.getAttribute("href");
            // Skip core system files
            if (href && !['imsmanifest.xml', 'index.html', 'instructions.md', 'css/styles.css', 'js/app.js', 'js/worker.js'].includes(href)) {
                discovered.push(href);
            }
        }

        if (discovered.length === 0) {
            // Default fallback if no starter files declared yet
            virtualFiles["main.py"] = `# Write your Python code here\nprint("Hello, World!")\n`;
        } else {
            for (let path of discovered) {
                // Fetch content of each declared starter file
                try {
                    const fileRes = await fetch(path);
                    if (fileRes.ok) {
                        const content = await fileRes.text();
                        // Strip folder prefix if any (e.g., store clean filename)
                        const filename = path.split('/').pop();
                        virtualFiles[filename] = content;
                    }
                } catch (e) {
                    console.warn(`Could not fetch starter file: ${path}`, e);
                }
            }
        }

        // Set initial active file
        const fileNames = Object.keys(virtualFiles);
        activeFile = fileNames.length > 0 ? fileNames[0] : "main.py";
        
        initFileExplorer();
        spawnWorker();

    } catch (err) {
        console.error("Manifest discovery failed:", err);
        virtualFiles["main.py"] = `# Error loading manifest\nprint("Hello World")`;
        activeFile = "main.py";
        initFileExplorer();
        spawnWorker();
    }
}

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

        const delBtn = document.createElement('button');
        delBtn.className = 'file-delete';
        delBtn.innerText = '✕';
        delBtn.onclick = (e) => {
            e.stopPropagation();
            deleteFile(filename);
        };
        li.appendChild(delBtn);

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
    const filename = prompt("Enter new filename (e.g., solution.py, data.csv):");
    if (!filename) return;
    const cleanName = filename.trim();
    
    if (virtualFiles[cleanName]) {
        alert("A file with that name already exists.");
        return;
    }

    virtualFiles[cleanName] = `# New file: ${cleanName}\n`;
    switchFile(cleanName);
}

function deleteFile(filename) {
    if (confirm(`Are you sure you want to delete ${filename}?`)) {
        delete virtualFiles[filename];
        const keys = Object.keys(virtualFiles);
        if (activeFile === filename) {
            activeFile = keys.length > 0 ? keys[0] : null;
        }
        initFileExplorer();
    }
}

function toggleSidebar() {
    const sidebar = document.getElementById('file-sidebar');
    sidebar.classList.toggle('collapsed');
}

// Resizable Splitter Logic
function initSplitters() {
    // Sidebar splitter
    const sidebar = document.getElementById('file-sidebar');
    const sidebarSplitter = document.getElementById('sidebar-splitter');
    
    sidebarSplitter.addEventListener('mousedown', (e) => {
        e.preventDefault();
        sidebarSplitter.classList.add('dragging');
        const onMouseMove = (e) => {
            const newWidth = e.clientX;
            if (newWidth > 100 && newWidth < 500) {
                sidebar.style.width = `${newWidth}px`;
            }
        };
        const onMouseUp = () => {
            sidebarSplitter.classList.remove('dragging');
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

    // Instructions splitter
    const instructionsPane = document.getElementById('instructions-pane');
    const instructionsSplitter = document.getElementById('instructions-splitter');

    instructionsSplitter.addEventListener('mousedown', (e) => {
        e.preventDefault();
        instructionsSplitter.classList.add('dragging');
        const onMouseMove = (e) => {
            const newWidth = window.innerWidth - e.clientX;
            if (newWidth > 150 && newWidth < 600) {
                instructionsPane.style.width = `${newWidth}px`;
            }
        };
        const onMouseUp = () => {
            instructionsSplitter.classList.remove('dragging');
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

    // Vertical splitter (Editor / Terminal)
    const editorContainer = document.getElementById('editor-container');
    const verticalSplitter = document.getElementById('vertical-splitter');

    verticalSplitter.addEventListener('mousedown', (e) => {
        e.preventDefault();
        verticalSplitter.classList.add('dragging');
        const startY = e.clientY;
        const startEditorHeight = editorContainer.clientHeight;

        const onMouseMove = (e) => {
            const deltaY = e.clientY - startY;
            const newHeight = startEditorHeight + deltaY;
            if (newHeight > 80) {
                editorContainer.style.flex = 'none';
                editorContainer.style.height = `${newHeight}px`;
            }
        };
        const onMouseUp = () => {
            verticalSplitter.classList.remove('dragging');
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

function spawnWorker() {
    worker = new Worker('js/worker.js');

    worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === 'ready') {
            term.writeln('\x1b[32m[Container Ready]\x1b[0m Virtual file system initialized.\r\n');
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
    if (!activeFile) {
        alert("No active file selected to run.");
        return;
    }

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
