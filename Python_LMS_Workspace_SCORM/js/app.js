// Initialize xterm.js Terminal UI with FitAddon inside #terminal-host
const term = new Terminal({
    cursorBlink: true,
    theme: { background: '#181818', foreground: '#f0f0f0' },
    fontFamily: 'Consolas, "Courier New", monospace',
    fontSize: 13,
    convertEol: true
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal-host'));
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
let isDirty = false;
let isLoadingContent = false;
let currentErrorHandle = null;
let currentErrorLine = null;
let lastRunTargetFile = null;

// Initialize Workspace on Load
document.addEventListener("DOMContentLoaded", async () => {
    initCodeMirrorEditor();
    await loadInstructions();
    await discoverManifestFiles();
    initSplitters();
    initTerminalResize();
    initInstructionsTransitionListener();
    initBeforeUnload();
});

// Define custom python-vscode wrapper mode
function initPythonVscodeMode() {
    if (!window.CodeMirror) return;
    const controlKeywords = new Set([
        "if", "else", "elif", "for", "while", "return", "import", "from",
        "try", "except", "finally", "with", "pass", "break", "continue", "raise", "yield"
    ]);

    CodeMirror.defineMode("python-vscode", function(config, parserConfig) {
        const pythonMode = CodeMirror.getMode(config, { name: "python", version: 3 });
        return Object.create(pythonMode, {
            token: {
                value: function(stream, state) {
                    const style = pythonMode.token(stream, state);
                    const current = stream.current();
                    if (style) {
                        if (style.includes("keyword") && controlKeywords.has(current)) {
                            return style + " control";
                        }
                        if (style.includes("def") && stream.string.slice(0, stream.start).match(/\bclass\s+$/)) {
                            return style + " class-name";
                        }
                    }
                    return style;
                }
            }
        });
    });
}

// Real dumpTokens helper
window.dumpTokens = function() {
    if (!cmEditor) return "Editor not loaded";
    const allTokens = [];
    cmEditor.eachLine((line) => {
        const lineNum = cmEditor.getLineNumber(line);
        const tokens = cmEditor.getLineTokens(lineNum);
        tokens.forEach(t => {
            allTokens.push({ line: lineNum + 1, string: t.string, type: t.type });
        });
    });
    console.table(allTokens);
    return allTokens;
};

// Setup CodeMirror 5 Editor
function initCodeMirrorEditor() {
    if (!window.CodeMirror) {
        console.error("CodeMirror failed to load from CDN.");
        document.getElementById('editor-container').innerHTML = '<div style="color: #d12424; padding: 20px; font-family: monospace;">Error: CodeMirror editor failed to load.</div>';
        return;
    }

    initPythonVscodeMode();

    cmEditor = CodeMirror.fromTextArea(document.getElementById('code-editor-textarea'), {
        mode: "python-vscode",
        theme: "vscode-dark",
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
        gutters: ["cm-error-gutter", "CodeMirror-linenumbers", "CodeMirror-foldgutter"],
        readOnly: "nocursor",
        extraKeys: {
            "Backspace": "delSpaceToPrevTabStop",
            "Home": "goLineStartSmart",
            "Tab": function(cm) {
                if (cm.somethingSelected()) {
                    cm.indentMore();
                } else {
                    cm.execCommand("insertSoftTab");
                }
            },
            "Shift-Tab": "indentLess",
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
            "Ctrl-Enter": function() { if (!isRunning) toggleExecution(); },
            "Cmd-Enter": function() { if (!isRunning) toggleExecution(); },
            "Ctrl-Q": function(cm) { cm.foldCode(cm.getCursor()); },
            "Alt-Up": "swapLineUp",
            "Alt-Down": "swapLineDown",
            "Shift-Alt-Down": "duplicateLine",
            "Ctrl-D": "selectNextOccurrence",
            "Cmd-D": "selectNextOccurrence",
            "Ctrl-Shift-K": "deleteLine",
            "Ctrl-/": "toggleComment",
            "Cmd-/": "toggleComment",
            "Ctrl-F": "findPersistent",
            "Cmd-F": "findPersistent",
            "Cmd-Alt-F": "replace",
            "Ctrl-H": "replace",
            "Ctrl-G": "findNext",
            "Cmd-G": "findNext",
            "Shift-Ctrl-G": "findPrev",
            "Shift-Cmd-G": "findPrev",
            "Ctrl-L": "jumpToLine",
            "Ctrl-=": function(cm) { changeFontSize(1); },
            "Cmd-=": function(cm) { changeFontSize(1); },
            "Ctrl--": function(cm) { changeFontSize(-1); },
            "Cmd--": function(cm) { changeFontSize(-1); }
        }
    });

    // Custom Enter auto-indent/dedent logic with bracket/comma validation
    cmEditor.on("keyHandled", (cm, name, event) => {
        if (name === "Enter") {
            const cursor = cm.getCursor();
            const prevLineNum = cursor.line - 1;
            if (prevLineNum >= 0) {
                const lineText = cm.getLine(prevLineNum);
                const trimmed = lineText.trim();
                if (/^(return|pass|break|continue|raise)\b/.test(trimmed)) {
                    if (!trimmed.endsWith('\\') && !trimmed.endsWith(',')) {
                        let parens = 0, brackets = 0, braces = 0;
                        for (let char of lineText) {
                            if (char === '(') parens++;
                            else if (char === ')') parens--;
                            else if (char === '[') brackets++;
                            else if (char === ']') brackets--;
                            else if (char === '{') braces++;
                            else if (char === '}') braces--;
                        }
                        if (parens === 0 && brackets === 0 && braces === 0) {
                            cm.indentLine(cursor.line, "subtract");
                        }
                    }
                }
            }
        }
    });

    cmEditor.on("change", (cm, changeObj) => {
        clearErrorHighlight();
        if (isLoadingContent) return;
        if (activeFile && virtualFiles[activeFile] !== undefined && virtualFiles[activeFile] !== null) {
            virtualFiles[activeFile] = cm.getValue();
            isDirty = true;
        }
        updateStatusBar(cm);
    });

    cmEditor.on("cursorActivity", (cm) => {
        updateStatusBar(cm);
    });
}

function clearErrorHighlight() {
    if (currentErrorHandle !== null && cmEditor) {
        cmEditor.removeLineClass(currentErrorHandle, "background", "cm-traceback-error");
        cmEditor.setGutterMarker(currentErrorHandle, "cm-error-gutter", null);
        currentErrorHandle = null;
        currentErrorLine = null;
    }
}

function changeFontSize(delta) {
    let size = parseInt(cmEditor.getWrapperElement().style.fontSize) || 14;
    size = Math.max(10, Math.min(28, size + delta));
    cmEditor.getWrapperElement().style.fontSize = `${size}px`;
    cmEditor.refresh();
}

function showSaveIndicator() {
    const ind = document.getElementById('save-indicator');
    ind.classList.add('show');
    setTimeout(() => ind.classList.remove('show'), 1500);
}

function updateStatusBar(cm) {
    const cursor = cm.getCursor();
    document.getElementById('status-cursor').innerText = `Ln ${cursor.line + 1}, Col ${cursor.ch + 1}`;
    document.getElementById('status-filename').innerText = activeFile || "No file selected";
    
    const selRange = cm.somethingSelected() ? `(${cm.getSelection().length} chars selected)` : "";
    document.getElementById('status-selection').innerText = selRange;
}

function setEditorContent(filename) {
    if (!cmEditor) return;
    isLoadingContent = true;
    clearErrorHighlight();
    if (filename && virtualFiles[filename] !== undefined && virtualFiles[filename] !== null) {
        activeFile = filename;
        cmEditor.setOption("readOnly", false);
        cmEditor.setValue(virtualFiles[filename]);
        cmEditor.clearHistory();
        cmEditor.setCursor(0, 0);
    } else {
        activeFile = null;
        cmEditor.setOption("readOnly", "nocursor");
        cmEditor.setValue("# Select a file...");
        cmEditor.clearHistory();
    }
    isLoadingContent = false;
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
    const pane = document.getElementById('instructions-pane');
    pane.classList.add('animating');
    document.body.classList.toggle('instructions-collapsed');
    setTimeout(() => {
        pane.classList.remove('animating');
        fitAddon.fit();
        if (cmEditor) cmEditor.refresh();
    }, 220);
};

function initInstructionsTransitionListener() {
    const pane = document.getElementById('instructions-pane');
    pane.addEventListener('transitionend', () => {
        pane.classList.remove('animating');
        fitAddon.fit();
        if (cmEditor) cmEditor.refresh();
    });
    setTimeout(() => {
        fitAddon.fit();
        if (cmEditor) cmEditor.refresh();
    }, 250);
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
        isDirty = false;
        spawnWorker();

    } catch (err) {
        console.error("Manifest discovery failed:", err);
        virtualFiles["main.py"] = `# Error loading manifest\nprint("Hello World")`;
        setEditorContent("main.py");
        isDirty = false;
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
    isDirty = true;
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
    isDirty = true;
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
        isDirty = true;
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
        const content = virtualFiles[path];
        if (content === null) {
            zip.folder(path);
            Object.keys(virtualFiles).forEach(k => {
                if (k.startsWith(path + '/')) {
                    if (virtualFiles[k] === null) zip.folder(k);
                    else zip.file(k, virtualFiles[k]);
                }
            });
        } else {
            zip.file(path, content);
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
    setTimeout(() => {
        fitAddon.fit();
        if (cmEditor) cmEditor.refresh();
    }, 210);
};

// Shared Splitter Helper using Pointer Events with requestAnimationFrame throttling
function makeSplitter({ el, axis, direction, getStart, apply, getMin, getMax }) {
    el.style.touchAction = "none";
    el.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        
        const isX = axis === "x";
        document.body.classList.add(isX ? "is-resizing-x" : "is-resizing-y");
        
        const startPos = isX ? e.clientX : e.clientY;
        const startVal = getStart();
        let latestClamped = startVal;
        let rafId = null;

        const onPointerMove = (ev) => {
            const currentPos = isX ? ev.clientX : ev.clientY;
            const delta = (currentPos - startPos) * direction;
            const newVal = startVal + delta;
            const minVal = typeof getMin === "function" ? getMin() : getMin;
            const maxVal = typeof getMax === "function" ? getMax() : getMax;
            latestClamped = Math.max(minVal, Math.min(newVal, maxVal));

            if (!rafId) {
                rafId = requestAnimationFrame(() => {
                    apply(latestClamped);
                    fitAddon.fit();
                    if (cmEditor) cmEditor.refresh();
                    rafId = null;
                });
            }
        };

        const cleanup = (ev) => {
            if (rafId) cancelAnimationFrame(rafId);
            apply(latestClamped);
            try { el.releasePointerCapture(e.pointerId); } catch(err) {}
            document.body.classList.remove("is-resizing-x", "is-resizing-y");
            el.removeEventListener("pointermove", onPointerMove);
            el.removeEventListener("pointerup", cleanup);
            el.removeEventListener("pointercancel", cleanup);
            el.removeEventListener("lostpointercapture", cleanup);
            fitAddon.fit();
            if (cmEditor) cmEditor.refresh();
        };

        el.addEventListener("pointermove", onPointerMove);
        el.addEventListener("pointerup", cleanup);
        el.addEventListener("pointercancel", cleanup);
        el.addEventListener("lostpointercapture", cleanup);
    });
}

function initSplitters() {
    const sidebar = document.getElementById('file-sidebar');
    const instructionsPane = document.getElementById('instructions-pane');
    const terminalContainer = document.getElementById('terminal-container');
    const centerPane = document.getElementById('center-pane');

    makeSplitter({
        el: document.getElementById('sidebar-splitter'),
        axis: "x",
        direction: 1,
        getStart: () => sidebar.clientWidth,
        apply: (w) => { sidebar.style.width = `${w}px`; },
        getMin: () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-min')) || 120,
        getMax: () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-max')) || 400
    });

    makeSplitter({
        el: document.getElementById('instructions-splitter'),
        axis: "x",
        direction: -1,
        getStart: () => instructionsPane.clientWidth,
        apply: (w) => { instructionsPane.style.width = `${w}px`; },
        getMin: () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--instructions-min')) || 200,
        getMax: () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--instructions-max')) || 600
    });

    makeSplitter({
        el: document.getElementById('vertical-splitter'),
        axis: "y",
        direction: -1,
        getStart: () => terminalContainer.clientHeight,
        apply: (h) => { terminalContainer.style.height = `${h}px`; },
        getMin: () => 60,
        getMax: () => centerPane.clientHeight - 80 - 5
    });
}

function initTerminalResize() {
    const terminalHost = document.getElementById('terminal-host');
    const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
        if (cmEditor) cmEditor.refresh();
    });
    resizeObserver.observe(terminalHost);
}

