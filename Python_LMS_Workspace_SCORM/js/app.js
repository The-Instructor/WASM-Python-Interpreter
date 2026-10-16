// ===========================================================================
// Python Lab Workspace — main application (core system file).
//
// Loading order for the assignment definition:
//   1. assignment.dat              -> exported student package (locked)
//   2. assignment/assignment.json  -> instructor template (Instructor Mode)
//   3. imsmanifest.xml <file> tags -> legacy packages (back-compat)
//
// File roles:  starter  = visible + editable by students
//              readonly = visible, locked, restored before grading
//              hidden   = never shown; only present while tests run
// ===========================================================================

const CORE_FILES = [
    'index.html', 'css/styles.css', 'js/app.js', 'js/worker.js',
    'js/harness.py', 'js/scorm.js'
];
const LEGACY_SYSTEM_FILES = ['imsmanifest.xml', 'index.html', 'instructions.md', 'css/styles.css', 'js/app.js', 'js/worker.js'];
const BINARY_EXT = /\.(png|jpe?g|gif|bmp|webp|ico|pdf|zip|xlsx?|docx?|pptx?|sqlite|db|bin|dat|pkl|npy|mp3|wav)$/i;
const PKG_HEADER = 'PYWS1';
const PKG_KEY = 'python-lab-workspace';

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------
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
term.writeln('\x1b[33mSystem: Loading Python runtime...\x1b[0m');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let project = null;          // normalized assignment definition
let projectSource = 'none';  // 'package' | 'template' | 'legacy'
let mode = 'student';        // 'student' | 'instructor' | 'preview'
let solutionView = false;    // instructor: editing solution versions
let virtualFiles = {};       // working tree shown in the editor: path -> text | null (folder)
let binaryFiles = new Set(); // paths in virtualFiles whose content is base64
let activeFile = null;
let selectedFiles = new Set();
let worker = null;
let workerReady = false;
let isRunning = false;
let isTesting = false;
let cmEditor = null;
let isDirty = false;
let isLoadingContent = false;
let currentErrorHandle = null;
let lastRunTargetFile = null;
let runSession = null;
let lastResults = null;
let saveTimer = null;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", async () => {
    initCodeMirrorEditor();
    initSplitters();
    initTerminalResize();
    initTerminalInput();
    initInstructionsTransitionListener();
    initBeforeUnload();
    initBottomTabs();

    if (location.protocol === 'file:') {
        showBanner('This workspace must be opened through a web server (or D2L). Use the "Start Instructor Workspace" script in this folder, then try again.', 'error');
    }

    await loadAssignment();

    if (projectSource === 'template') {
        try {
            await loadScript('js/instructor.js');
            if (window.Instructor) {
                await window.Instructor.init(App);
                return; // Instructor.init calls setMode()
            }
        } catch (e) {
            console.warn('Instructor tools unavailable', e);
        }
    }
    if (projectSource === 'package' && window.SCORM) {
        SCORM.init();
    }
    setMode('student');
});

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Could not load ' + src));
        document.head.appendChild(s);
    });
}

async function fetchText(path) {
    try {
        const r = await fetch(path, { cache: 'no-cache' });
        if (!r.ok) return null;
        return await r.text();
    } catch (e) { return null; }
}

async function fetchBase64(path) {
    try {
        const r = await fetch(path, { cache: 'no-cache' });
        if (!r.ok) return null;
        return bytesToB64(new Uint8Array(await r.arrayBuffer()));
    } catch (e) { return null; }
}

function bytesToB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
}
function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

