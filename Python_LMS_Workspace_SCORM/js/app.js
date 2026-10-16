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
let virtualFiles = {};
let activeFile = null;
let selectedFiles = new Set();
let worker = null;
let isRunning = false;
let markdownSource = "";

// Initialize Workspace on Load
document.addEventListener("DOMContentLoaded", async () => {
    initEditorEvents();
    await loadInstructions();
    await discoverManifestFiles();
    initSplitters();
    initTerminalResize();
    initInstructionsTransitionListener();
});

// Setup Layered Editor Events
function initEditorEvents() {
    const textarea = document.getElementById('code-editor');
    const highlightCode = document.getElementById('highlight-code');
    const lineNumbersEl = document.getElementById('line-numbers');

    const handleInput = () => {
        if (activeFile && virtualFiles[activeFile] !== undefined && virtualFiles[activeFile] !== null) {
            virtualFiles[activeFile] = textarea.value;
        }
        updateEditorDisplay();
    };

    textarea.addEventListener('input', handleInput);

    textarea.addEventListener('scroll', () => {
        highlightCode.parentElement.scrollTop = textarea.scrollTop;
        highlightCode.parentElement.scrollLeft = textarea.scrollLeft;
        lineNumbersEl.scrollTop = textarea.scrollTop;
    });

    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            textarea.value = textarea.value.substring(0, start) + "    " + textarea.value.substring(end);
            textarea.selectionStart = textarea.selectionEnd = start + 4;
            handleInput();
        }
    });
}

// Centralized Content Loader
function setEditorContent(filename) {
    if (filename && virtualFiles[filename] !== undefined && virtualFiles[filename] !== null) {
        activeFile = filename;
        const textarea = document.getElementById('code-editor');
        textarea.value = virtualFiles[filename];
        textarea.scrollTop = 0;
        textarea.scrollLeft = 0;
        updateEditorDisplay();
    } else {
        activeFile = null;
        const textarea = document.getElementById('code-editor');
        textarea.value = "# Select a file...";
        updateEditorDisplay();
    }
    initFileExplorer();
}

function updateEditorDisplay() {
    const textarea = document.getElementById('code-editor');
    const highlightCode = document.getElementById('highlight-code');
    const lineNumbersEl = document.getElementById('line-numbers');
    
    const code = textarea.value;
    highlightCode.innerHTML = pythonHighlight(code);

    const linesCount = code.split('\n').length;
    let linesHtml = "";
    for (let i = 1; i <= linesCount; i++) {
        linesHtml += i + "<br>";
    }
    lineNumbersEl.innerHTML = linesHtml;
}

// Single-Pass Python Tokenizer / Highlighter (Fix 4)
function pythonHighlight(text) {
    const escapeHtml = (str) => str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const pattern = /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b(?:False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b)|(\b(?:print|len|range|int|str|float|list|dict|set|tuple|open|abs|all|any|bin|bool|dir|enumerate|eval|exec|filter|help|hex|id|input|isinstance|map|max|min|oct|ord|pow|repr|round|sorted|sum|type|zip)\b)|(\b\d+\b)/g;
    
    let result = "";
    let lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        if (match.index > lastIndex) {
            result += escapeHtml(text.substring(lastIndex, match.index));
        }
        const fullMatch = match[0];
        if (match[1]) {
            result += `<span class="py-comment">${escapeHtml(fullMatch)}</span>`;
        } else if (match[2]) {
            result += `<span class="py-string">${escapeHtml(fullMatch)}</span>`;
        } else if (match[3]) {
            result += `<span class="py-keyword">${escapeHtml(fullMatch)}</span>`;
        } else if (match[4]) {
            result += `<span class="py-builtin">${escapeHtml(fullMatch)}</span>`;
        } else if (match[5]) {
            result += `<span class="py-number">${escapeHtml(fullMatch)}</span>`;
        }
        lastIndex = pattern.lastIndex;
    }
    if (lastIndex < text.length) {
        result += escapeHtml(text.substring(lastIndex));
    }
    return result + "\n";
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
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 10000);
};

window.toggleInstructionsPane = function() {
    document.body.classList.toggle('instructions-collapsed');
    setTimeout(() => fitAddon.fit(), 210);
};

function initInstructionsTransitionListener() {
    const pane = document.getElementById('instructions-pane');
    pane.addEventListener('transitionend', () => {
        fitAddon.fit();
    });
    // Fallback timeout refit
    setTimeout(() => fitAddon.fit(), 250);
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
        const initialFile = fileNames.length > 0 ? fileNames[0] : null;
        
        setEditorContent(initialFile);
        spawnWorker();

    } catch (err) {
        console.error("Manifest discovery failed:", err);
        virtualFiles["main.py"] = `# Error loading manifest\nprint("Hello World")`;
        setEditorContent("main.py");
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
            virtualFiles[current] = null;
        }
    }
}