// Exit Modal, Focus Trap, & Reset
window.showExitModal = function() {
    document.getElementById('modal-title').innerText = "Exit Lab";
    document.getElementById('modal-text').innerText = "Your work will be lost when you exit. Download your files before leaving.";
    document.getElementById('modal-download-btn').innerText = "Download my work (.zip)";
    document.getElementById('exit-modal-backdrop').classList.add('show');
    document.getElementById('modal-cancel-btn').focus();
};

window.hideExitModal = function() {
    document.getElementById('exit-modal-backdrop').classList.remove('show');
    document.getElementById('exit-btn').focus();
};

window.modalDownloadWork = async function() {
    if (activeFile && virtualFiles[activeFile] !== undefined && virtualFiles[activeFile] !== null && cmEditor) {
        virtualFiles[activeFile] = cmEditor.getValue();
    }
    const zip = new JSZip();
    Object.keys(virtualFiles).forEach(path => {
        const content = virtualFiles[path];
        if (content === null) {
            zip.folder(path);
        } else {
            zip.file(path, content);
        }
    });

    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = "workspace-export.zip";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    isDirty = false;
    document.getElementById('modal-download-btn').innerText = "Downloaded ✓";
    document.getElementById('modal-text').innerText = "Downloaded ✓ Your work has been exported successfully.";
    setTimeout(() => {
        document.getElementById('modal-download-btn').innerText = "Download my work (.zip)";
    }, 2000);
};