// ---------------------------------------------------------------------------
// Assignment loading / normalization
// ---------------------------------------------------------------------------
function uid() {
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

function normalizeProject(raw) {
    const p = Object.assign({
        version: 1,
        id: uid(),
        title: 'Python Assignment',
        entry: 'main.py',
        passingScore: 0,
        gradePolicy: 'best',
        allowNewFiles: true,
        instructions: '# Instructions\n',
        files: {},
        tests: []
    }, raw || {});
    // files may arrive as an array [{path, role, ...}] or a map
    if (Array.isArray(p.files)) {
        const m = {};
        for (const f of p.files) m[f.path] = f;
        p.files = m;
    }
    for (const [path, f] of Object.entries(p.files)) {
        p.files[path] = {
            role: ['starter', 'readonly', 'hidden'].includes(f.role) ? f.role : 'starter',
            content: f.content ?? '',
            binary: !!f.binary,
            solution: f.solution ?? null
        };
    }
    p.tests = (p.tests || []).map((t, i) => Object.assign({
        id: t.id || uid(),
        name: t.name || `Test ${i + 1}`,
        type: 'output',
        points: 1,
        hidden: false,
        file: '',
        stdin: '',
        expected: '',
        match: 'normalized',
        call: '',
        tolerance: null,
        code: '',
        timeout: 5
    }, t));
    p.passingScore = Number(p.passingScore) || 0;
    return p;
}

async function loadAssignment() {
    // 1. Exported student package (export marks <body data-package="1">)
    const dat = document.body.dataset.package ? await fetchText('assignment.dat') : null;
    if (dat && dat.startsWith(PKG_HEADER)) {
        try {
            project = normalizeProject(decodePackage(dat));
            projectSource = 'package';
            return;
        } catch (e) {
            console.error('Package decode failed', e);
            showBanner('This assignment package is damaged. Please contact your instructor.', 'error');
        }
    }
    // 2. Instructor template folder
    const json = await fetchText('assignment/assignment.json');
    if (json) {
        try {
            project = await loadProjectFromFolder(JSON.parse(json));
            projectSource = 'template';
            return;
        } catch (e) {
            console.error('assignment.json invalid', e);
            showBanner('assignment/assignment.json could not be read: ' + e.message, 'error');
        }
    }
    // 3. Legacy manifest-driven package
    project = await loadLegacyProject();
    projectSource = 'legacy';
}

async function loadProjectFromFolder(def) {
    const p = normalizeProject(Object.assign({}, def, { files: {} }));
    p.instructions = (await fetchText('assignment/instructions.md')) ?? p.instructions;
    for (const f of (def.files || [])) {
        const binary = f.binary || BINARY_EXT.test(f.path);
        const content = binary ? await fetchBase64('assignment/files/' + f.path)
                               : await fetchText('assignment/files/' + f.path);
        let solution = null;
        if (f.solution) {
            solution = binary ? await fetchBase64('assignment/solution/' + f.path)
                              : await fetchText('assignment/solution/' + f.path);
        }
        p.files[f.path] = { role: f.role || 'starter', content: content ?? '', binary, solution };
    }
    return p;
}

async function loadLegacyProject() {
    const p = normalizeProject({ id: 'legacy', tests: [] });
    p.instructions = (await fetchText('instructions.md')) ?? '# Instructions\n';
    const manifest = await fetchText('imsmanifest.xml');
    const found = [];
    if (manifest) {
        const xml = new DOMParser().parseFromString(manifest, 'application/xml');
        for (const tag of xml.getElementsByTagName('file')) {
            const href = tag.getAttribute('href');
            if (href && !LEGACY_SYSTEM_FILES.includes(href) && !CORE_FILES.includes(href)) found.push(href);
        }
        const title = xml.querySelector('organization > title');
        if (title) p.title = title.textContent.trim();
    }
    for (const path of found) {
        const binary = BINARY_EXT.test(path);
        const content = binary ? await fetchBase64(path) : await fetchText(path);
        if (content != null) p.files[path] = { role: 'starter', content, binary, solution: null };
    }
    if (Object.keys(p.files).length === 0) {
        p.files['main.py'] = { role: 'starter', content: '# Write your Python code here\nprint("Hello, World!")\n', binary: false, solution: null };
    }
    return p;
}

// --- Package encoding (light obfuscation so tests aren't plain text) -------
function xorBytes(bytes, keyStr) {
    const key = new TextEncoder().encode(keyStr);
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ key[i % key.length] ^ ((i * 31) & 0xff);
    return out;
}
function encodePackage(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    return PKG_HEADER + '\n' + bytesToB64(xorBytes(bytes, PKG_KEY));
}
function decodePackage(text) {
    const b64 = text.slice(PKG_HEADER.length).trim();
    const bytes = xorBytes(b64ToBytes(b64), PKG_KEY);
    return JSON.parse(new TextDecoder().decode(bytes));
}

// ---------------------------------------------------------------------------
// Modes & workspace construction
// ---------------------------------------------------------------------------
function setMode(newMode) {
    if (isRunning) stopRun();
    mode = newMode;
    document.body.dataset.mode = mode;
    document.getElementById('brand-title').innerText = project.title || 'Python Lab Workspace';
    document.title = project.title || 'Python Assignment Workspace';
    rebuildWorkspace();
    renderInstructions();
    updateConnectionBadge();
    clearResults();
    document.getElementById('test-btn').hidden = project.tests.length === 0 && mode !== 'instructor';
    document.getElementById('new-file-btn').hidden = mode !== 'instructor' && !project.allowNewFiles;
    document.getElementById('new-folder-btn').hidden = mode !== 'instructor' && !project.allowNewFiles;
    if (window.Instructor && window.Instructor.onModeChanged) window.Instructor.onModeChanged(mode);
    if (!worker) spawnWorker(); else syncWorkerFiles();
}

function storageKey() { return 'pyws:work:' + project.id + ':' + (project.title || ''); }

function rebuildWorkspace() {
    virtualFiles = {};
    binaryFiles = new Set();
    selectedFiles.clear();
    for (const [path, f] of Object.entries(project.files)) {
        if (mode !== 'instructor' && f.role === 'hidden') continue;
        let content = f.content;
        if (mode === 'instructor' && solutionView && f.solution != null) content = f.solution;
        virtualFiles[path] = content;
        if (f.binary) binaryFiles.add(path);
        ensureParentFolders(path);
    }
    if (mode === 'student') restoreStudentWork();
    const files = Object.keys(virtualFiles).filter(k => virtualFiles[k] !== null).sort();
    const first = files.includes(project.entry) ? project.entry : (files.find(f => f.endsWith('.py')) || files[0] || null);
    isDirty = false;
    setEditorContent(first);
}

function restoreStudentWork() {
    try {
        const raw = localStorage.getItem(storageKey());
        if (!raw) return;
        const saved = JSON.parse(raw);
        let restored = false;
        for (const [path, content] of Object.entries(saved.files || {})) {
            const f = project.files[path];
            if (f && f.role !== 'starter') continue; // protected paths always come from the package
            if (!f && !project.allowNewFiles) continue;
            virtualFiles[path] = content;
            if (content !== null) ensureParentFolders(path);
            restored = true;
        }
        if (restored) {
            const when = saved.savedAt ? new Date(saved.savedAt).toLocaleString() : 'earlier';
            showBanner(`Restored your saved work from ${when}.`, 'info', [{ label: 'Start over', onClick: resetAllStudentWork }]);
        }
    } catch (e) { /* storage unavailable */ }
}

function scheduleStudentSave() {
    if (mode !== 'student') return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveStudentWork, 800);
}

function saveStudentWork() {
    if (mode !== 'student') return;
    const files = {};
    for (const [path, content] of Object.entries(virtualFiles)) {
        const f = project.files[path];
        if (f && f.role !== 'starter') continue;
        files[path] = content;
    }
    try {
        localStorage.setItem(storageKey(), JSON.stringify({ savedAt: Date.now(), files }));
    } catch (e) { /* quota or disabled */ }
}

function clearStudentWork() {
    try { localStorage.removeItem(storageKey()); } catch (e) {}
}

function resetAllStudentWork() {
    if (!confirm('Start over? This replaces all your files with the original starter files.')) return;
    clearStudentWork();
    hideBanner();
    rebuildWorkspace();
    syncWorkerFiles();
}

function isProtected(path) {
    if (mode === 'instructor') return false;
    const f = project.files[path];
    return !!f && f.role !== 'starter';
}

// ---------------------------------------------------------------------------
// CodeMirror editor
// ---------------------------------------------------------------------------
function initPythonVscodeMode() {
    if (!window.CodeMirror) return;
    const controlKeywords = new Set([
        "if", "else", "elif", "for", "while", "return", "import", "from",
        "try", "except", "finally", "with", "pass", "break", "continue", "raise", "yield"
    ]);
    CodeMirror.defineMode("python-vscode", function (config) {
        const pythonMode = CodeMirror.getMode(config, { name: "python", version: 3 });
        return Object.create(pythonMode, {
            token: {
                value: function (stream, state) {
                    const style = pythonMode.token(stream, state);
                    const current = stream.current();
                    if (style) {
                        if (style.includes("keyword") && controlKeywords.has(current)) return style + " control";
                        if (style.includes("def") && stream.string.slice(0, stream.start).match(/\bclass\s+$/)) return style + " class-name";
                    }
                    return style;
                }
            }
        });
    });
}