// Render Tree Hierarchy
function initFileExplorer() {
    const listEl = document.getElementById('file-list');
    listEl.innerHTML = '';
    
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
    if (activeFile && virtualFiles[activeFile] !== undefined && virtualFiles[activeFile] !== null) {
        virtualFiles[activeFile] = document.getElementById('code-editor').value;
    }
    setEditorContent(filename);
}

window.createNewFile = function() {
    if (activeFile && virtualFiles[activeFile] !== undefined && virtualFiles[activeFile] !== null) {
        virtualFiles[activeFile] = document.getElementById('code-editor').value;
    }
    const parent = getSelectedFolderContext();
    const filename = prompt(`Enter new filename ${parent ? `in ${parent}` : ''}:`);
    if (!filename) return;
    const cleanName = filename.trim();
    const fullPath = parent ? `${parent}/${cleanName}` : cleanName;
    
    if (virtualFiles[fullPath] !== undefined) {
        alert("A file or folder with that name already exists.");
        return;
    }

    virtualFiles[fullPath] = "";
    setEditorContent(fullPath);
    syncWorkerFiles();
};

window.createNewFolder = function() {
    const parent = getSelectedFolderContext();
    const foldername = prompt(`Enter new folder name ${parent ? `in ${parent}` : ''}:`);
    if (!foldername) return;
    const cleanName = foldername.trim();
    const fullPath = parent ? `${parent}/${cleanName}` : cleanName;
    
    if (virtualFiles[fullPath] !== undefined) {
        alert("A file or folder with that name already exists.");
        return;
    }

    virtualFiles[fullPath] = null;
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
        const isDeletingActive = (activeFile === path || (activeFile && activeFile.startsWith(path + '/')));
        const keys = Object.keys(virtualFiles);
        keys.forEach(k => {
            if (k === path || k.startsWith(path + '/')) {
                delete virtualFiles[k];
            }
        });
        selectedFiles.delete(path);
        
        if (isDeletingActive) {
            const remaining = Object.keys(virtualFiles).filter(k => virtualFiles[k] !== null);
            const nextFile = remaining.length > 0 ? remaining[0] : null;
            setEditorContent(nextFile);
        } else {
            initFileExplorer();
        }
        syncWorkerFiles();
    }
}

function updateDownloadButtonState() {
    const btn = document.getElementById('download-btn');
    btn.disabled = selectedFiles.size === 0;
}

window.downloadSelected = async function() {
    if (activeFile && virtualFiles[activeFile] !== undefined && virtualFiles[activeFile] !== null) {
        virtualFiles[activeFile] = document.getElementById('code-editor').value;
    }
    if (selectedFiles.size === 0) return;
    
    if (selectedFiles.size === 1) {
        const path = Array.from(selectedFiles)[0];
        if (virtualFiles[path] !== null) {
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

    const zip = new JSZip();
    selectedFiles.forEach(path => {
        if (virtualFiles[path] !== null) {
            zip.file(path, virtualFiles[path]);
        } else {
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

    // Vertical splitter (resizes Terminal directly - Fix 2)
    const centerPane = document.getElementById('center-pane');
    const terminalContainer = document.getElementById('terminal-container');
    const verticalSplitter = document.getElementById('vertical-splitter');

    verticalSplitter.addEventListener('mousedown', (e) => {
        e.preventDefault();
        verticalSplitter.classList.add('dragging');
        const startY = e.clientY;
        const startTerminalHeight = terminalContainer.clientHeight;

        const onMouseMove = (e) => {
            const deltaY = e.clientY - startY;
            const newHeight = startTerminalHeight - deltaY;
            const maxH = centerPane.clientHeight - 80 - 5;
            const clamped = Math.max(60, Math.min(newHeight, maxH));
            terminalContainer.style.height = `${clamped}px`;
            requestAnimationFrame(() => fitAddon.fit());
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
    const terminalContainer = document.getElementById('terminal-container');
    const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
    });
    resizeObserver.observe(terminalContainer);
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
    if (activeFile && virtualFiles[activeFile] !== undefined && virtualFiles[activeFile] !== null) {
        virtualFiles[activeFile] = document.getElementById('code-editor').value;
    }
    if (worker) {
        worker.postMessage({ cmd: 'sync', files: virtualFiles });
    }
}

window.toggleExecution = function() {
    syncWorkerFiles();
    let targetFile = activeFile;
    if (!targetFile || !targetFile.endsWith('.py')) {
        if (virtualFiles["main.py"] !== undefined) {
            targetFile = "main.py";
        } else {
            term.writeln('\x1b[31mSelect a .py file to run\x1b[0m\r\n');
            return;
        }
    }

    if (isRunning) {
        worker.terminate();
        term.writeln('\r\n\x1b[31m[Process Terminated by User]\x1b[0m\r\n');
        setButtonState(false);
        spawnWorker();
    } else {
        setButtonState(true);
        term.writeln(`\x1b[36m$ python3 ${targetFile}\x1b[0m`);
        worker.postMessage({ cmd: 'run', entrypoint: targetFile });
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
