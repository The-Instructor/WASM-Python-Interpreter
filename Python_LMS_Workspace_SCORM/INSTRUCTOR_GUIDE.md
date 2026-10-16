# Instructor Guide — Python Lab Workspace

Build a Python assignment, check it the way students will see it, and export a package that D2L grades automatically.

## 1. Get the workspace
1. Download **[Python_LMS_Workspace_SCORM.zip](https://github.com/The-Instructor/WASM-Python-Interpreter/releases/download/template-latest/Python_LMS_Workspace_SCORM.zip)**. This link always gives the newest version.
2. Unzip it into any folder, for example `Documents/Python Workspace`.

Don't use GitHub's green **Code → Download ZIP** button. That zip puts the files inside extra folders.

## 2. Open it
Double-click the start file in the folder:

* **Mac:** `Start-Instructor-Workspace-Mac.command`. The first time, macOS may block it: right-click the file, choose **Open**, then **Open** again.
* **Windows:** `Start-Instructor-Workspace-Windows.bat`. Python 3 must be installed ([python.org](https://www.python.org/downloads/)).

**What this does:** it opens a small black window and your browser at `http://localhost:8765`. The window is a mini web server running only on your computer; nothing is uploaded. **Keep that window open while you work.** Close it when you're done.

Double-clicking `index.html` directly won't work; the browser blocks it.

The workspace opens in **Instructor** mode with a sample lab (Temperature Converter). Look around, then click the **menu button (☰, top left) → New assignment** to start your own.

**Light or dark:** the workspace follows your computer's setting. To change it, click the sun/moon button in the toolbar.

**More room:** each side panel has a hide button at the top. A slim bar stays at the edge; click its button to bring the panel back.

## 3. Build the assignment
| Where | What you do |
|---|---|
| **Instructions** tab (right) | Write what students should do. Click **Preview** to see it formatted. |
| **Files** panel (left) | Add files with the new-file icon or **Upload files** (or drag files onto the panel). |
| File badge **S / R / H** | Click it to set who can see the file (table below). |
| **Starter code / Solution** (above the editor) | *Starter code* is what students begin with. *Solution* is your answer key. It is used only to check your tests and is never given to students. |
| **Tests** tab | Add automated tests (section 4). |
| **Settings** tab | Title, main file, passing score, best or latest score, and whether students may create files. |

| Badge | Meaning |
|---|---|
| **S** starter | Students can see and edit it. |
| **R** read-only | Students can see it but not change it, for example a data file. |
| **H** hidden | Students never see it. Tests can use it, for example hidden test data. |

## 4. Write tests
| Type | Checks | You enter |
|---|---|---|
| **Output** | What the program prints | The typed input (one line per `input()`) and the expected output. **Fill from solution** fills in the expected output for you. |
| **Function** | What a function returns | A call like `add(2, 3)` and the answer like `5`, `[1, 2]` or `"hi"`. |
| **Custom code** | Anything else, such as "uses a loop" | Python `assert` lines. You can use `source` (the student's code as text), `run(stdin)` and the student's functions. |

* **Points:** score = points earned ÷ total points, sent to D2L as a percentage.
* **Hidden test:** students see only pass/fail, not the details.
* **Time limit:** stops endless loops (default 5 seconds).
* Don't include input prompts in the expected output. If `input("Name? ")` gets `Ada` and the program prints `Hi Ada`, expect just `Hi Ada`.

**Before publishing:** click **Run all on solution**; every test should pass. Then click **Run all on starter**; the starter code shouldn't already score 100%.

## 5. Preview as a student
Open the **Instructor** dropdown (top right) and choose **Student preview** to see exactly what students get. Nothing is sent to D2L. Choose **Instructor** to go back.

## 6. Publish to D2L
**Export the package**
1. Open the **Publish** tab in the right panel and fix anything the checklist flags.
2. Click **Export for D2L (.zip)**. This makes the *student* package.

**Upload it to D2L** (Content → upload as a SCORM package; newer D2L calls it a **SCORM/xAPI object**). Choose:

| D2L option | Choose | Why |
|---|---|---|
| Player | **Open player in new window** | The editor gets the full screen. |
| Navigation | **Use built in navigation** | It's a single activity; nothing to navigate. |
| Review/Retake | **Add review/retake** | Students can come back and improve their score. |

**Add it to your course** (pick the package from the list). Choose:

| D2L option | Choose | Why |
|---|---|---|
| Grade item | **Yes**, calculation **Highest Attempt** | Best try counts. Use **Last Attempt** if Settings says *latest score counts*. |
| Version control | **Always display the latest version** | Fixes you upload reach students automatically. |
| Open in | **New window** | Same as the player choice above. |

**Check it** with a test student account. D2L's *View as Student* runs the activity but doesn't save grades.

Only upload zips made with **Export for D2L**. The workspace download itself includes your solutions.

## 7. What students can do
* Run their code, including programs that ask for input.
* Run the tests as often as they like. Each run updates their D2L grade (best score counts by default).
* Use the **Terminal** like a small Linux command line, for example `ls`, `cd`, `cat`, `grep`, `mkdir`, `cp`, `mv`, `rm` and `python main.py`. Typing `help` lists everything. Read-only files can't be changed, assignment files can't be deleted, and hidden files don't exist for them.
* Reset a file to the starter code, and download their work.
* Their work saves automatically in their browser.

## 8. Save your work
* Your work autosaves in this browser as you go.
* **Menu (☰) → Save Project** downloads a .zip of everything, including solutions. Keep it, for example for next semester.
* **Menu (☰) → Open…** loads a saved project (or an exported D2L package, which has no solutions).

## 9. Update to a new version
1. Click **Menu (☰) → Save Project** to keep a copy of your current work.
2. Download the zip from section 1 again and unzip it into a **new** folder.
3. Open it with the start file (section 2), then use **Menu (☰) → Open…** to load your saved project.

Packages you already uploaded to D2L keep working. To give students the new version, export again and upload it as a new version of the same package; with **Always display the latest version**, students get it automatically.

## About test security
Tests run in the student's browser. They are encoded, never shown in the file tree, and run in a fresh Python each time, so casual tampering doesn't work. A determined student with browser developer tools could still fake a score. For high-stakes work, also collect their downloaded .zip in a D2L Assignment folder and spot-check it.