function editorModeFor(path) {
    if (!path) return "python-vscode";
    return path.endsWith('.py') ? "python-vscode" : "text/plain";
}

function saveShortcut(cm) {
    syncWorkerFiles();
    showSaveIndicator();
}

function initCodeMirrorEditor() {
    if (!window.CodeMirror) {
        document.getElementById('editor-container').innerHTML = '<div style="color:#d12424;padding:20px;font-family:monospace;">Error: CodeMirror editor failed to load.</div>';
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
            "Tab": function (cm) { if (cm.somethingSelected()) cm.indentMore(); else cm.execCommand("insertSoftTab"); },
            "Shift-Tab": "indentLess",
            "Ctrl-S": saveShortcut,
            "Cmd-S": saveShortcut,
            "Ctrl-Enter": function () { if (!isRunning) toggleExecution(); },
            "Cmd-Enter": function () { if (!isRunning) toggleExecution(); },
            "Ctrl-Q": function (cm) { cm.foldCode(cm.getCursor()); },
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
            "Ctrl-=": function () { changeFontSize(1); },
            "Cmd-=": function () { changeFontSize(1); },
            "Ctrl--": function () { changeFontSize(-1); },
            "Cmd--": function () { changeFontSize(-1); }
        }
    });

    cmEditor.on("keyHandled", (cm, name) => {
        if (name !== "Enter") return;
        const cursor = cm.getCursor();
        const prevLineNum = cursor.line - 1;
        if (prevLineNum < 0) return;
        const lineText = cm.getLine(prevLineNum);
        const trimmed = lineText.trim();
        if (/^(return|pass|break|continue|raise)\b/.test(trimmed) && !trimmed.endsWith('\\') && !trimmed.endsWith(',')) {
            let parens = 0, brackets = 0, braces = 0;
            for (const ch of lineText) {
                if (ch === '(') parens++; else if (ch === ')') parens--;
                else if (ch === '[') brackets++; else if (ch === ']') brackets--;
                else if (ch === '{') braces++; else if (ch === '}') braces--;
            }
            if (parens === 0 && brackets === 0 && braces === 0) cm.indentLine(cursor.line, "subtract");
        }
    });

    cmEditor.on("change", (cm) => {
        clearErrorHighlight();
        if (isLoadingContent) return;
        if (activeFile && virtualFiles[activeFile] != null && !binaryFiles.has(activeFile)) {
            const value = cm.getValue();
            virtualFiles[activeFile] = value;
            isDirty = true;
            if (mode === 'instructor' && window.Instructor) window.Instructor.onFileEdited(activeFile, value, solutionView);
            scheduleStudentSave();
        }
        updateStatusBar(cm);
    });
    cmEditor.on("cursorActivity", updateStatusBar);
}

