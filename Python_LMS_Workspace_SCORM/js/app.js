import { EditorState } from "https://esm.sh/@codemirror/state@6.4.1";
import { EditorView, keymap, lineNumbers } from "https://esm.sh/@codemirror/view@6.26.2";
import { defaultKeymap } from "https://esm.sh/@codemirror/commands@6.3.3";
import { python } from "https://esm.sh/@codemirror/lang-python@6.1.3";
import { oneDark } from "https://esm.sh/@codemirror/theme-one-dark@6.1.2";

// Initialize xterm.js Terminal UI with FitAddon
const term = new Terminal({
    cursorBlink: true,
    theme: { background: '#181818', foreground: '#f0f0f0' },
    fontFamily: 'Consolas, "Courier New", monospace',
    fontSize: 13,
    convertEol: true
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal-container'));
fitAddon.fit();

term.writeln('\x1b[33mSystem: Loading background worker runtime...\x1b[0m\r\n');

// State Management
let virtualFiles = {}; // path -> content or null (for folders)
let activeFile = null;
let selectedFiles = new Set();
let worker = null;
let isRunning = false;
let editorView = null;
let markdownSource = "";

// Initialize Workspace on Load
document.addEventListener("DOMContentLoaded", async () => {
    initEditor();
    await loadInstructions();
    await discoverManifestFiles();
    initSplitters();
    initTerminalResize();
});

// Setup CodeMirror 6 Editor
function initEditor() {
    const updateListener = EditorView.updateListener.of((update) => {
        if (update.docChanged && activeFile && virtualFiles[activeFile] !== undefined) {
            virtualFiles[activeFile] = update.state.doc.toString();
        }
    });

    const startState = EditorState.create({
        doc: "# Select a file from the sidebar...\n",
        extensions: [
            lineNumbers(),
            python(),
            oneDark,
            keymap.of(defaultKeymap),
            updateListener
        ]
    });

    editorView = new EditorView({
        state: startState,
        parent: document.getElementById('code-editor')
    });
}

// Load Instructions from instructions.md
async function loadInstructions() {
    try {
        const response = await fetch('instructions.md');
        if (!response.ok) throw new Error("Could not load instructions.md");
        markdownSource = await response.text();
        document.getElementById("instructions-content").innerHTML = marked.parse(markdownSource);
    } catch (err) {
        markdownSource = "# Instructions\nError loading instructions.";
        document.getElementById("instructions-content").innerHTML = `<p style="color: #d12424;">Error loading instructions: ${err.message}</p>`;
    }
}

// Open instructions in a new tab with proper styling
window.openInstructionsNewTab = function() {
    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Assignment Instructions</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.2.0/github-markdown-dark.min.css">
    <style>
        body { background: #1e1e1e; color: #f0f0f0; padding: 40px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        .markdown-body { max-width: 800px; margin: 0 auto; }
    </style>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
</head>
<body class="markdown-body">
    <div id="content"></div>
    <script>document.getElementById('content').innerHTML = marked.parse(${JSON.stringify(markdownSource)});</script>
</body>
</html>`;
    const blob = new Blob([htmlContent], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 10000);
};

window.toggleInstructionsPane = function() {
    const pane = document.getElementById('instructions-pane');
    const btn = document.getElementById('toggle-instructions-btn');
    pane.classList.toggle('collapsed');
    const isCollapsed = pane.classList.contains('collapsed');
    btn.innerText = isCollapsed ? '▶' : '◀';
    btn.setAttribute('aria-label', isCollapsed ? 'Expand instructions' : 'Collapse instructions');
    setTimeout(() => fitAddon.fit(), 210);
};

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
            if (href && !['imsmanifest.xml', 'index.html', 'instructions.md', 'css/styles.css', 'js/app.js', 'js/worker.js'].includes(href)) {
                discovered.push(href);
            }
        }

        if (discovered.length === 0) {
            virtualFiles["main.py"] = `# Write your Python code here\nprint("Hello, World!")\n`;
        } else {
            for (let path of discovered) {
                try {
                    const fileRes = await fetch(path);
                    if (fileRes.ok) {
                        const content = await fileRes.text();
                        virtualFiles[path] = content;
                        ensureParentFolders(path);
                    }
                } catch (e) {
                    console.warn(`Could not fetch starter file: ${path}`, e);
                }
            }
        }

        const fileNames = Object.keys(virtualFiles).filter(k => virtualFiles[k] !== null);
        activeFile = fileNames.length > 0 ? fileNames[0] : null;
        
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

function ensureParentFolders(path) {
    const parts = path.split('/');
    parts.pop();
    let current = "";
    for (let p of parts) {
        current = current ? `${current}/${p}` : p;
        if (virtualFiles[current] === undefined) {
            virtualFiles[current] = null; // null indicates folder
        }
    }
}

// Render Tree Hierarchy
function initFileExplorer() {
    const listEl = document.getElementById('file-list');
    listEl.innerHTML = '';
    
    // Build tree structure
    const tree = {};
    Object.keys(virtualFiles).sort().forEach(path => {
        const parts = path.split('/');
        let curr = tree;
        parts.forEach((part, idx) => {
            if (!curr[part]) {
                curr[part] = (idx === parts.length - 1 && virtualFiles[path] !== null) ? { __file: path } : {};
            }
            curr = curr[part];
        });
    });

    renderTreeNode(tree, listEl, "");
    updateDownloadButtonState();

    if (activeFile && virtualFiles[activeFile] !== undefined && virtualFiles[activeFile] !== null) {
        const doc = editorView.state.doc.toString();
        if (doc !== virtualFiles[activeFile]) {
            editorView.dispatch({
                changes: { from: 0, to: doc.length, insert: virtualFiles[activeFile] }
            });
        }
    } else {
        editorView.dispatch({
            changes: { from: 0, to: editorView.state.doc.length, insert: "# Select a file..." }
        });
    }
}

function renderTreeNode(node, parentElement, currentPath) {
    Object.keys(node).sort().forEach(name => {
        const fullPath = currentPath ? `${currentPath}/${name}` : name;
        const isFolder = node[name].__file === undefined;
        
        const li = document.createElement('li');
        li.className = 'file-item';
        if (!isFolder && fullPath === activeFile) {
            li.classList.add('active');
        }
        if (selectedFiles.has(fullPath)) {
            li.classList.add('selected');
        }

        const rowContent = document.createElement('div');
        rowContent.className = 'file-row-content';
        rowContent.innerText = (isFolder ? '📁 ' : '📄 ') + name;

        // Click row handler (Requirement D1: entire row clickable)
        li.onclick = (e) => {
            e.stopPropagation();
            const isMeta = e.metaKey || e.ctrlKey;
            if (isMeta) {
                if (selectedFiles.has(fullPath)) {
                    selectedFiles.delete(fullPath);
                } else {
                    selectedFiles.add(fullPath);
                }
                initFileExplorer();
            } else {
                selectedFiles.clear();
                selectedFiles.add(fullPath);
                if (!isFolder) {
                    switchFile(fullPath);
                } else {
                    initFileExplorer();
                }
            }
        };

        li.appendChild(rowContent);

        const actions = document.createElement('div');
        actions.className = 'file-actions';

        const delBtn = document.createElement('button');
        delBtn.className = 'file-delete';
        delBtn.innerText = '✕';
        delBtn.onclick = (e) => {
            e.stopPropagation();
            deleteItem(fullPath, isFolder);
        };
        actions.appendChild(delBtn);
        li.appendChild(actions);

        parentElement.appendChild(li);

        if (isFolder) {
            const ul = document.createElement('ul');
            ul.className = 'folder-children';
            renderTreeNode(node[name], ul, fullPath);
            parentElement.appendChild(ul);
        }
    });
}

function switchFile(filename) {
    if (virtualFiles[filename] !== null) {
        activeFile = filename;
        initFileExplorer();
    }
}

window.updateActiveFileContent = function() {
    if (activeFile && virtualFiles[activeFile] !== undefined) {
        virtualFiles[activeFile] = editorView.state.doc.toString();
    }
};

window.createNewFile = function() {
    const parent = getSelectedFolderContext();
    const filename = prompt(`Enter new filename ${parent ? `in ${parent}` : ''}:`);
    if (!filename) return;
    const cleanName = filename.trim();
    const fullPath = parent ? `${parent}/${cleanName}` : cleanName;
    
    if (virtualFiles[fullPath] !== undefined) {
        alert("A file or folder with that name already exists.");
        return;
    }

    virtualFiles[fullPath] = `# New file: ${cleanName}\n`;
    switchFile(fullPath);
    syncWorkerFiles();
};

window.createNewFolder = function() {
    const foldername = prompt("Enter new folder name:");
    if (!foldername) return;
    const cleanName = foldername.trim();
    
    if (virtualFiles[cleanName] !== undefined) {
        alert("A file or folder with that name already exists.");
        return;
    }

    virtualFiles[cleanName] = null; // folder marker
    initFileExplorer();
    syncWorkerFiles();
};

function getSelectedFolderContext() {
    if (selectedFiles.size === 1) {
        const path = Array.from(selectedFiles)[0];
        if (virtualFiles[path] === null) return path;
        const parts = path.split('/');
        parts.pop();
        return parts.join('/');
    }
    return "";
}

function deleteItem(path, isFolder) {
    if (confirm(`Are you sure you want to delete ${path}?`)) {
        const keys = Object.keys(virtualFiles);
        keys.forEach(k => {
            if (k === path || k.startsWith(path + '/')) {
                delete virtualFiles[k];
            }
        });
        selectedFiles.delete(path);
        if (activeFile === path || (activeFile && activeFile.startsWith(path + '/'))) {
            const remaining = Object.keys(virtualFiles).filter(k => virtualFiles[k] !== null);
            activeFile = remaining.length > 0 ? remaining[0] : null;
        }
        initFileExplorer();
        syncWorkerFiles();
    }
}

function updateDownloadButtonState() {
    const btn = document.getElementById('download-btn');
    btn.disabled = selectedFiles.size === 0;
}

window.downloadSelected = async function() {
    if (selectedFiles.size === 0) return;
    
    if (selectedFiles.size === 1) {
        const path = Array.from(selectedFiles)[0];
        if (virtualFiles[path] !== null) {
            // Single file download
            const blob = new Blob([virtualFiles[path]], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = path.split('/').pop();
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
            return;
        }
    }

    // Multiple files or folder -> Zip via JSZip
    const zip = new JSZip();
    selectedFiles.forEach(path => {
        if (virtualFiles[path] !== null) {
            zip.file(path, virtualFiles[path]);
        } else {
            // Folder export
            Object.keys(virtualFiles).forEach(k => {
                if ((k === path || k.startsWith(path + '/')) && virtualFiles[k] !== null) {
                    zip.file(k, virtualFiles[k]);
                }
            });
        }
    });

    const content = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = "workspace-export.zip";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
};

window.toggleSidebar = function() {
    const sidebar = document.getElementById('file-sidebar');
    sidebar.classList.toggle('collapsed');
    setTimeout(() => fitAddon.fit(), 210);
};

// Resizable Splitter Logic & Terminal ResizeObserver
function initSplitters() {
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
            fitAddon.fit();
        };
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

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
            fitAddon.fit();
        };
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

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
            fitAddon.fit();
        };
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

function initTerminalResize() {
    const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
    });
    resizeObserver.observe(document.getElementById('terminal-container'));
}

function spawnWorker() {
    worker = new Worker('js/worker.js');

    worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === 'ready') {
            term.writeln('\x1b[32m[Container Ready]\x1b[0m Virtual file system initialized.\r\n');
            syncWorkerFiles();
        } else if (msg.type === 'stdout') {
            term.writeln(msg.data);
        } else if (msg.type === 'stderr') {
            term.writeln(`\x1b[31m${msg.data}\x1b[0m`);
        } else if (msg.type === 'done') {
            setButtonState(false);
        }
    };
}

function syncWorkerFiles() {
    if (worker) {
        worker.postMessage({ cmd: 'sync', files: virtualFiles });
    }
}

window.toggleExecution = function() {
    window.updateActiveFileContent();
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
        syncWorkerFiles();
        worker.postMessage({ cmd: 'run', entrypoint: activeFile });
    }
};

function setButtonState(running) {
    isRunning = running;
    const btn = document.getElementById('action-btn');
    btn.className = running ? 'stop-btn' : 'run-btn';
    btn.innerText = running ? '⏹ Stop Process' : '▶ Run Code';
}

window.returnToCourse = function() {
    if (confirm("Are you sure you want to exit this lab?")) {
        window.close();
    }
};