window.modalExitAnyway = function() {
    const prevDirty = isDirty;
    isDirty = false;
    hideExitModal();
    window.close();
    setTimeout(() => {
        if (!window.closed) {
            isDirty = prevDirty;
            document.getElementById('modal-text').innerText = "You can now close this tab or return to your course.";
            document.getElementById('exit-modal-backdrop').classList.add('show');
            document.getElementById('modal-cancel-btn').focus();
        }
    }, 300);
};

function initBeforeUnload() {
    window.addEventListener('beforeunload', (e) => {
        if (isDirty) {
            e.preventDefault();
            e.returnValue = "";
        }
    });

    // Real focus trap for modal
    const modal = document.getElementById('exit-modal');
    modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            hideExitModal();
            return;
        }
        if (e.key === 'Tab') {
            const focusables = modal.querySelectorAll('button:not([hidden]), [tabindex="0"]:not([hidden])');
            if (focusables.length === 0) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                last.focus();
                e.preventDefault();
            } else if (!e.shiftKey && document.activeElement === last) {
                first.focus();
                e.preventDefault();
            }
        }
    });
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
            parseTracebackError(msg.data);
        } else if (msg.type === 'done') {
            setButtonState(false);
        }
    };
}

// Robust Traceback Error Parser & Highlighter
function parseTracebackError(stderrData) {
    if (!activeFile || !cmEditor) return;
    const lines = stderrData.split('\n');
    let targetLineNum = null;

    for (let line of lines) {
        const match = line.match(/File\s+"([^"]+)",\s+line\s+(\d+)/);
        if (match) {
            const filePath = match[1];
            const lineNum = parseInt(match[2], 10) - 1;
            if ((filePath === "<exec>" || filePath === lastRunTargetFile) && lastRunTargetFile === activeFile) {
                targetLineNum = lineNum;
            }
        }
    }

    if (targetLineNum !== null && targetLineNum >= 0 && targetLineNum < cmEditor.lineCount()) {
        clearErrorHighlight();
        currentErrorLine = targetLineNum;
        currentErrorHandle = cmEditor.lineInfo(targetLineNum).handle;
        cmEditor.addLineClass(currentErrorHandle, "background", "cm-traceback-error");
        
        const marker = document.createElement("span");
        marker.className = "cm-error-marker";
        marker.innerHTML = "●";
        cmEditor.setGutterMarker(targetLineNum, "cm-error-gutter", marker);
    }
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
    if (isRunning) {
        worker.terminate();
        term.writeln('\r\n\x1b[31m[Process Terminated by User]\x1b[0m\r\n');
        setButtonState(false);
        spawnWorker();
        return;
    }

    clearErrorHighlight();
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

    lastRunTargetFile = targetFile;
    setButtonState(true);
    term.writeln(`\x1b[36m$ python3 ${targetFile}\x1b[0m`);
    worker.postMessage({ cmd: 'run', entrypoint: targetFile });
};

function setButtonState(running) {
    isRunning = running;
    const btn = document.getElementById('action-btn');
    btn.className = running ? 'stop-btn' : 'run-btn';
    btn.innerText = running ? '⏹ Stop Process' : '▶ Run Code';
}

window.returnToCourse = function() {
    showExitModal();
};
