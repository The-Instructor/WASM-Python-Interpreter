const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
// Paths: T = scratch dir holding vendored libs (see README.md), REPO = repo root.
const T = process.env.E2E_DIR || '/home/claude/testenv';
const REPO = process.env.REPO_DIR || path.resolve(__dirname, '../..');
const BASE = 'http://127.0.0.1:8899';
const map = (url) => {
  const u = new URL(url);
  if (u.host === 'cdn.jsdelivr.net') {
    if (u.pathname.startsWith('/pyodide/v0.27.3/full/')) return path.join(T, 'pyodide', u.pathname.split('/full/')[1]);
    if (u.pathname.includes('marked')) return T + '/vendor/marked.min.js';
    if (u.pathname.includes('xterm') && u.pathname.endsWith('.js')) return T + '/vendor/xterm-stub.js';
    if (u.pathname.endsWith('.css')) return 'EMPTY_CSS';
  }
  if (u.host === 'cdnjs.cloudflare.com') {
    let p = u.pathname;
    if (p.includes('jszip')) return T + '/vendor/jszip.min.js';
    if (p.includes('github-markdown-css')) return 'EMPTY_CSS';
    const m = p.match(/codemirror\/5\.65\.16\/(.*)$/);
    if (m) {
      let rel = m[1].replace('.min.', '.');
      if (rel === 'codemirror.js') return T + '/vendor/codemirror.js';
      if (rel === 'codemirror.css') return T + '/cm/lib/codemirror.css';
      return T + '/cm/' + rel;
    }
  }
  return null;
};
const results = []; let failures = 0;
function check(name, cond, extra='') { results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); if (!cond) failures++; }

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1500, height: 900 } });
  await context.route(/cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/, async (route) => {
    const f = map(route.request().url());
    if (f === 'EMPTY_CSS') return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    if (f && fs.existsSync(f)) {
      const ct = f.endsWith('.wasm') ? 'application/wasm' : f.endsWith('.css') ? 'text/css' : f.endsWith('.json') ? 'application/json' : f.endsWith('.zip') ? 'application/zip' : 'application/javascript';
      return route.fulfill({ status: 200, contentType: ct, body: fs.readFileSync(f), headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    console.log('UNMAPPED', route.request().url());
    return route.fulfill({ status: 404, body: '' });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text() + ' ' + JSON.stringify(m.location())); });

  // ---------------- Instructor template ----------------
  await page.goto(BASE + '/template/index.html');
  await page.waitForFunction(() => document.getElementById('xterm-out')?.textContent.includes('[Python ready]'), null, { timeout: 60000 });
  check('Template boots in instructor mode', await page.evaluate(() => document.body.dataset.mode === 'instructor'));
  check('Instructor panel tabs rendered', await page.locator('.ipanel-tab').count() === 4);
  check('Role badges shown (3 files)', await page.locator('.role-badge:not(.role-legend .role-badge)').count() >= 3);
  check('Hidden file visible to instructor', await page.locator('.file-item[data-path="tests/hidden_readings.csv"]').count() === 1);
  await page.screenshot({ path: T + '/shot-instructor.png' });

  await page.click('.ipanel-tab[data-tab="tests"]');
  check('7 test cards', await page.locator('.test-card').count() === 7);
  await page.click('text=▶ Run all on solution');
  await page.waitForFunction(() => document.querySelectorAll('.chip.pass, .chip.fail').length >= 7, null, { timeout: 90000 });
  const solChips = await page.$$eval('.test-status', els => els.map(e => e.children[0].className + ' ' + e.children[0].innerText));
  check('All tests pass on solution', solChips.every(c => c.includes('pass')), JSON.stringify(solChips.filter(c => !c.includes('pass'))));
  const failMsgs = await page.$$eval('.test-error', els => els.map(e => e.innerText));
  if (failMsgs.length) console.log('solution failures:', failMsgs);
  await page.click('text=▶ Run all on starter');
  await page.waitForFunction(() => [...document.querySelectorAll('.test-status')].every(s => s.children[1] && !s.children[1].classList.contains('none')), null, { timeout: 90000 });
  const starterPass = await page.$$eval('.test-status', els => els.filter(e => e.children[1].classList.contains('pass')).length);
  check('Starter passes 0 tests', starterPass === 0, `starter passed ${starterPass}`);
  await page.screenshot({ path: T + '/shot-tests.png' });

  // Fill from solution on a new output test
  await page.click('text=+ Output test');
  const lastCard = page.locator('.test-card').last();
  await lastCard.locator('textarea').first().fill('0');
  await lastCard.locator('text=⤓ Fill from solution').click();
  await page.waitForFunction(() => { const c = [...document.querySelectorAll('.test-card')].pop(); return c && c.querySelectorAll('textarea')[1].value.includes('32.0'); }, null, { timeout: 60000 });
  check('Fill-from-solution captured expected output', true);
  // delete it again
  page.once('dialog', d => d.accept());
  await page.locator('.test-card').last().locator('.icon-btn.danger').click();

  // Publish tab checklist
  await page.click('.ipanel-tab[data-tab="publish"]');
  const checks = await page.$$eval('.checklist li', els => els.map(e => e.className + ':' + e.innerText));
  check('Checklist shows solution validated', checks.some(c => c.includes('check-ok') && c.includes('pass on your solution')), JSON.stringify(checks));
  await page.screenshot({ path: T + '/shot-publish.png' });

  // Student preview
  await page.click('#mode-switch button[data-mode="preview"]');
  check('Preview hides hidden file', await page.locator('.file-item[data-path="tests/hidden_readings.csv"]').count() === 0);
  check('Preview hides instructor panel', !(await page.locator('#instructor-panel').isVisible()));
  check('Preview shows solution? (should show starter)', !(await page.evaluate(() => window.App.virtualFiles['main.py'].includes('9 / 5'))));
  await page.click('#mode-switch button[data-mode="instructor"]');

  // Export
  await page.click('.ipanel-tab[data-tab="publish"]');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=📦 Export for D2L (.zip)')]);
  const zipPath = T + '/export.zip';
  await dl.saveAs(zipPath);
  check('Export filename', /sample-lab-temperature-converter_SCORM\.zip/.test(dl.suggestedFilename()), dl.suggestedFilename());
  execSync(`rm -rf ${T}/site/pkg && mkdir -p ${T}/site/pkg && cd ${T}/site/pkg && unzip -q ${zipPath}`);
  const pkgFiles = execSync(`cd ${T}/site/pkg && find . -type f | sort`).toString();
  check('Package has no instructor.js / solution / assignment folder', !/instructor\.js|solution|assignment\//.test(pkgFiles), pkgFiles.replace(/\n/g, ' '));
  const dat = fs.readFileSync(T + '/site/pkg/assignment.dat', 'utf8');
  check('assignment.dat is not plain text', !dat.includes('average_f') && dat.startsWith('PYWS1'));
  const mani = fs.readFileSync(T + '/site/pkg/imsmanifest.xml', 'utf8');
  check('Generated manifest lists assignment.dat', mani.includes('assignment.dat') && mani.includes('Sample Lab'));

  // Save Project -> Open round trip
  const [pdl] = await Promise.all([page.waitForEvent('download'), page.click('#instructor-actions .menu-trigger').then(() => page.click('#instructor-actions .menu-item:has-text("Save Project")'))]);
  const projZip = T + '/project.zip'; await pdl.saveAs(projZip);
  const projList = execSync(`unzip -l ${projZip}`).toString();
  check('Project zip has solution + json', projList.includes('assignment/solution/main.py') && projList.includes('assignment/assignment.json') && projList.includes('assignment/files/tests/hidden_readings.csv'));
  page.once('dialog', d => d.accept());
  await page.click('#instructor-actions .menu-trigger');
  await page.click('#instructor-actions .menu-item:has-text("New assignment")');
  check('New assignment resets', await page.evaluate(() => App.project.tests.length === 0 && App.project.title === 'Untitled Assignment'));
  await page.setInputFiles('#instructor-actions input[type=file]', projZip);
  await page.waitForFunction(() => App.project.title.startsWith('Sample Lab'), null, { timeout: 10000 });
  check('Open project restores tests + solution', await page.evaluate(() => App.project.tests.length === 7 && App.project.files['main.py'].solution.includes('9 / 5') && App.project.files['tests/hidden_readings.csv'].role === 'hidden'));
  // Re-open exported package in instructor mode
  await page.setInputFiles('#instructor-actions input[type=file]', T + '/export.zip');
  await page.waitForFunction(() => App.project.files['main.py'].solution == null, null, { timeout: 10000 }).catch(()=>{});
  check('Open exported package (no solutions) in instructor mode', await page.evaluate(() => App.project.tests.length === 7 && App.project.files['main.py'].solution == null));

  // ---------------- Student package inside mock D2L ----------------
  const sp = await context.newPage();
  sp.on('pageerror', e => errors.push('student: ' + e.message));
  await sp.goto(BASE + '/scorm_host.html');
  const fr = sp.frameLocator('#sco');
  const frame = sp.frame({ url: /\/pkg\/index\.html/ });
  await frame.waitForFunction(() => document.getElementById('xterm-out')?.textContent.includes('[Python ready]'), null, { timeout: 60000 });
  check('Student mode', await frame.evaluate(() => document.body.dataset.mode === 'student'));
  check('No instructor tools in package', await frame.evaluate(() => !window.Instructor && document.getElementById('mode-switch').hidden));
  check('Connected badge', (await frame.locator('#lms-badge').innerText()).includes('Connected to D2L'));
  check('SCORM initialized + incomplete', await sp.evaluate(() => scormLog[0][0] === 'init' && scormStore['cmi.core.lesson_status'] === 'incomplete'));
  check('Hidden file not in tree', await frame.locator('.file-item[data-path="tests/hidden_readings.csv"]').count() === 0);
  check('Readonly file shows lock', await frame.locator('.file-item[data-path="data/readings.csv"] .lock-icon').count() === 1);
  // Terminal shell: hidden files are absent, read-only files are protected
  await frame.evaluate(() => term._type('ls; ls tests; echo x > data/readings.csv; rm main.py\r'));
  await frame.waitForFunction(() => document.getElementById('xterm-out').textContent.includes("rm: cannot remove 'main.py'"), null, { timeout: 15000 })
    .then(() => true).catch(() => false);
  const shellOut = await frame.evaluate(() => document.getElementById('xterm-out').textContent);
  check('Shell hides hidden files', shellOut.includes("ls: cannot access 'tests'"));
  check('Shell protects read-only files', shellOut.includes('data/readings.csv: Permission denied'));
  check('Shell keeps assignment files', shellOut.includes("rm: cannot remove 'main.py'"));
  check('Instructions rendered', (await frame.locator('#instructions-content h1').innerText()).includes('Temperature'));
  check('Student cannot shadow hidden file', await frame.evaluate(() => { window.prompt = () => 'tests/hidden_readings.csv'; let msg=''; window.alert = (m) => msg = m; createNewFile(); return msg.includes('exists'); }));

  // readonly editor
  await frame.click('.file-item[data-path="data/readings.csv"]');
  check('Readonly file not editable', await frame.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getOption('readOnly') === true));
  await frame.click('.file-item[data-path="main.py"]');

  // Run tests on starter
  await frame.click('#test-btn');
  await frame.waitForSelector('.results-header', { timeout: 90000 });
  const starterScore = await frame.locator('.results-score').innerText();
  check('Starter scores 0%', starterScore === '0%', starterScore);
  check('Hidden test name masked', (await frame.locator('.result-row').nth(5).innerText()).includes('Hidden test 6'));
  check('Score sent to D2L (0)', await sp.evaluate(() => scormStore['cmi.core.score.raw'] === '0' && scormStore['cmi.core.lesson_status'] === 'completed'));

  // Write a solution that also tries to tamper
  const tamper = fs.readFileSync(REPO + '/Python_LMS_Workspace_SCORM/assignment/solution/main.py', 'utf8') +
    '\n# tamper attempts\ntry:\n    open("data/readings.csv","w").write("celsius\\n1000\\n")\nexcept OSError:\n    pass\ntry:\n    import js\n    js.postMessage("x")\nexcept ImportError:\n    pass\n';
  await frame.evaluate((code) => document.querySelector('.CodeMirror').CodeMirror.setValue(code), tamper);
  await frame.click('#test-btn');
  await frame.waitForFunction(() => document.querySelector('.results-score')?.innerText === '100%' || document.querySelector('#test-btn').innerText.includes('Run Tests'), null, { timeout: 90000 });
  await frame.waitForFunction(() => !document.querySelector('#test-btn').disabled, null, { timeout: 90000 });
  const solScore = await frame.locator('.results-score').innerText();
  const rowsTxt = await frame.$$eval('.result-row.fail', els => els.map(e => e.innerText));
  check('Solution (with tamper attempts) scores 100%, readonly restored each test', solScore === '100%', solScore + ' ' + JSON.stringify(rowsTxt));
  check('Score raw 100 + session data', await sp.evaluate(() => scormStore['cmi.core.score.raw'] === '100' && JSON.parse(scormStore['cmi.suspend_data']).best === 100));
  await sp.screenshot({ path: T + '/shot-student-results.png' });

  // best-score policy: break code, score shouldn't drop
  await frame.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.setValue('def c_to_f(c):\n    return 0\n'));
  await frame.click('#test-btn');
  await frame.waitForFunction(() => !document.querySelector('#test-btn').disabled && document.querySelector('.results-score')?.innerText !== '100%', null, { timeout: 90000 });
  check('Best-score policy keeps 100 in D2L', await sp.evaluate(() => scormStore['cmi.core.score.raw'] === '100'));

  // Infinite loop -> timeout
  await frame.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.setValue('def c_to_f(c):\n    while True:\n        pass\n'));
  await frame.click('#test-btn');
  await frame.waitForFunction(() => !document.querySelector('#test-btn').disabled && document.querySelector('.result-row'), null, { timeout: 120000 });
  const firstMsg = await frame.locator('.result-row').first().innerText();
  check('Infinite loop reported as time limit', firstMsg.includes('Time limit'), firstMsg.slice(0, 120));

  // Interactive Run Code with input
  await frame.evaluate((code) => document.querySelector('.CodeMirror').CodeMirror.setValue(code),
    'name = input("Name? ")\nage = int(input("Age? "))\nprint(f"Hi {name}, next year you are {age+1}")\n');
  await frame.click('#action-btn');
  await frame.waitForFunction(() => document.getElementById('xterm-out').textContent.endsWith('Name? '), null, { timeout: 30000 });
  await frame.evaluate(() => term._type('Ada\r'));
  await frame.waitForFunction(() => document.getElementById('xterm-out').textContent.endsWith('Age? '), null, { timeout: 30000 });
  await frame.evaluate(() => term._type('36\r'));
  await frame.waitForFunction(() => document.getElementById('xterm-out').textContent.includes('Hi Ada, next year you are 37'), null, { timeout: 30000 });
  const termText = await frame.evaluate(() => document.getElementById('xterm-out').textContent);
  const tail = termText.slice(termText.lastIndexOf('$ python3'));
  check('Interactive input works without duplicated output', (tail.match(/Name\? /g) || []).length === 1, JSON.stringify(tail));

  // Multi-file import picks up edits (no stale module cache)
  await frame.evaluate(() => { window.prompt = () => 'helper.py'; createNewFile(); document.querySelector('.CodeMirror').CodeMirror.setValue('X = 1\n'); });
  await frame.click('.file-item[data-path="main.py"]');
  await frame.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.setValue('import helper\nprint("helper", helper.X)\n'));
  await frame.click('#action-btn');
  await frame.waitForFunction(() => document.getElementById('xterm-out').textContent.includes('helper 1'), null, { timeout: 30000 });
  await frame.click('.file-item[data-path="helper.py"]');
  await frame.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.setValue('X = 2\n'));
  await frame.click('.file-item[data-path="main.py"]');
  await frame.click('#action-btn');
  await frame.waitForFunction(() => document.getElementById('xterm-out').textContent.includes('helper 2'), null, { timeout: 30000 }).then(() => check('Edited helper module reloads', true)).catch(() => check('Edited helper module reloads', false));

  // Error highlighting
  await frame.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.setValue('x = 1\ny = 1/0\n'));
  await frame.click('#action-btn');
  await frame.waitForFunction(() => document.querySelector('.cm-traceback-error'), null, { timeout: 30000 }).then(() => check('Traceback line highlighted', true)).catch(() => check('Traceback line highlighted', false));

  // Autosave + restore
  await frame.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.setValue('print("persisted")\n'));
  await sp.waitForTimeout(1200);
  await sp.reload();
  const frame2 = sp.frame({ url: /\/pkg\/index\.html/ });
  await frame2.waitForFunction(() => window.App && window.App.virtualFiles['main.py'] !== undefined, null, { timeout: 30000 });
  check('Student work restored after reload', await frame2.evaluate(() => App.virtualFiles['main.py'].includes('persisted') && !document.getElementById('banner').hidden));

  // Exit -> LMSFinish
  await frame2.click('#exit-btn');
  await frame2.click('#modal-exit-btn');
  await sp.waitForTimeout(500);
  check('LMSFinish called on exit', await sp.evaluate(() => scormLog.some(l => l[0] === 'finish') && scormStore['cmi.core.exit'] === 'suspend'));
  await sp.screenshot({ path: T + '/shot-student.png' });

  // Legacy (manifest-based) package still loads
  execSync(`rm -rf ${T}/site/legacy && mkdir -p ${T}/site/legacy && cp -r ${REPO}/Python_LMS_Workspace_SCORM/{index.html,css,js} ${T}/site/legacy/ && rm ${T}/site/legacy/js/instructor.js && cp ${__dirname}/legacy/instructions.md ${T}/site/legacy/ && sed 's#</resource>#<file href="solution.py"/></resource>#' ${__dirname}/legacy/imsmanifest.xml > ${T}/site/legacy/imsmanifest.xml && echo 'print("legacy ok")' > ${T}/site/legacy/solution.py`, { shell: '/bin/bash' });
  const lp = await context.newPage();
  lp.on('pageerror', e => errors.push('legacy: ' + e.message));
  await lp.goto(BASE + '/legacy/index.html');
  await lp.waitForFunction(() => document.getElementById('xterm-out')?.textContent.includes('[Python ready]'), null, { timeout: 60000 });
  console.log('LEGACY', await lp.evaluate(() => JSON.stringify([Object.keys(App.virtualFiles), document.querySelector('#instructions-content').innerText.slice(0,40), document.getElementById('test-btn').hidden])));
  check('Legacy package loads manifest file + instructions', await lp.evaluate(() => App.virtualFiles['solution.py'] !== undefined && document.querySelector('#instructions-content h1')?.innerText.includes('Lab Overview') && document.getElementById('test-btn').hidden));

  check('No page errors', errors.length === 0, errors.join(' | '));
  console.log(results.join('\n'));
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.log(results.join('\n')); console.error('CRASH', e); process.exit(2); });