function clearErrorHighlight() {
    if (currentErrorHandle !== null && cmEditor) {
        cmEditor.removeLineClass(currentErrorHandle, "background", "cm-traceback-error");
        cmEditor.setGutterMarker(currentErrorHandle, "cm-error-gutter", null);
        currentErrorHandle = null;
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
    ind.innerText = mode === 'student' ? 'Saved' : 'Synced to runtime';
    ind.classList.add('show');
    setTimeout(() => ind.classList.remove('show'), 1500);
}

function updateStatusBar(cm) {
    const cursor = cm.getCursor();
    document.getElementById('status-cursor').innerText = `Ln ${cursor.line + 1}, Col ${cursor.ch + 1}`;
    let label = activeFile || "No file selected";
    if (activeFile && isProtected(activeFile)) label += '  🔒 read-only';
    if (mode === 'instructor' && solutionView && activeFile && project.files[activeFile]?.solution != null) label += '  ★ solution';
    document.getElementById('status-filename').innerText = label;
    document.getElementById('status-selection').innerText = cm.somethingSelected() ? `(${cm.getSelection().length} chars selected)` : "";
    document.getElementById('status-mode').innerText = activeFile && !activeFile.endsWith('.py') ? 'Plain Text' : 'Python';
}

function setEditorContent(filename) {
    if (!cmEditor) return;
    isLoadingContent = true;
    clearErrorHighlight();
    if (filename && virtualFiles[filename] != null) {
        activeFile = filename;
        cmEditor.setOption("mode", editorModeFor(filename));
        if (binaryFiles.has(filename)) {
            cmEditor.setOption("readOnly", "nocursor");
            cmEditor.setValue(`# ${filename} is a binary file and cannot be edited here.\n# Your Python code can still open and read it.`);
        } else {
            cmEditor.setOption("readOnly", isProtected(filename) ? true : false);
            cmEditor.setValue(virtualFiles[filename]);
        }
        cmEditor.clearHistory();
        cmEditor.setCursor(0, 0);
    } else {
        activeFile = null;
        cmEditor.setOption("readOnly", "nocursor");
        cmEditor.setValue("# Select a file...");
        cmEditor.clearHistory();
    }
    isLoadingContent = false;
    updateStatusBar(cmEditor);
    initFileExplorer();
    if (window.Instructor && window.Instructor.onActiveFileChanged) window.Instructor.onActiveFileChanged(activeFile);
}

// ---------------------------------------------------------------------------
// Instructions pane
// ---------------------------------------------------------------------------
function renderInstructions() {
    const el = document.getElementById('instructions-content');
    try {
        el.innerHTML = marked.parse(project.instructions || '');
    } catch (e) {
        el.innerText = project.instructions || '';
    }
}

window.openInstructionsNewTab = function () {
    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${(project.title || 'Assignment').replace(/</g, '&lt;')} — Instructions</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.2.0/github-markdown-dark.min.css">
    <style>body { background:#1e1e1e; color:#f0f0f0; padding:40px; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; } .markdown-body { max-width:800px; margin:0 auto; }</style>
    <script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"><\/script>
</head>
<body class="markdown-body">
    <div id="content"></div>
    <script>document.getElementById('content').innerHTML = marked.parse(${JSON.stringify(project.instructions || '')});<\/script>
</body>
</html>`;
    const url = URL.createObjectURL(new Blob([htmlContent], { type: 'text/html' }));
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 10000);
};

window.toggleInstructionsPane = function () {
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
    setTimeout(() => { fitAddon.fit(); if (cmEditor) cmEditor.refresh(); }, 250);
}

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------
function ensureParentFolders(path) {
    const parts = path.split('/');
    parts.pop();
    let current = "";
    for (const p of parts) {
        current = current ? `${current}/${p}` : p;
        if (virtualFiles[current] === undefined) virtualFiles[current] = null;
    }
}

function initFileExplorer() {
    const listEl = document.getElementById('file-list');
    listEl.innerHTML = '';
    const tree = {};
    Object.keys(virtualFiles).sort().forEach(path => {
        const parts = path.split('/');
        let curr = tree;
        parts.forEach((part, idx) => {
            if (!curr[part]) curr[part] = (idx === parts.length - 1 && virtualFiles[path] !== null) ? { __file: path } : {};
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
        li.dataset.path = fullPath;
        if (!isFolder && fullPath === activeFile) li.classList.add('active');
        if (selectedFiles.has(fullPath)) li.classList.add('selected');

        const rowContent = document.createElement('div');
        rowContent.className = 'file-row-content';
        const icon = isFolder ? '📁' : (isProtected(fullPath) ? '🔒' : '📄');
        rowContent.innerText = `${icon} ${name}`;
        li.appendChild(rowContent);

        li.onclick = (e) => {
            e.stopPropagation();
            if (e.metaKey || e.ctrlKey) {
                if (selectedFiles.has(fullPath)) selectedFiles.delete(fullPath); else selectedFiles.add(fullPath);
                initFileExplorer();
            } else {
                selectedFiles.clear();
                selectedFiles.add(fullPath);
                if (!isFolder) switchFile(fullPath); else initFileExplorer();
            }
        };

        const actions = document.createElement('div');
        actions.className = 'file-actions';
        if (mode === 'instructor' && window.Instructor) {
            window.Instructor.decorateFileItem(li, actions, fullPath, isFolder);
        }
        const f = project.files[fullPath];
        if (mode !== 'instructor' && !isFolder && f && f.role === 'starter') {
            const resetBtn = document.createElement('button');
            resetBtn.className = 'file-delete';
            resetBtn.title = 'Reset this file to the starter code';
            resetBtn.innerText = '↺';
            resetBtn.onclick = (e) => { e.stopPropagation(); resetFileToStarter(fullPath); };
            actions.appendChild(resetBtn);
        }
        if (canDelete(fullPath, isFolder)) {
            const delBtn = document.createElement('button');
            delBtn.className = 'file-delete';
            delBtn.title = 'Delete';
            delBtn.innerText = '✕';
            delBtn.onclick = (e) => { e.stopPropagation(); deleteItem(fullPath, isFolder); };
            actions.appendChild(delBtn);
        }
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

function canDelete(path, isFolder) {
    if (mode === 'instructor') return true;
    // Students may delete only things they created (no package files inside).
    if (project.files[path]) return false;
    if (isFolder) return !Object.keys(project.files).some(p => p.startsWith(path + '/'));
    return true;
}

function resetFileToStarter(path) {
    if (!confirm(`Reset ${path} to the original starter code? Your changes to this file will be lost.`)) return;
    virtualFiles[path] = project.files[path].content;
    if (path === activeFile) setEditorContent(path); else initFileExplorer();
    scheduleStudentSave();
    syncWorkerFiles();
}

function switchFile(filename) {
    setEditorContent(filename);
}

function isReservedPath(path) {
    // Students cannot create files that shadow package files (incl. hidden ones).
    return mode !== 'instructor' && project.files[path] !== undefined;
}

window.createNewFile = function () {
    const parent = getSelectedFolderContext();
    const filename = prompt(`Enter new filename ${parent ? `in ${parent}` : ''}:`);
    if (!filename) return;
    const cleanName = filename.trim().replace(/^\/+/, '');
    if (!cleanName) return;
    const fullPath = parent ? `${parent}/${cleanName}` : cleanName;
    if (virtualFiles[fullPath] !== undefined || isReservedPath(fullPath)) {
        alert("A file or folder with that name already exists.");
        return;
    }
    virtualFiles[fullPath] = "";
    ensureParentFolders(fullPath);
    if (mode === 'instructor' && window.Instructor) window.Instructor.onFileCreated(fullPath);
    setEditorContent(fullPath);
    isDirty = true;
    scheduleStudentSave();
    syncWorkerFiles();
};

window.createNewFolder = function () {
    const parent = getSelectedFolderContext();
    const foldername = prompt(`Enter new folder name ${parent ? `in ${parent}` : ''}:`);
    if (!foldername) return;
    const cleanName = foldername.trim().replace(/^\/+|\/+$/g, '');
    if (!cleanName) return;
    const fullPath = parent ? `${parent}/${cleanName}` : cleanName;
    if (virtualFiles[fullPath] !== undefined) {
        alert("A file or folder with that name already exists.");
        return;
    }
    virtualFiles[fullPath] = null;
    ensureParentFolders(fullPath);
    initFileExplorer();
    isDirty = true;
    scheduleStudentSave();
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
    if (!confirm(`Are you sure you want to delete ${path}?`)) return;
    const isDeletingActive = (activeFile === path || (activeFile && activeFile.startsWith(path + '/')));
    for (const k of Object.keys(virtualFiles)) {
        if (k === path || k.startsWith(path + '/')) {
            delete virtualFiles[k];
            binaryFiles.delete(k);
        }
    }
    if (mode === 'instructor' && window.Instructor) window.Instructor.onPathDeleted(path);
    selectedFiles.delete(path);
    if (isDeletingActive) {
        const remaining = Object.keys(virtualFiles).filter(k => virtualFiles[k] !== null);
        setEditorContent(remaining[0] || null);
    } else {
        initFileExplorer();
    }
    isDirty = true;
    scheduleStudentSave();
    syncWorkerFiles();
}

function updateDownloadButtonState() {
    document.getElementById('download-btn').disabled = selectedFiles.size === 0;
}

function fileBlob(path) {
    return binaryFiles.has(path) ? new Blob([b64ToBytes(virtualFiles[path])]) : new Blob([virtualFiles[path]], { type: 'text/plain;charset=utf-8' });
}
function zipAdd(zip, path) {
    if (virtualFiles[path] === null) zip.folder(path);
    else if (binaryFiles.has(path)) zip.file(path, virtualFiles[path], { base64: true });
    else zip.file(path, virtualFiles[path]);
}

function triggerDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

window.downloadSelected = async function () {
    if (selectedFiles.size === 0) return;
    if (selectedFiles.size === 1) {
        const path = Array.from(selectedFiles)[0];
        if (virtualFiles[path] !== null) {
            triggerDownload(fileBlob(path), path.split('/').pop());
            return;
        }
    }
    const zip = new JSZip();
    selectedFiles.forEach(path => {
        zipAdd(zip, path);
        if (virtualFiles[path] === null) {
            Object.keys(virtualFiles).forEach(k => { if (k.startsWith(path + '/')) zipAdd(zip, k); });
        }
    });
    triggerDownload(await zip.generateAsync({ type: "blob" }), "workspace-export.zip");
};

window.toggleSidebar = function () {
    document.getElementById('file-sidebar').classList.toggle('collapsed');
    setTimeout(() => { fitAddon.fit(); if (cmEditor) cmEditor.refresh(); }, 210);
};

// ---------------------------------------------------------------------------
// Splitters
// ---------------------------------------------------------------------------
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
            const delta = ((isX ? ev.clientX : ev.clientY) - startPos) * direction;
            const minVal = typeof getMin === "function" ? getMin() : getMin;
            const maxVal = typeof getMax === "function" ? getMax() : getMax;
            latestClamped = Math.max(minVal, Math.min(startVal + delta, maxVal));
            if (!rafId) {
                rafId = requestAnimationFrame(() => {
                    apply(latestClamped);
                    fitAddon.fit();
                    if (cmEditor) cmEditor.refresh();
                    rafId = null;
                });
            }
        };
        const cleanup = () => {
            if (rafId) cancelAnimationFrame(rafId);
            apply(latestClamped);
            try { el.releasePointerCapture(e.pointerId); } catch (err) {}
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
    const bottomPane = document.getElementById('terminal-container');
    const centerPane = document.getElementById('center-pane');
    const cssInt = (name, d) => parseInt(getComputedStyle(document.documentElement).getPropertyValue(name)) || d;
    makeSplitter({
        el: document.getElementById('sidebar-splitter'), axis: "x", direction: 1,
        getStart: () => sidebar.clientWidth,
        apply: (w) => { sidebar.style.width = `${w}px`; },
        getMin: () => cssInt('--sidebar-min', 120), getMax: () => cssInt('--sidebar-max', 400)
    });
    makeSplitter({
        el: document.getElementById('instructions-splitter'), axis: "x", direction: -1,
        getStart: () => instructionsPane.clientWidth,
        apply: (w) => { instructionsPane.style.width = `${w}px`; },
        getMin: () => cssInt('--instructions-min', 200), getMax: () => cssInt('--instructions-max', 900)
    });
    makeSplitter({
        el: document.getElementById('vertical-splitter'), axis: "y", direction: -1,
        getStart: () => bottomPane.clientHeight,
        apply: (h) => { bottomPane.style.height = `${h}px`; },
        getMin: () => 90, getMax: () => centerPane.clientHeight - 80 - 5
    });
}

function initTerminalResize() {
    new ResizeObserver(() => { fitAddon.fit(); if (cmEditor) cmEditor.refresh(); })
        .observe(document.getElementById('terminal-host'));
}

// Bottom pane: Terminal | Test Results
function initBottomTabs() {
    document.querySelectorAll('.bottom-tab').forEach(btn => {
        btn.addEventListener('click', () => showBottomTab(btn.dataset.tab));
    });
}
function showBottomTab(tab) {
    document.querySelectorAll('.bottom-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.getElementById('terminal-host').hidden = tab !== 'terminal';
    document.getElementById('results-panel').hidden = tab !== 'results';
    if (tab === 'terminal') setTimeout(() => fitAddon.fit(), 0);
}

// ---------------------------------------------------------------------------
// Banners, badges, toasts
// ---------------------------------------------------------------------------
function showBanner(text, kind = 'info', actions = []) {
    const el = document.getElementById('banner');
    el.className = 'banner ' + kind;
    el.innerHTML = '';
    const span = document.createElement('span');
    span.innerText = text;
    el.appendChild(span);
    for (const a of actions) {
        const b = document.createElement('button');
        b.className = 'tool-btn';
        b.innerText = a.label;
        b.onclick = a.onClick;
        el.appendChild(b);
    }
    const close = document.createElement('button');
    close.className = 'banner-close';
    close.innerText = '✕';
    close.title = 'Dismiss';
    close.onclick = hideBanner;
    el.appendChild(close);
    el.hidden = false;
}
function hideBanner() { document.getElementById('banner').hidden = true; }

function toast(text, kind = 'info') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.innerText = text;
    document.getElementById('toast-host').appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3200);
}

function updateConnectionBadge() {
    const badge = document.getElementById('lms-badge');
    if (mode === 'instructor') { badge.hidden = true; return; }
    badge.hidden = false;
    if (mode === 'preview') {
        badge.className = 'lms-badge preview';
        badge.innerText = 'Student preview · scores not sent';
    } else if (window.SCORM && SCORM.active) {
        badge.className = 'lms-badge on';
        badge.innerText = 'Connected to D2L';
    } else {
        badge.className = 'lms-badge off';
        badge.innerText = project.tests.length ? 'Practice mode · not connected to D2L' : 'Not connected to D2L';
    }
}

// ---------------------------------------------------------------------------
// Exit modal
// ---------------------------------------------------------------------------
window.showExitModal = function () {
    const autosaves = mode === 'student';
    document.getElementById('modal-title').innerText = "Exit Lab";
    document.getElementById('modal-text').innerText = autosaves
        ? "Your work is saved in this browser and will be here when you return on this device. Download a copy if you plan to switch computers."
        : "Your work will be lost when you exit. Download your files before leaving.";
    document.getElementById('clear-storage-label').hidden = !autosaves;
    document.getElementById('clear-storage-checkbox').checked = false;
    document.getElementById('modal-download-btn').innerText = "Download my work (.zip)";
    document.getElementById('exit-modal-backdrop').classList.add('show');
    document.getElementById('modal-cancel-btn').focus();
};

window.hideExitModal = function () {
    document.getElementById('exit-modal-backdrop').classList.remove('show');
    document.getElementById('exit-btn').focus();
};

window.modalDownloadWork = async function () {
    const zip = new JSZip();
    Object.keys(virtualFiles).forEach(path => zipAdd(zip, path));
    triggerDownload(await zip.generateAsync({ type: "blob" }), "workspace-export.zip");
    isDirty = false;
    document.getElementById('modal-download-btn').innerText = "Downloaded ✓";
    setTimeout(() => { document.getElementById('modal-download-btn').innerText = "Download my work (.zip)"; }, 2000);
};

window.modalExitAnyway = function () {
    if (mode === 'student') {
        if (document.getElementById('clear-storage-checkbox').checked) clearStudentWork(); else saveStudentWork();
    }
    if (window.SCORM) SCORM.finish();
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
        if (mode === 'student') saveStudentWork();
        if (isDirty && mode !== 'student') {
            e.preventDefault();
            e.returnValue = "";
        }
    });
    window.addEventListener('pagehide', () => {
        if (mode === 'student') saveStudentWork();
        if (window.SCORM) SCORM.finish();
    });
    const modal = document.getElementById('exit-modal');
    modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { hideExitModal(); return; }
        if (e.key === 'Tab') {
            const focusables = modal.querySelectorAll('button:not([hidden]), input:not([hidden]), [tabindex="0"]:not([hidden])');
            if (focusables.length === 0) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
            else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
        }
    });
}

// ---------------------------------------------------------------------------
// Run Code (interactive, replay-based input)
// ---------------------------------------------------------------------------
function spawnWorker() {
    workerReady = false;
    worker = new Worker('js/worker.js');
    worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === 'ready') {
            workerReady = true;
            term.writeln('\x1b[32m[Python ready]\x1b[0m Click ▶ Run Code (Ctrl+Enter) to run the open file.\r\n');
            syncWorkerFiles();
        } else if (msg.type === 'fatal') {
            term.writeln(`\x1b[31m${msg.data}\x1b[0m`);
            term.writeln('\x1b[31mCheck your internet connection and reload the page.\x1b[0m');
        } else if (msg.type === 'stdout') {
            onRunStdout(msg.data);
        } else if (msg.type === 'stderr') {
            term.write(`\x1b[31m${msg.data}\x1b[0m`);
            parseTracebackError(msg.data);
        } else if (msg.type === 'needInput') {
            beginInputWait();
        } else if (msg.type === 'done') {
            runSession = null;
            setButtonState(false);
        }
    };
}

function onRunStdout(text) {
    if (!runSession) { term.write(text); return; }
    const start = runSession.received;
    runSession.received += text.length;
    if (runSession.received <= runSession.shown) return;
    const skip = Math.max(0, runSession.shown - start);
    term.write(text.slice(skip));
    runSession.shown = runSession.received;
}

function beginInputWait() {
    if (!runSession) return;
    runSession.awaiting = true;
    runSession.line = '';
    document.getElementById('terminal-container').classList.add('awaiting-input');
    term.focus();
}

function initTerminalInput() {
    term.onData((data) => {
        if (!runSession || !runSession.awaiting) return;
        for (const ch of data) {
            if (ch === '\r' || ch === '\n') {
                term.write('\r\n');
                const line = runSession.line;
                runSession.inputs.push(line);
                runSession.shown += line.length + 1;
                runSession.awaiting = false;
                document.getElementById('terminal-container').classList.remove('awaiting-input');
                sendRun();
                return;
            } else if (ch === '\x7f' || ch === '\b') {
                if (runSession.line.length) {
                    runSession.line = runSession.line.slice(0, -1);
                    term.write('\b \b');
                }
            } else if (ch === '\x03') {
                stopRun();
                return;
            } else if (ch >= ' ') {
                runSession.line += ch;
                term.write(ch);
            }
        }
    });
}

function parseTracebackError(stderrData) {
    if (!activeFile || !cmEditor) return;
    let targetLineNum = null;
    for (const line of stderrData.split('\n')) {
        const m = line.match(/File\s+"([^"]+)",\s+line\s+(\d+)/);
        if (m) {
            const filePath = m[1].replace(/^\/workspace\//, '');
            if (filePath === activeFile) targetLineNum = parseInt(m[2], 10) - 1;
        }
    }
    if (targetLineNum !== null && targetLineNum >= 0 && targetLineNum < cmEditor.lineCount()) {
        clearErrorHighlight();
        currentErrorHandle = cmEditor.lineInfo(targetLineNum).handle;
        cmEditor.addLineClass(currentErrorHandle, "background", "cm-traceback-error");
        const marker = document.createElement("span");
        marker.className = "cm-error-marker";
        marker.innerHTML = "●";
        cmEditor.setGutterMarker(targetLineNum, "cm-error-gutter", marker);
    }
}

function protectedPaths() {
    return Object.entries(project.files).filter(([, f]) => f.role !== 'starter').map(([p]) => p);
}

function runtimeFileSet() {
    const files = {};
    const binary = [];
    for (const [p, c] of Object.entries(virtualFiles)) {
        files[p] = c;
        if (binaryFiles.has(p)) binary.push(p);
    }
    return { files, binary, readonly: mode === 'instructor' ? [] : protectedPaths() };
}

function syncWorkerFiles() {
    if (worker && workerReady) {
        const { files, binary, readonly } = runtimeFileSet();
        worker.postMessage({ cmd: 'sync', files, binary, readonly });
    }
}

function sendRun() {
    runSession.received = 0;
    worker.postMessage({ cmd: 'run', entrypoint: runSession.target, inputs: runSession.inputs, seed: runSession.seed });
}

function stopRun() {
    if (!isRunning) return;
    worker.terminate();
    runSession = null;
    document.getElementById('terminal-container').classList.remove('awaiting-input');
    term.writeln('\r\n\x1b[31m[Process stopped]\x1b[0m\r\n');
    setButtonState(false);
    spawnWorker();
}

window.toggleExecution = function () {
    if (isRunning) { stopRun(); return; }
    if (!workerReady) { toast('Python is still loading — try again in a moment.'); return; }
    showBottomTab('terminal');
    clearErrorHighlight();
    syncWorkerFiles();
    let targetFile = activeFile;
    if (!targetFile || !targetFile.endsWith('.py')) {
        if (virtualFiles[project.entry] != null) targetFile = project.entry;
        else if (virtualFiles["main.py"] != null) targetFile = "main.py";
        else { term.writeln('\x1b[31mSelect a .py file to run\x1b[0m\r\n'); return; }
    }
    lastRunTargetFile = targetFile;
    runSession = { target: targetFile, inputs: [], shown: 0, received: 0, seed: Math.floor(Math.random() * 1e9), awaiting: false, line: '' };
    setButtonState(true);
    term.writeln(`\x1b[36m$ python3 ${targetFile}\x1b[0m`);
    sendRun();
};

function setButtonState(running) {
    isRunning = running;
    const btn = document.getElementById('action-btn');
    btn.className = running ? 'stop-btn' : 'run-btn';
    btn.innerText = running ? '⏹ Stop' : '▶ Run Code';
}

// ---------------------------------------------------------------------------
// Autograder
// ---------------------------------------------------------------------------
class GraderSession {
    constructor() { this.worker = null; }

    start() {
        return new Promise((resolve, reject) => {
            this.worker = new Worker('js/worker.js');
            const timer = setTimeout(() => reject(new Error('The test runner took too long to start. Check your internet connection.')), 90000);
            this.worker.onmessage = (e) => {
                if (e.data.type === 'ready') { clearTimeout(timer); resolve(); }
                else if (e.data.type === 'fatal') { clearTimeout(timer); reject(new Error(e.data.data)); }
            };
        });
    }

    runTest(test, fileSet) {
        return new Promise((resolve) => {
            const a = new Uint32Array(2);
            crypto.getRandomValues(a);
            const nonce = a[0].toString(36) + a[1].toString(36);
            const limit = Math.max(1, Number(test.timeout) || 5);
            const timer = setTimeout(() => {
                this.stop();
                resolve({ timeout: true, error: `Time limit exceeded (${limit}s). Check for an infinite loop or a program waiting for more input.` });
            }, limit * 1000);
            this.worker.onmessage = (e) => {
                if (e.data.type === 'gradeResult' && e.data.nonce === nonce) {
                    clearTimeout(timer);
                    resolve(e.data.result || { error: 'No result' });
                }
            };
            const payload = Object.assign({}, test, { file: test.file || project.entry });
            this.worker.postMessage({ cmd: 'grade', files: fileSet.files, binary: fileSet.binary, readonly: fileSet.readonly, test: payload, nonce });
        });
    }

    stop() {
        if (this.worker) { this.worker.terminate(); this.worker = null; }
    }
}

/**
 * Build the file set tests run against.
 *  'student'  : the student's working files, with read-only + hidden files restored
 *  'solution' : instructor solution versions (falls back to starter)
 *  'starter'  : untouched starter files
 */
function buildFileSet(kind) {
    const files = {};
    const binary = new Set();
    if (kind === 'student') {
        // The student's working files (hidden files are never in virtualFiles)...
        for (const [p, c] of Object.entries(virtualFiles)) {
            if (c === null) continue;
            files[p] = c;
            if (binaryFiles.has(p)) binary.add(p);
        }
        // ...with read-only and hidden files restored from the package.
        for (const [p, f] of Object.entries(project.files)) {
            if (f.role === 'starter') continue;
            files[p] = f.content;
            if (f.binary) binary.add(p);
        }
    } else {
        for (const [p, f] of Object.entries(project.files)) {
            files[p] = (kind === 'solution' && f.solution != null) ? f.solution : f.content;
            if (f.binary) binary.add(p);
        }
    }
    return { files, binary: Array.from(binary), readonly: protectedPaths() };
}

function normalizeOutput(text) {
    const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\s+$/, ''));
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
}

function deepEqual(a, b, tol) {
    if (typeof a === 'number' && typeof b === 'number') {
        return tol != null && tol !== '' ? Math.abs(a - b) <= Number(tol) : a === b;
    }
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i], tol));
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every(k => deepEqual(a[k], b[k], tol));
}

function firstDifference(expected, actual) {
    const e = expected.split('\n'), a = actual.split('\n');
    for (let i = 0; i < Math.max(e.length, a.length); i++) {
        if (e[i] !== a[i]) {
            if (e[i] === undefined) return `Line ${i + 1}: unexpected extra output "${a[i]}"`;
            if (a[i] === undefined) return `Line ${i + 1}: missing expected line "${e[i]}"`;
            return `Line ${i + 1}: expected "${e[i]}" but got "${a[i]}"`;
        }
    }
    return '';
}

function evaluateTest(test, res) {
    const points = Number(test.points) || 0;
    const out = { id: test.id, name: test.name, hidden: !!test.hidden, points, earned: 0, passed: false, message: '', expected: null, actual: null, stdout: res.stdout || '' };
    if (res.timeout) { out.message = res.error; return out; }
    if (test.type === 'output') {
        const actual = normalizeOutput(res.stdout);
        const expected = normalizeOutput(test.expected);
        out.expected = expected; out.actual = actual;
        let passed = false;
        if (test.match === 'exact') passed = String(res.stdout ?? '') === String(test.expected ?? '');
        else if (test.match === 'contains') passed = actual.includes(expected);
        else if (test.match === 'regex') {
            try { passed = new RegExp(test.expected, 'm').test(res.stdout || ''); }
            catch (e) { out.message = 'Instructor setup error: invalid regular expression'; return out; }
        } else passed = actual === expected;
        if (res.error) {
            out.message = res.error;
            passed = false;
        } else if (!passed) {
            out.message = test.match === 'normalized' || test.match === 'exact'
                ? (firstDifference(expected, actual) || 'Output does not match')
                : 'Output does not contain the expected text';
        }
        out.passed = passed;
    } else if (test.type === 'function') {
        out.expected = res.expectedRepr ?? test.expected;
        out.actual = res.actualRepr ?? null;
        if (res.error) out.message = res.error;
        else {
            out.passed = deepEqual(res.expected, res.actual, test.tolerance);
            if (!out.passed) out.message = `${test.call} returned ${res.actualRepr}, expected ${res.expectedRepr}`;
        }
    } else {
        out.passed = !res.error;
        if (res.error) out.message = res.error;
    }
    if (out.passed) out.earned = points;
    return out;
}

/** Run tests in a fresh, isolated runtime. onEach(index, evaluation) */
async function runTestSuite({ tests, kind, onEach, onStatus }) {
    const fileSet = buildFileSet(kind);
    const session = new GraderSession();
    const results = [];
    try {
        onStatus && onStatus('Starting test runner…');
        await session.start();
        for (let i = 0; i < tests.length; i++) {
            if (!session.worker) { onStatus && onStatus('Restarting test runner…'); await session.start(); }
            onStatus && onStatus(`Running test ${i + 1} of ${tests.length}…`);
            const res = await session.runTest(tests[i], fileSet);
            const ev = evaluateTest(tests[i], res);
            results.push(ev);
            onEach && onEach(i, ev, res);
        }
    } finally {
        session.stop();
    }
    return results;
}

function summarize(results) {
    const total = results.reduce((s, r) => s + r.points, 0);
    const earned = results.reduce((s, r) => s + r.earned, 0);
    const percent = total > 0 ? (earned / total) * 100 : 0;
    return { total, earned, percent, passed: results.filter(r => r.passed).length, count: results.length };
}

window.runTests = async function () {
    if (isTesting) return;
    if (!project.tests.length) { toast('This assignment has no automated tests yet.'); return; }
    if (isRunning) stopRun();
    isTesting = true;
    const btn = document.getElementById('test-btn');
    btn.disabled = true;
    btn.innerText = '⏳ Testing…';
    showBottomTab('results');
    const panel = document.getElementById('results-panel');
    panel.innerHTML = '<div class="results-status">Starting test runner…</div>';
    const viewer = mode === 'instructor' ? 'instructor' : 'student';
    const kind = mode === 'instructor' ? (solutionView ? 'solution' : 'starter') : 'student';
    try {
        const results = await runTestSuite({
            tests: project.tests, kind,
            onStatus: (s) => { const st = panel.querySelector('.results-status'); if (st) st.innerText = s; }
        });
        lastResults = results;
        const sum = summarize(results);
        let report = null;
        if (mode === 'student' && window.SCORM) {
            report = SCORM.reportScore(sum.percent, project.gradePolicy, project.passingScore);
        }
        renderResults(results, { viewer, report, kind });
        if (window.Instructor && window.Instructor.onTestsRun) window.Instructor.onTestsRun(kind, results);
    } catch (e) {
        panel.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'results-status error';
        err.innerText = e.message;
        panel.appendChild(err);
    } finally {
        isTesting = false;
        btn.disabled = false;
        btn.innerText = '✓ Run Tests';
    }
};

function clearResults() {
    lastResults = null;
    document.getElementById('results-panel').innerHTML = '<div class="results-status">Click ✓ Run Tests to check your work against the assignment tests.</div>';
    showBottomTab('terminal');
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.innerText = text;
    return e;
}

function renderResults(results, { viewer, report, kind }) {
    const panel = document.getElementById('results-panel');
    panel.innerHTML = '';
    const sum = summarize(results);
    const header = el('div', 'results-header');
    const score = el('div', 'results-score ' + (sum.earned === sum.total ? 'full' : sum.earned > 0 ? 'partial' : 'zero'));
    score.innerText = `${Math.round(sum.percent)}%`;
    header.appendChild(score);
    const info = el('div', 'results-info');
    info.appendChild(el('div', 'results-line', `${sum.passed} of ${sum.count} tests passed · ${sum.earned} / ${sum.total} points`));
    let sub = '';
    if (viewer === 'instructor') sub = `Ran against the ${kind === 'solution' ? 'SOLUTION' : 'STARTER'} files (instructor view — all details shown).`;
    else if (mode === 'preview') sub = 'Student preview — this score is not sent to D2L.';
    else if (report && report.sent) sub = project.gradePolicy === 'last'
        ? `Score sent to D2L: ${Math.round(report.reported)}%.`
        : `Score sent to D2L: ${Math.round(report.reported)}% (your best score counts).`;
    else sub = 'Practice run — not connected to D2L, so no score was recorded.';
    info.appendChild(el('div', 'results-sub', sub));
    header.appendChild(info);
    panel.appendChild(header);

    results.forEach((r, i) => {
        const showDetails = viewer === 'instructor' || !r.hidden;
        const row = el('div', 'result-row ' + (r.passed ? 'pass' : 'fail'));
        const top = el('div', 'result-top');
        top.appendChild(el('span', 'result-icon', r.passed ? '✔' : '✘'));
        const name = showDetails ? r.name : `Hidden test ${i + 1}`;
        top.appendChild(el('span', 'result-name', (r.hidden ? '🔒 ' : '') + name));
        top.appendChild(el('span', 'result-points', `${r.earned}/${r.points} pt${r.points === 1 ? '' : 's'}`));
        row.appendChild(top);
        if (!r.passed && showDetails && r.message) {
            row.appendChild(el('pre', 'result-msg', r.message));
            if (r.expected != null && r.actual != null && typeof r.expected === 'string' && r.expected.includes('\n') ) {
                const cmp = el('div', 'result-compare');
                const e = el('div'); e.appendChild(el('div', 'cmp-label', 'Expected')); e.appendChild(el('pre', null, r.expected));
                const a = el('div'); a.appendChild(el('div', 'cmp-label', 'Your output')); a.appendChild(el('pre', null, r.actual || '(no output)'));
                cmp.appendChild(e); cmp.appendChild(a);
                row.appendChild(cmp);
            }
        } else if (!r.passed && !showDetails) {
            row.appendChild(el('div', 'result-msg muted', 'Details for hidden tests are not shown.'));
        }
        panel.appendChild(row);
    });
}

// ---------------------------------------------------------------------------
// Public API for instructor.js
// ---------------------------------------------------------------------------
const App = {
    CORE_FILES, BINARY_EXT,
    get project() { return project; },
    set project(p) { project = normalizeProject(p); },
    get mode() { return mode; },
    get solutionView() { return solutionView; },
    set solutionView(v) { solutionView = !!v; },
    get virtualFiles() { return virtualFiles; },
    get binaryFiles() { return binaryFiles; },
    get activeFile() { return activeFile; },
    get lastResults() { return lastResults; },
    setMode, rebuildWorkspace, renderInstructions, setEditorContent, initFileExplorer,
    syncWorkerFiles, runTestSuite, evaluateTest, summarize, renderResults, showBottomTab,
    normalizeProject, encodePackage, decodePackage, fetchText, fetchBase64,
    bytesToB64, b64ToBytes, triggerDownload, showBanner, hideBanner, toast, uid,
    ensureParentFolders, updateConnectionBadge,
    refreshEditor() { if (cmEditor) cmEditor.refresh(); fitAddon.fit(); }
};
window.App = App;
