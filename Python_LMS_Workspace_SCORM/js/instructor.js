// ===========================================================================
// Instructor Mode — only present in the instructor template.
// It is NOT included in exported student packages, so students never get
// these tools. Loaded by js/app.js when assignment/assignment.json exists.
// ===========================================================================
(function () {
    let App = null;
    let activeTab = 'instructions';
    let instructionsView = 'edit';
    let testStatus = {};         // testId -> { solution: evaluation, starter: evaluation, solutionHash }
    let validation = { solutionHash: null, solutionAllPass: false, starterPercent: null };
    let draftTimer = null;
    let draftWarned = false;
    let folderProjectJSON = null; // snapshot of the project as loaded from the folder
    const DRAFT_KEY = 'pyws:instructor-draft:' + location.pathname;
    const SAMPLE_ID = 'sample-assignment';
    const PLACEHOLDER_INSTRUCTIONS = '# Assignment Title\n\nDescribe the task here.\n';

    // ---------------------------------------------------------------- helpers
    function h(tag, attrs, ...children) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v == null || v === false) continue;
            if (k === 'icon') continue;
            if (k === 'class') el.className = v;
            else if (k === 'text') el.innerText = v;
            else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
            else if (k === 'value') el.value = v;
            else if (k === 'checked') el.checked = !!v;
            else el.setAttribute(k, v === true ? '' : v);
        }
        for (const c of children.flat()) {
            if (c == null || c === false) continue;
            el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        }
        if (attrs && attrs.icon) el.insertAdjacentHTML('afterbegin', App.icon(attrs.icon));
        return el;
    }
    const P = () => App.project;
    const slug = (s) => (s || 'assignment').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'assignment';
    function hashStr(s) {
        let x = 2166136261;
        for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
        return (x >>> 0).toString(36);
    }
    const gradingHash = () => hashStr(JSON.stringify({ t: P().tests, f: P().files, e: P().entry }));
    const pyFiles = () => Object.keys(P().files).filter(p => p.endsWith('.py')).sort();

    // ---------------------------------------------------------------- init
    const Instructor = {
        async init(app) {
            App = app;
            folderProjectJSON = JSON.stringify(P());
            restoreDraft();
            buildToolbar();
            buildSidebarExtra();
            App.setMode('instructor');
        },

        onModeChanged(mode) {
            const sw = document.getElementById('mode-switch');
            sw.hidden = false;
            if (modeMenu) modeMenu.refresh();
            if (mode === 'instructor') {
                renderPanel();
                renderEditorHeader();
            }
            setTimeout(() => App.refreshEditor(), 50);
        },

        onFileEdited(path, value, solView) {
            const f = P().files[path];
            if (!f) {
                P().files[path] = { role: 'starter', content: value, binary: false, solution: null };
            } else if (solView && f.solution != null) {
                f.solution = value;
            } else {
                f.content = value;
            }
            changed({ quiet: true });
        },

        onFileCreated(path) {
            P().files[path] = { role: path.endsWith('.py') ? 'starter' : 'readonly', content: '', binary: false, solution: null };
            changed();
        },

        onPathDeleted(path) {
            for (const k of Object.keys(P().files)) {
                if (k === path || k.startsWith(path + '/')) delete P().files[k];
            }
            changed();
        },

        decorateFileItem(li, actions, path, isFolder) {
            if (isFolder) return;
            const f = P().files[path];
            if (!f) return;
            const labels = { starter: ['S', 'Starter — students can see and edit'], readonly: ['R', 'Read-only — students can see but not edit'], hidden: ['H', 'Hidden — only available to tests'] };
            const [letter, tip] = labels[f.role];
            const badge = h('button', { class: `role-badge role-${f.role}`, title: tip + ' (click to change)', text: letter });
            badge.addEventListener('click', (e) => { e.stopPropagation(); cycleRole(path); });
            li.querySelector('.file-row-content').prepend(badge);
            if (f.solution != null) {
                li.querySelector('.file-row-content').appendChild(h('span', { class: 'sol-star', title: 'Has a solution version', icon: 'star' }));
            }
        },

        onActiveFileChanged() { renderEditorHeader(); },

        onTestsRun(kind, results) {
            recordResults(kind, P().tests, results);
            if (activeTab === 'tests' || activeTab === 'publish') renderPanel();
        }
    };
    window.Instructor = Instructor;

    // ---------------------------------------------------------------- drafts
    function restoreDraft() {
        try {
            const raw = localStorage.getItem(DRAFT_KEY);
            if (!raw) return;
            const draft = JSON.parse(raw);
            if (!draft.project || JSON.stringify(App.normalizeProject(draft.project)) === folderProjectJSON) return;
            App.project = draft.project;
            const when = new Date(draft.savedAt).toLocaleString();
            App.showBanner(`Restored your unsaved work from ${when}. Use Menu (top left) → Save Project to keep a copy.`, 'info', [
                { label: 'Discard draft', onClick: discardDraft }
            ]);
        } catch (e) { /* ignore */ }
    }

    function discardDraft() {
        if (!confirm('Discard your draft and reload the assignment from the folder?')) return;
        try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
        App.project = JSON.parse(folderProjectJSON);
        testStatus = {};
        App.hideBanner();
        App.setMode('instructor');
    }

    function saveDraft() {
        try {
            localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), project: P() }));
            const ind = document.getElementById('save-indicator');
            ind.innerText = 'Draft saved';
            ind.classList.add('show');
            setTimeout(() => ind.classList.remove('show'), 1200);
        } catch (e) {
            if (!draftWarned) { draftWarned = true; App.toast('Too large to autosave in the browser — use Menu (top left) → Save Project.', 'warn'); }
        }
    }

    function changed(opts = {}) {
        clearTimeout(draftTimer);
        draftTimer = setTimeout(saveDraft, 600);
        if (!opts.quiet) {
            if (activeTab !== 'instructions') renderPanel();
        } else {
            updateTabBadges();
        }
    }

    // ---------------------------------------------------------------- toolbar
    let modeMenu = null;

    function buildToolbar() {
        const sw = document.getElementById('mode-switch');
        sw.innerHTML = '';
        modeMenu = App.menuButton({
            label: () => App.mode === 'preview' ? 'Student preview' : 'Instructor',
            iconName: () => App.mode === 'preview' ? 'eye' : 'pencil',
            title: 'Switch between building the assignment and seeing it as a student',
            items: () => [
                { label: 'Instructor', icon: 'pencil', checked: App.mode === 'instructor', title: 'Build and test the assignment', onClick: () => App.setMode('instructor') },
                { label: 'Student preview', icon: 'eye', checked: App.mode === 'preview', title: 'See exactly what students will see', onClick: () => App.setMode('preview') }
            ]
        });
        sw.appendChild(modeMenu);
        const actions = document.getElementById('instructor-actions');
        actions.innerHTML = '';
        const openInput = h('input', { type: 'file', accept: '.zip', hidden: true, onchange: (e) => { if (e.target.files[0]) openProjectFile(e.target.files[0]); e.target.value = ''; } });
        const mainMenu = App.menuButton({
            iconName: 'menu', title: 'Menu: new, open or save a project', className: 'icon-btn', align: 'start',
            items: () => [
                { label: 'New assignment', icon: 'newDoc', title: 'Start a new, empty assignment', onClick: newAssignment },
                { label: 'Open…', icon: 'open', title: 'Open a saved project (.zip) or an exported D2L package', onClick: () => openInput.click() },
                '-',
                { label: 'Save Project (.zip)', icon: 'save', title: 'Download the full project, including solutions', onClick: saveProject }
            ]
        });
        actions.append(mainMenu, openInput);
    }

    function buildSidebarExtra() {
        const box = document.getElementById('sidebar-extra');
        const input = h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => { addUploadedFiles(e.target.files); e.target.value = ''; } });
        const uploadBtn = h('button', { class: 'upload-btn', onclick: () => input.click(), title: 'Add files (or drag & drop onto this panel)' });
        App.setBtn(uploadBtn, 'upload', 'Upload files');
        box.append(
            uploadBtn,
            h('div', { class: 'role-legend' },
                h('span', { class: 'role-badge role-starter', text: 'S' }), ' starter ',
                h('span', { class: 'role-badge role-readonly', text: 'R' }), ' read-only ',
                h('span', { class: 'role-badge role-hidden', text: 'H' }), ' hidden'),
            input
        );
        const sidebar = document.getElementById('file-sidebar');
        sidebar.addEventListener('dragover', (e) => { if (App.mode === 'instructor') { e.preventDefault(); sidebar.classList.add('drop-target'); } });
        sidebar.addEventListener('dragleave', () => sidebar.classList.remove('drop-target'));
        sidebar.addEventListener('drop', (e) => {
            sidebar.classList.remove('drop-target');
            if (App.mode !== 'instructor') return;
            e.preventDefault();
            addUploadedFiles(e.dataTransfer.files);
        });
    }

    async function addUploadedFiles(fileList) {
        let added = 0;
        for (const file of Array.from(fileList)) {
            const path = (file.webkitRelativePath || file.name).replace(/^\/+/, '');
            const bytes = new Uint8Array(await file.arrayBuffer());
            let binary = App.BINARY_EXT.test(path), content;
            if (!binary) {
                try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
                catch (e) { binary = true; }
            }
            if (binary) content = App.bytesToB64(bytes);
            const existing = P().files[path];
            P().files[path] = {
                role: existing ? existing.role : (path.endsWith('.py') ? 'starter' : 'readonly'),
                content, binary, solution: existing ? existing.solution : null
            };
            added++;
        }
        if (added) {
            App.rebuildWorkspace();
            App.syncWorkerFiles();
            changed();
            App.toast(`Added ${added} file${added === 1 ? '' : 's'}. Click a file's badge to change who can see it.`);
        }
    }

    function cycleRole(path) {
        const order = ['starter', 'readonly', 'hidden'];
        const f = P().files[path];
        f.role = order[(order.indexOf(f.role) + 1) % order.length];
        const msg = { starter: 'students can see and edit it', readonly: 'students can see it but not edit it', hidden: 'students never see it; tests can use it' };
        App.toast(`${path}: ${f.role} — ${msg[f.role]}`);
        App.initFileExplorer();
        changed();
    }

    // ---------------------------------------------------------------- editor header
    function renderEditorHeader() {
        const box = document.getElementById('editor-header');
        box.innerHTML = '';
        if (App.mode !== 'instructor') return;
        const sv = App.solutionView;
        const seg = h('div', { class: 'segmented' },
            h('button', { class: !sv ? 'active' : '', onclick: () => setSolutionView(false), title: 'The code students start with', text: 'Starter code' }),
            h('button', { class: sv ? 'active' : '', onclick: () => setSolutionView(true), title: 'Your working solution (never shipped to students)', icon: 'star', text: 'Solution' })
        );
        box.appendChild(seg);
        const path = App.activeFile;
        const f = path && P().files[path];
        let note = null;
        if (f) {
            if (f.role === 'hidden') note = h('span', { class: 'hdr-note' }, 'Hidden file — students never see it; tests can read it.');
            else if (f.role === 'readonly') note = h('span', { class: 'hdr-note' }, 'Read-only — students can view but not edit this file.');
            else if (sv && f.solution == null && !f.binary) {
                note = h('span', { class: 'hdr-note warn' }, 'No solution version yet — edits here change the starter file. ',
                    h('button', { class: 'link-btn', onclick: () => { f.solution = f.content; refreshAfterFileChange(); }, text: 'Create solution from starter' }));
            } else if (sv && f.solution != null) {
                note = h('span', { class: 'hdr-note sol' }, 'Editing the solution. Students never receive this. ',
                    h('button', { class: 'link-btn', onclick: () => { if (confirm('Remove the solution version of ' + path + '?')) { f.solution = null; refreshAfterFileChange(); } }, text: 'Remove solution' }));
            } else note = h('span', { class: 'hdr-note' }, 'Starter code — this is what students start with.');
        }
        if (note) box.appendChild(note);
    }

    function refreshAfterFileChange() {
        const active = App.activeFile;
        App.rebuildWorkspace();
        if (active && App.virtualFiles[active] != null) App.setEditorContent(active);
        App.syncWorkerFiles();
        changed();
        renderEditorHeader();
    }

    function setSolutionView(v) {
        App.solutionView = v;
        refreshAfterFileChange();
    }

    // ---------------------------------------------------------------- right panel
    function updateTabBadges() {
        const t = document.querySelector('.ipanel-tab[data-tab="tests"]');
        if (t) t.innerHTML = `Tests <span class="count">${P().tests.length}</span>`;
    }

    function updateTabBadgeIn(tabs) {
        const t = tabs.querySelector('.ipanel-tab[data-tab="tests"]');
        if (t) t.innerHTML = `Tests <span class="count">${P().tests.length}</span>`;
    }

    function renderPanel() {
        const panel = document.getElementById('instructor-panel');
        panel.innerHTML = '';
        const tabs = h('div', { class: 'ipanel-tabs' },
            ...[['instructions', 'Instructions'], ['tests', 'Tests'], ['settings', 'Settings'], ['publish', 'Publish']]
                .map(([id, label]) => h('button', { class: 'ipanel-tab' + (activeTab === id ? ' active' : ''), 'data-tab': id, onclick: () => { activeTab = id; renderPanel(); }, text: label }))
        );
        updateTabBadgeIn(tabs);
        tabs.appendChild(h('button', { class: 'icon-btn ipanel-hide', title: 'Hide panel', 'aria-label': 'Hide panel', icon: 'panelRight', onclick: () => window.toggleInstructionsPane() }));
        panel.appendChild(tabs);
        const body = h('div', { class: 'ipanel-body' });
        panel.appendChild(body);
        ({ instructions: renderInstructionsTab, tests: renderTestsTab, settings: renderSettingsTab, publish: renderPublishTab })[activeTab](body);
    }

    // --- Instructions ---------------------------------------------------------
    function renderInstructionsTab(body) {
        body.classList.add('fill');
        const seg = h('div', { class: 'segmented small' },
            h('button', { class: instructionsView === 'edit' ? 'active' : '', onclick: () => { instructionsView = 'edit'; renderPanel(); }, text: 'Edit' }),
            h('button', { class: instructionsView === 'preview' ? 'active' : '', onclick: () => { instructionsView = 'preview'; renderPanel(); }, text: 'Preview' })
        );
        body.appendChild(h('div', { class: 'tab-toolbar' }, seg, h('span', { class: 'hint' }, 'Markdown: # Heading, **bold**, `code`, - list, ``` code block ```')));
        if (instructionsView === 'edit') {
            const ta = h('textarea', { class: 'md-editor', spellcheck: 'true', value: P().instructions,
                oninput: (e) => { P().instructions = e.target.value; App.renderInstructions(); changed({ quiet: true }); } });
            body.appendChild(ta);
        } else {
            const prev = h('div', { class: 'markdown-body md-preview' });
            prev.innerHTML = marked.parse(P().instructions || '');
            body.appendChild(prev);
        }
    }

    // --- Tests ----------------------------------------------------------------
    function newTest(type) {
        const base = { id: App.uid(), name: '', type, points: 1, hidden: false, file: '', stdin: '', expected: '', match: 'normalized', call: '', tolerance: null, code: '', timeout: 5 };
        if (type === 'output') base.name = 'Program output';
        if (type === 'function') { base.name = 'Function returns correct value'; base.call = 'my_function(1, 2)'; base.expected = '3'; }
        if (type === 'code') { base.name = 'Custom check'; base.code = '# Use assert statements. Available names:\n#   module  - the student\'s file (module.some_function)\n#   source  - the student\'s code as text\n#   run(stdin="") - runs the program, returns its output\nassert "for" in source, "Use a for loop"\n'; }
        P().tests.push(base);
        changed();
        setTimeout(() => {
            const card = document.querySelector(`.test-card[data-id="${base.id}"]`);
            if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); card.classList.add('flash'); }
        }, 50);
    }

    function recordResults(kind, tests, results) {
        const hash = gradingHash();
        results.forEach((r, i) => {
            const id = tests[i].id;
            testStatus[id] = testStatus[id] || {};
            testStatus[id][kind] = r;
            if (kind === 'solution') testStatus[id].solutionHash = hash;
        });
        if (tests.length === P().tests.length) {
            const sum = App.summarize(results);
            if (kind === 'solution') { validation.solutionHash = hash; validation.solutionAllPass = sum.passed === sum.count; }
            if (kind === 'starter') validation.starterPercent = sum.percent;
        }
    }

    async function runAll(kind) {
        if (!P().tests.length) { App.toast('Add a test first.'); return; }
        const status = document.getElementById('tests-run-status');
        try {
            const results = await App.runTestSuite({ tests: P().tests, kind, onStatus: (s) => { if (status) status.innerText = s; } });
            recordResults(kind, P().tests, results);
            App.renderResults(results, { viewer: 'instructor', kind });
            App.showBottomTab('results');
        } catch (e) { App.toast(e.message, 'error'); }
        renderPanel();
    }

    async function runOne(t, kind = 'solution') {
        try {
            const results = await App.runTestSuite({ tests: [t], kind });
            recordResults(kind, [t], results);
        } catch (e) { App.toast(e.message, 'error'); }
        renderPanel();
    }

    async function fillFromSolution(t) {
        const probe = Object.assign({}, t, { type: t.type, match: 'normalized' });
        let raw = null;
        try {
            await App.runTestSuite({ tests: [probe], kind: 'solution', onEach: (i, ev, res) => { raw = res; } });
        } catch (e) { App.toast(e.message, 'error'); return; }
        if (!raw) return;
        if (raw.timeout || raw.error) {
            App.toast('The solution failed: ' + (raw.error || 'timeout').split('\n').slice(-1)[0], 'error');
            return;
        }
        if (t.type === 'output') t.expected = (raw.stdout || '').replace(/\s+$/, '') + '\n';
        if (t.type === 'function') t.expected = raw.actualRepr;
        App.toast('Expected value filled from your solution.');
        changed();
    }

    function statusChip(label, ev, stale) {
        if (!ev) return h('span', { class: 'chip none', title: `Not run on ${label.toLowerCase()} yet` }, `${label}: –`);
        const cls = stale ? 'chip stale' : (ev.passed ? 'chip pass' : 'chip fail');
        return h('span', { class: cls, title: stale ? 'Out of date — re-run' : (ev.message || 'Passed') }, `${label}: ${ev.passed ? 'pass' : 'fail'}${stale ? ' (stale)' : ''}`);
    }

    function field(label, input, hint) {
        return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
    }

    function bind(t, key, transform) {
        return (e) => {
            const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
            t[key] = transform ? transform(v) : v;
            changed({ quiet: true });
        };
    }

    function fileSelect(t) {
        const files = pyFiles();
        const sel = h('select', { onchange: bind(t, 'file') },
            h('option', { value: '' }, `(entry file: ${P().entry})`),
            ...files.map(f => h('option', { value: f }, f)));
        sel.value = t.file || '';
        return sel;
    }

    function renderTestCard(t, idx) {
        const st = testStatus[t.id] || {};
        const stale = st.solutionHash && st.solutionHash !== gradingHash();
        const typeLabel = { output: 'Output', function: 'Function', code: 'Custom code' }[t.type];
        const card = h('div', { class: 'test-card', 'data-id': t.id });
        const head = h('div', { class: 'test-head' },
            h('span', { class: 'test-type type-' + t.type, text: typeLabel }),
            h('input', { class: 'test-name', value: t.name, placeholder: 'Test name (students see this)', oninput: bind(t, 'name') }),
            h('div', { class: 'test-tools' },
                h('button', { class: 'icon-btn', title: 'Run this test on your solution', onclick: () => runOne(t), icon: 'play' }),
                h('button', { class: 'icon-btn', title: 'Move up', disabled: idx === 0, onclick: () => { const a = P().tests; [a[idx - 1], a[idx]] = [a[idx], a[idx - 1]]; changed(); }, icon: 'arrowUp' }),
                h('button', { class: 'icon-btn', title: 'Move down', disabled: idx === P().tests.length - 1, onclick: () => { const a = P().tests; [a[idx + 1], a[idx]] = [a[idx], a[idx + 1]]; changed(); }, icon: 'arrowDown' }),
                h('button', { class: 'icon-btn', title: 'Duplicate', onclick: () => { const c = JSON.parse(JSON.stringify(t)); c.id = App.uid(); c.name += ' (copy)'; P().tests.splice(idx + 1, 0, c); changed(); }, icon: 'copy' }),
                h('button', { class: 'icon-btn danger', title: 'Delete test', onclick: () => { if (confirm(`Delete "${t.name}"?`)) { P().tests.splice(idx, 1); changed(); } }, icon: 'trash' })
            )
        );
        card.appendChild(head);
        card.appendChild(h('div', { class: 'test-status' }, statusChip('Solution', st.solution, stale), statusChip('Starter', st.starter, false)));
        if (st.solution && !st.solution.passed && !stale && st.solution.message) {
            card.appendChild(h('pre', { class: 'test-error' }, st.solution.message));
        }

        const grid = h('div', { class: 'test-grid' });
        grid.append(
            field('Points', h('input', { type: 'number', min: '0', step: '0.5', value: t.points, oninput: bind(t, 'points', Number) })),
            field('Time limit (s)', h('input', { type: 'number', min: '1', max: '60', value: t.timeout, oninput: bind(t, 'timeout', Number) })),
            field('File to test', fileSelect(t)),
            h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: t.hidden, onchange: bind(t, 'hidden') }), h('span', null, 'Hidden test', h('span', { class: 'field-hint' }, 'Students see only pass/fail, not the name or details.')))
        );
        card.appendChild(grid);

        if (t.type === 'output') {
            card.append(
                field('Input (one line per input() call)', h('textarea', { rows: 2, class: 'mono', value: t.stdin, placeholder: 'e.g.\n5\n10', oninput: bind(t, 'stdin') })),
                field('Expected output', h('textarea', { rows: 4, class: 'mono', value: t.expected, placeholder: 'What the program should print (input prompts are not included)', oninput: bind(t, 'expected') }),
                    h('span', null, h('button', { class: 'link-btn', onclick: () => fillFromSolution(t), text: 'Fill from solution' }), ' — runs your solution with the input above.')),
                field('How to compare', (() => {
                    const s = h('select', { onchange: bind(t, 'match') },
                        h('option', { value: 'normalized' }, 'Same output (ignore trailing spaces / blank lines) — recommended'),
                        h('option', { value: 'contains' }, 'Output contains the expected text'),
                        h('option', { value: 'exact' }, 'Exactly identical (strict)'),
                        h('option', { value: 'regex' }, 'Matches a regular expression'));
                    s.value = t.match; return s;
                })())
            );
        } else if (t.type === 'function') {
            card.append(
                field('Call', h('input', { class: 'mono', value: t.call, placeholder: 'e.g. add(2, 3)', oninput: bind(t, 'call') }), 'Any Python expression using names from the student\'s file.'),
                field('Expected value', h('input', { class: 'mono', value: t.expected, placeholder: 'e.g. 5   or   [1, 2]   or   "hello"', oninput: bind(t, 'expected') }),
                    h('span', null, 'A Python literal. ', h('button', { class: 'link-btn', onclick: () => fillFromSolution(t), text: 'Fill from solution' }))),
                h('div', { class: 'test-grid' },
                    field('Float tolerance', h('input', { type: 'number', step: 'any', min: '0', value: t.tolerance ?? '', placeholder: 'exact', oninput: bind(t, 'tolerance', v => v === '' ? null : Number(v)) }), 'e.g. 0.01'),
                    field('Input during import', h('input', { class: 'mono', value: t.stdin, placeholder: '(optional)', oninput: bind(t, 'stdin') }), 'If the file calls input() at top level.'))
            );
        } else {
            card.append(
                field('Python check code', h('textarea', { rows: 7, class: 'mono', value: t.code, oninput: bind(t, 'code') }),
                    'Passes if no assertion fails. Available: module, source, run(stdin=""), and every name from the student\'s file.'),
                field('Input during import', h('input', { class: 'mono', value: t.stdin, placeholder: '(optional)', oninput: bind(t, 'stdin') }))
            );
        }
        return card;
    }

    function renderTestsTab(body) {
        const total = P().tests.reduce((s, t) => s + (Number(t.points) || 0), 0);
        body.append(
            h('div', { class: 'tab-intro' },
                h('div', null, h('strong', null, `${P().tests.length} test${P().tests.length === 1 ? '' : 's'} · ${total} point${total === 1 ? '' : 's'}`),
                    ' — students\' score = points earned ÷ total.'),
                h('div', { class: 'btn-row' },
                    h('button', { class: 'run-btn', onclick: () => runAll('solution'), title: 'Every test should pass on your solution', icon: 'play', text: 'Run all on solution' }),
                    h('button', { class: 'tool-btn', onclick: () => runAll('starter'), title: 'Checks the starter code does not already pass', icon: 'play', text: 'Run all on starter' })),
                h('div', { id: 'tests-run-status', class: 'hint' }, validationSummary())
            )
        );
        if (!P().tests.length) {
            body.appendChild(h('div', { class: 'empty-state' },
                h('p', null, 'No tests yet. Pick a test type to add one:'),
                h('ul', null,
                    h('li', null, h('strong', null, 'Output'), ' — run the program with given input and compare what it prints.'),
                    h('li', null, h('strong', null, 'Function'), ' — call a function and compare the value it returns.'),
                    h('li', null, h('strong', null, 'Custom code'), ' — write your own assert statements for anything else.'))));
        }
        P().tests.forEach((t, i) => body.appendChild(renderTestCard(t, i)));
        body.appendChild(h('div', { class: 'btn-row add-row' },
            h('button', { class: 'tool-btn', onclick: () => newTest('output'), icon: 'plus', text: 'Output test' }),
            h('button', { class: 'tool-btn', onclick: () => newTest('function'), icon: 'plus', text: 'Function test' }),
            h('button', { class: 'tool-btn', onclick: () => newTest('code'), icon: 'plus', text: 'Custom code test' })));
    }

    function validationSummary() {
        if (!P().tests.length) return '';
        const fresh = validation.solutionHash === gradingHash();
        let s = fresh ? (validation.solutionAllPass ? 'All tests pass on your solution.' : 'Some tests fail on your solution.') : 'Tests have not been run on the current version.';
        if (validation.starterPercent != null) s += ` Starter scores ${Math.round(validation.starterPercent)}%.`;
        return s;
    }

    // --- Settings -------------------------------------------------------------
    function renderSettingsTab(body) {
        const p = P();
        const entry = h('select', { onchange: (e) => { p.entry = e.target.value; changed({ quiet: true }); } },
            ...pyFiles().map(f => h('option', { value: f }, f)));
        entry.value = p.entry;
        const policy = h('select', { onchange: (e) => { p.gradePolicy = e.target.value; changed({ quiet: true }); } },
            h('option', { value: 'best' }, 'Highest score counts (recommended)'),
            h('option', { value: 'last' }, 'Most recent score counts'));
        policy.value = p.gradePolicy;
        body.append(
            field('Assignment title', h('input', { value: p.title, oninput: (e) => { p.title = e.target.value; document.getElementById('brand-title').innerText = p.title; changed({ quiet: true }); } }), 'Shown in the toolbar and as the D2L package title.'),
            field('Main file', entry, 'Run Code and tests use this file unless a test picks another.'),
            field('Passing score (%)', h('input', { type: 'number', min: '0', max: '100', value: p.passingScore, oninput: (e) => { p.passingScore = Number(e.target.value) || 0; changed({ quiet: true }); } }), '0 = D2L marks the activity "completed" once tests run. Above 0 = "passed"/"failed".'),
            field('Grade reporting', policy, 'Each time a student clicks Run Tests, the score is sent to D2L.'),
            h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: p.allowNewFiles, onchange: (e) => { p.allowNewFiles = e.target.checked; changed({ quiet: true }); } }), h('span', null, 'Students may create their own files and folders')),
            h('div', { class: 'settings-meta' }, `Package ID: ${p.id}`),
            h('div', { class: 'btn-row' }, h('button', { class: 'tool-btn', onclick: discardDraft, icon: 'reset', text: 'Reload assignment from folder' }))
        );
    }

    // --- Publish --------------------------------------------------------------
    function checklist() {
        const p = P();
        const items = [];
        const add = (level, text, action) => items.push({ level, text, action });
        add(p.title && p.title !== 'Python Assignment' && p.title !== 'Untitled Assignment' ? 'ok' : 'warn', 'Assignment has a title', () => { activeTab = 'settings'; renderPanel(); });
        add(p.instructions.trim() && p.instructions.trim() !== PLACEHOLDER_INSTRUCTIONS.trim() ? 'ok' : 'warn', 'Instructions are written', () => { activeTab = 'instructions'; renderPanel(); });
        add(p.files[p.entry] ? 'ok' : 'error', `Main file "${p.entry}" exists`, () => { activeTab = 'settings'; renderPanel(); });
        if (p.files[p.entry] && p.files[p.entry].role === 'hidden') add('error', `Main file "${p.entry}" is hidden from students`, null);
        const missing = p.tests.filter(t => t.file && !p.files[t.file]);
        if (missing.length) add('error', `${missing.length} test(s) point to a missing file`, () => { activeTab = 'tests'; renderPanel(); });
        const total = p.tests.reduce((s, t) => s + (Number(t.points) || 0), 0);
        add(p.tests.length && total > 0 ? 'ok' : 'warn', p.tests.length ? `${p.tests.length} tests worth ${total} points` : 'No automated tests (students can still run code; no grade is sent)', () => { activeTab = 'tests'; renderPanel(); });
        if (p.tests.length) {
            const fresh = validation.solutionHash === gradingHash();
            add(fresh && validation.solutionAllPass ? 'ok' : (fresh ? 'error' : 'warn'),
                fresh ? (validation.solutionAllPass ? 'All tests pass on your solution' : 'Some tests FAIL on your solution') : 'Run all tests on your solution to confirm they pass',
                () => runAll('solution'));
            if (validation.starterPercent != null && validation.starterPercent >= 100) add('warn', 'The starter code already scores 100%', () => runAll('starter'));
        }
        const hasSolution = Object.values(p.files).some(f => f.solution != null);
        if (p.tests.length && !hasSolution) add('warn', 'No solution files — tests can only be checked against the starter', () => setSolutionView(true));
        return items;
    }

    function renderPublishTab(body) {
        const items = checklist();
        const list = h('ul', { class: 'checklist' },
            ...items.map(it => h('li', { class: 'check-' + it.level },
                h('span', { class: 'check-icon', icon: it.level === 'ok' ? 'check' : it.level === 'warn' ? 'alert' : 'close' }),
                h('span', { class: 'check-text', text: it.text }),
                it.level !== 'ok' && it.action ? h('button', { class: 'link-btn', onclick: it.action, text: 'Fix' }) : null)));
        body.append(
            h('h3', { class: 'ipanel-h' }, 'Ready to publish?'),
            list,
            h('div', { class: 'btn-row' },
                h('button', { class: 'export-btn big', onclick: exportForD2L, icon: 'box', text: 'Export for D2L (.zip)' }),
                h('button', { class: 'tool-btn', onclick: () => App.setMode('preview'), icon: 'eye', text: 'Preview as student' })),
            h('h3', { class: 'ipanel-h' }, 'Upload to D2L'),
            h('ol', { class: 'steps' },
                h('li', null, 'In ', h('strong', null, 'Content'), ', upload the exported .zip as a SCORM package (newer D2L: ', h('strong', null, 'SCORM/xAPI object'), ').'),
                h('li', null, 'Package options: ', h('strong', null, 'Open player in new window'), ', ', h('strong', null, 'Use built in navigation'), ', ', h('strong', null, 'Add review/retake'), '.'),
                h('li', null, 'Course options: grade item ', h('strong', null, 'Yes'), ' with ', h('strong', null, P().gradePolicy === 'last' ? 'Last Attempt' : 'Highest Attempt'), ', ', h('strong', null, 'Always display the latest version'), ', open in ', h('strong', null, 'new window'), '.'),
                h('li', null, 'Check it with a test student account. D2L\'s "View as Student" runs the activity but does not save grades.')),
            h('h3', { class: 'ipanel-h' }, 'What students get'),
            h('ul', { class: 'steps' },
                h('li', null, 'Starter (S) and read-only (R) files, the instructions, and the tests in an encoded file.'),
                h('li', null, 'Not included: solution versions, Instructor Mode, and plain-text tests.'),
                h('li', null, 'Students\' work auto-saves in their browser. Hidden (H) files exist only while tests run.')),
            h('p', { class: 'hint' }, 'Tip: use Menu (top left) → Save Project to keep an editable copy (with solutions) for next semester.')
        );
    }

    function manifestXML(title, files) {
        const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const id = 'PYWS_' + P().id.replace(/[^A-Za-z0-9_]/g, '');
        return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${id}" version="1.2"
          xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
          xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd
                              http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="${id}_org">
    <organization identifier="${id}_org">
      <title>${esc(title)}</title>
      <item identifier="${id}_item" identifierref="${id}_res">
        <title>${esc(title)}</title>
${P().passingScore ? `        <adlcp:masteryscore>${Math.round(P().passingScore)}</adlcp:masteryscore>\n` : ''}      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="${id}_res" type="webcontent" adlcp:scormtype="sco" href="index.html">
${files.map(f => `      <file href="${esc(f)}"/>`).join('\n')}
    </resource>
  </resources>
</manifest>
`;
    }

    async function exportForD2L() {
        const p = P();
        const errors = checklist().filter(i => i.level === 'error');
        if (errors.length && !confirm('There are problems:\n\n• ' + errors.map(e => e.text).join('\n• ') + '\n\nExport anyway?')) return;
        if (p.id === SAMPLE_ID) { p.id = App.uid(); changed({ quiet: true }); }
        const zip = new JSZip();
        for (const f of App.CORE_FILES) {
            const text = await App.fetchText(f);
            if (text == null) { App.toast(`Could not read ${f} — export cancelled.`, 'error'); return; }
            zip.file(f, f === 'index.html' ? text.replace('<body data-mode="student">', '<body data-mode="student" data-package="1">') : text);
        }
        const files = {};
        for (const [path, f] of Object.entries(p.files)) files[path] = { role: f.role, content: f.content, binary: f.binary };
        const pkg = {
            version: 1, id: p.id, title: p.title, entry: p.entry, passingScore: p.passingScore,
            gradePolicy: p.gradePolicy, allowNewFiles: p.allowNewFiles, instructions: p.instructions,
            tests: p.tests, files, exportedAt: new Date().toISOString()
        };
        zip.file('assignment.dat', App.encodePackage(pkg));
        zip.file('imsmanifest.xml', manifestXML(p.title, ['imsmanifest.xml', ...App.CORE_FILES, 'assignment.dat']));
        const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
        App.triggerDownload(blob, `${slug(p.title)}_SCORM.zip`);
        App.toast('Exported. Upload the .zip to D2L as a SCORM package.', 'ok');
    }

    // ---------------------------------------------------------------- project files
    async function saveProject() {
        const p = P();
        const zip = new JSZip();
        const root = zip.folder('assignment');
        const def = {
            version: 1, id: p.id, title: p.title, entry: p.entry, passingScore: p.passingScore,
            gradePolicy: p.gradePolicy, allowNewFiles: p.allowNewFiles,
            files: Object.entries(p.files).sort().map(([path, f]) => ({ path, role: f.role, solution: f.solution != null, ...(f.binary ? { binary: true } : {}) })),
            tests: p.tests
        };
        root.file('assignment.json', JSON.stringify(def, null, 2));
        root.file('instructions.md', p.instructions);
        for (const [path, f] of Object.entries(p.files)) {
            root.file('files/' + path, f.content, f.binary ? { base64: true } : {});
            if (f.solution != null) root.file('solution/' + path, f.solution, f.binary ? { base64: true } : {});
        }
        App.triggerDownload(await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }), `${slug(p.title)}_project.zip`);
        App.toast('Project saved. To make it this folder\'s default, replace the "assignment" folder with the one in the zip.', 'ok');
    }

    async function openProjectFile(file) {
        try {
            const zip = await JSZip.loadAsync(file);
            let project = null;
            const dat = zip.file('assignment.dat') || zip.file(/(^|\/)assignment\.dat$/)[0];
            if (dat) {
                project = App.decodePackage(await dat.async('string'));
                App.toast('Opened a D2L package. Solutions are never included in packages — add them again in Solution view.', 'warn');
            } else {
                const jsonFile = zip.file(/(^|\/)assignment\.json$/)[0];
                if (!jsonFile) throw new Error('No assignment.json or assignment.dat found in this zip.');
                const base = jsonFile.name.replace(/assignment\.json$/, '');
                const def = JSON.parse(await jsonFile.async('string'));
                const mdFile = zip.file(base + 'instructions.md');
                project = Object.assign({}, def, { files: {} });
                project.instructions = mdFile ? await mdFile.async('string') : '';
                for (const f of def.files || []) {
                    const binary = !!f.binary || App.BINARY_EXT.test(f.path);
                    const type = binary ? 'base64' : 'string';
                    const c = zip.file(base + 'files/' + f.path);
                    const s = f.solution ? zip.file(base + 'solution/' + f.path) : null;
                    project.files[f.path] = { role: f.role, binary, content: c ? await c.async(type) : '', solution: s ? await s.async(type) : null };
                }
            }
            App.project = project;
            testStatus = {};
            validation = { solutionHash: null, solutionAllPass: false, starterPercent: null };
            App.solutionView = false;
            App.setMode('instructor');
            changed();
            App.toast(`Opened "${P().title}".`, 'ok');
        } catch (e) {
            App.toast('Could not open file: ' + e.message, 'error');
        }
    }

    function newAssignment() {
        if (!confirm('Start a new, empty assignment? Save your current project first if you want to keep it.')) return;
        App.project = {
            id: App.uid(), title: 'Untitled Assignment', entry: 'main.py', instructions: PLACEHOLDER_INSTRUCTIONS,
            files: { 'main.py': { role: 'starter', content: '# Write your code here\n', solution: null } },
            tests: []
        };
        testStatus = {};
        validation = { solutionHash: null, solutionAllPass: false, starterPercent: null };
        App.solutionView = false;
        activeTab = 'instructions';
        App.setMode('instructor');
        changed();
    }
})();
