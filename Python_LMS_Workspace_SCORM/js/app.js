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
let cmEditor = null;
let currentFontSize = 14;

// Initialize Workspace on Load
document.addEventListener("DOMContentLoaded", async () => {
    initCodeMirrorEditor();
    await loadInstructions();
    await discoverManifestFiles();
    initSplitters();
    initTerminalResize();
    initInstructionsTransitionListener();
});

// Setup CodeMirror 5 Editor (Part 2)
function initCodeMirrorEditor() {
    if (!window.CodeMirror) {
        console.error("CodeMirror failed to load from CDN.");
        document.getElementById('editor-container').innerHTML = '<div style="color: #d12424; padding: 20px; font-family: monospace;">Error: CodeMirror editor failed to load.</div>';
        return;
    }

    // Custom Python Hint registration
    CodeMirror.registerHelper("hint", "pythonHint", function(cm) {
        const cur = cm.getCursor();
        const token = cm.getTokenAt(cur);
        const start = token.start;
        const end = cur.ch;
        const line = cur.line;
        const lineText = cm.getLine(line);
        const search = lineText.substring(start, end);

        const pythonKeywords = [
            "False", "None", "True", "and", "as", "assert", "async", "await", "break",
            "class", "continue", "def", "del", "elif", "else", "except", "finally",
            "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
            "not", "or", "pass", "raise", "return", "try", "while", "with", "yield"
        ];
        const pythonBuiltins = [
            "print", "len", "range", "int", "str", "float", "list", "dict", "set",
            "tuple", "open", "abs", "all", "any", "bin", "bool", "dir", "enumerate",
            "eval", "exec", "filter", "help", "hex", "id", "input", "isinstance",
            "map", "max", "min", "oct", "ord", "pow", "repr", "round", "sorted",
            "sum", "type", "zip"
        ];
        const methods = ["append", "extend", "insert", "remove", "pop", "index", "count", "sort", "reverse", "keys", "values", "items", "get", "update", "split", "join", "strip", "replace", "find", "lower", "upper"];

        let suggestions = [...pythonKeywords, ...pythonBuiltins, ...methods];
        
        // Anyword fallback: collect words from document
        const docText = cm.getValue();
        const words = docText.match(/\b[a-zA-Z_]\w*\b/g) || [];
        suggestions = [...new Set([...suggestions, ...words])];

        const filtered = suggestions.filter(item => item.startsWith(search));

        return {
            list: filtered.length > 0 ? filtered : suggestions,
            from: CodeMirror.Pos(line, start),
            to: CodeMirror.Pos(line, end)
        };
    });

    cmEditor = CodeMirror.fromTextArea(document.getElementById('code-editor-textarea'), {
        mode: "python",
        theme: "material-darker",
        lineNumbers: true,
        lineWrapping: false,
        indentUnit: 4,
        tabSize: 4,
        indentWithTabs: false,
        smartIndent: true,
        electricChars: true,
        matchBrackets: true,
        autoCloseBrackets: true,
        styleActiveLine: true,
        showTrailingSpace: true,
        highlightSelectionMatches: { minChars: 2, showToken: /\w/ },
        foldGutter: true,
        gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter"],
        extraKeys: {
            "Ctrl-Space": "autocomplete",
            "Ctrl-S": function(cm) {
                if (activeFile && virtualFiles[activeFile] !== undefined) {
                    virtualFiles[activeFile] = cm.getValue();
                }
                syncWorkerFiles();
                showSaveIndicator();
            },
            "Cmd-S": function(cm) {
                if (activeFile && virtualFiles[activeFile] !== undefined) {
                    virtualFiles[activeFile] = cm.getValue();
                }
                syncWorkerFiles();
                showSaveIndicator();
            },
            "Ctrl-Enter": function() { toggleExecution(); },
            "Cmd-Enter": function() { toggleExecution(); },
            "Ctrl-Q": function(cm) { cm.foldCode(cm.getCursor()); },
            "Ctrl-Alt-Up": "swapLineUp",
            "Ctrl-Alt-Down": "swapLineDown",
            "Shift-Alt-Down": "duplicateLine",
            "Ctrl-D": "selectNextOccurrence",
            "Ctrl-Shift-K": "deleteLine",
            "Ctrl-F": "findPersistent",
            "Ctrl-H": "replace",
            "Ctrl-G": "findNext",
            "Shift-Ctrl-G": "findPrev",
            "Ctrl-L": "jumpToLine",
            "Ctrl-=": function(cm) { changeFontSize(1); },
            "Cmd-=": function(cm) { changeFontSize(1); },
            "Ctrl--": function(cm) { changeFontSize(-1); },
            "Cmd--": function(cm) { changeFontSize(-1); }
        }
    });

    // Custom Enter auto-indent/dedent logic for Python
    cmEditor.on("keyHandled", (cm, name, event) => {
        if (name === "Enter") {
            const cursor = cm.getCursor();
            const prevLine = cm.getLine(cursor.line - 1);
            if (prevLine) {
                const trimmed = prevLine.trim();
                // Dedent after return, pass, break, continue, raise
                if (/^(return|pass|break|continue|raise)\b/.test(trimmed)) {
                    cm.indentLine(cursor.line, "subtract");
                }
            }
        }
    });

    cmEditor.on("change", (cm) => {
        if (activeFile && virtualFiles[activeFile] !== undefined && virtualFiles[activeFile] !== null) {
            virtualFiles[activeFile] = cm.getValue();
        }
        updateStatusBar(cm);
    });

    cmEditor.on("cursorActivity", (cm) => {
        updateStatusBar(cm);
    });

    // Autocomplete on inputRead for identifiers or dot
    cmEditor.on("inputRead", (cm, change) => {
        if (change.origin === "+input") {
            const text = change.text[0];
            if (/[\w\.]/.test(text)) {
                const cursor = cm.getCursor();
                const token = cm.getTokenAt(cursor);
                if (token.type !== "comment" && token.type !== "string") {
                    if (text === "." || (text.length === 1 && /\w/.test(text))) {
                        CodeMirror.showHint(cm, CodeMirror.hint.pythonHint, { completeSingle: false });
                    }
                }
            }
        }
    });
}

function changeFontSize(delta) {
    currentFontSize = Math.max(10, Math.min(28, currentFontSize + delta));
    const wrapper = document.querySelector('.CodeMirror');
    if (wrapper) {
        wrapper.style.fontSize = `${currentFontSize}px`;
        cmEditor.refresh();
    }
}

function showSaveIndicator() {
    const ind = document.getElementById('save-indicator');
    ind.classList.add('show');
    setTimeout(() => ind.classList.remove('show'), 1500);
}

function updateStatusBar(cm) {
    const cursor = cm.getCursor();
    document.getElementById('status-cursor').innerText = `Ln ${cursor.line + 1}, Col ${cursor.ch + 1}`;
    
    const selRange = cm.somethingSelected() ? `(${cm.getSelection().length} chars selected)` : "";
    document.getElementById('status-selection').innerText = selRange;
}

// Centralized Content Loader
function setEditorContent(filename) {
    if (!cmEditor) return;
    if (filename && virtualFiles[filename] !== undefined && virtualFiles[filename] !== null) {
        activeFile = filename;
        cmEditor.setValue(virtualFiles[filename]);
        cmEditor.clearHistory();
        cmEditor.setCursor(0, 0);
    } else {
        activeFile = null;
        cmEditor.setValue("# Select a file...");
        cmEditor.clearHistory();
    }
    initFileExplorer();
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
    if (activeFile && virtualFiles[activeFile] !== undefined && virtualFiles[activeFile] !== null && cmEditor) {
        virtualFiles[activeFile] = cmEditor.getValue();
    }
    setEditorContent(filename);
}

window.createNewFile = function() {
    if (activeFile && virtualFiles[activeFile] !== undefined && virtualFiles[activeFile] !== null && cmEditor) {
        virtualFiles[activeFile] = cmEditor.getValue();
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
    if (activeFile && virtualFiles[activeFile] !== undefined && virtualFiles[activeFile] !== null && cmEditor) {
        virtualFiles[activeFile] = cmEditor.getValue();
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
            if (cmEditor) cmEditor.refresh();
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
            if (cmEditor) cmEditor.refresh();
        };
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

    // Vertical splitter (resizes Terminal directly)
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
            requestAnimationFrame(() => {
                fitAddon.fit();
                if (cmEditor) cmEditor.refresh();
            });
        };
        const onMouseUp = () => {
            verticalSplitter.classList.remove('dragging');
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            fitAddon.fit();
            if (cmEditor) cmEditor.refresh();
        };
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

function initTerminalResize() {
    const terminalContainer = document.getElementById('terminal-container');
    const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
        if (cmEditor) cmEditor.refresh();
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
    if (activeFile && virtualFiles[activeFile] !== undefined && virtualFiles[activeFile] !== null && cmEditor) {
        virtualFiles[activeFile] = cmEditor.getValue();
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
