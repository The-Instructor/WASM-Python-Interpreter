# Instructor Guide — Python Lab Workspace

Use this template to build a Python assignment, test it the way students will see it, and export a SCORM package that D2L grades automatically.

## 1. Get and open the workspace
Download the latest template:
**[Python_LMS_Workspace_SCORM.zip](https://github.com/The-Instructor/WASM-Python-Interpreter/releases/download/template-latest/Python_LMS_Workspace_SCORM.zip)**. Unzip it anywhere. Don't use GitHub's **Code → Download ZIP** button: it wraps the files in extra folders.

The workspace has to run from a small local web server, not by double-clicking `index.html`.

* **Mac:** double-click `Start-Instructor-Workspace-Mac.command`. The first time, macOS may block it: right-click the file, choose **Open**, then confirm.
* **Windows:** double-click `Start-Instructor-Workspace-Windows.bat`. Python 3 must be installed.

Your browser opens at `http://localhost:8765`. Keep the terminal window open while you work.

The template opens in **Instructor** mode with a sample lab (Temperature Converter). Explore it first, then choose **Project → New assignment** to start your own.

The workspace follows your computer's light or dark setting. Use the theme button (sun/moon) in the toolbar to pick **System**, **Light** or **Dark**.

## 2. Build the assignment
| Where | What you do |
|---|---|
| **📝 Instructions** tab | Write the student instructions in Markdown. Click **Preview** to see the formatted version. |
| **File tree** | Add files with **+ File** or **⬆ Upload files** (drag and drop also works). Click a file's badge to set who can see it (see below). |
| **Starter code / ★ Solution** toggle (above the editor) | **Starter code** is what students begin with. **★ Solution** is your answer key, which is used only to check your tests and is never exported. |
| **✓ Tests** tab | Add automated tests (see below). |
| **⚙ Settings** tab | Set the title, main file, passing score, and whether the best or the latest score counts. |

**File badges**

| Badge | Meaning |
|---|---|
| **S** starter | Students can see and edit the file. |
| **R** read-only | Students can see the file but can't edit it. It is reset before every test, for example a data file. |
| **H** hidden | Students never see the file. Tests can use it, for example hidden test data. |

## 3. Write tests
| Type | Use it for | You provide |
|---|---|---|
| **Output** | "Run the program and check what it prints" | The input lines (one per `input()` call) and the expected output. Click **⤓ Fill from solution** to capture the expected output automatically. |
| **Function** | "Call a function and check what it returns" | A call such as `add(2, 3)` and the expected value as a Python literal such as `5`, `[1, 2]` or `"hi"`. Set a float tolerance when comparing decimals. |
| **Custom code** | Anything else, such as requiring a loop or calling a function twice | Python `assert` statements. You can use `module`, `source`, `run(stdin)`, and any name defined in the student's file. |

**Test options**

* **Points:** a student's score is points earned ÷ total points, sent to D2L as a percentage.
* **Hidden test:** students see only pass or fail, with no test name or details.
* **Time limit:** stops infinite loops. The default is 5 seconds.

Input prompts are **not** part of the expected output. If `input("Name? ")` reads `Ada` and the program prints `Hi Ada`, the expected output is just `Hi Ada`.

**Before publishing,** click **▶ Run all on solution**. Every test should pass. Then click **▶ Run all on starter** to confirm the starter code doesn't already earn full marks.

## 4. Preview as a student
Click **Student preview** (the eye) in the toolbar. You see exactly what students get: starter files, read-only locks, the instructions, and test results with hidden tests masked. Nothing is sent to D2L in preview. Click **Instructor** (the pencil) to go back.

## 5. Publish to D2L
1. Open the **📦 Publish** tab and resolve anything flagged on the checklist.
2. Click **📦 Export for D2L (.zip)**.
3. In D2L **Content**, add the .zip as a SCORM package, turn on grade reporting, and link it to a grade item. Scores are reported out of 100.
4. Check the activity with a test student account. D2L's **View as Student** runs the activity but does not save grades.

**What students get:**

* Starter and read-only files, the instructions, and the tests stored in an encoded file.
* **Not included:** your solutions, Instructor Mode, hidden files as visible files, and readable test files.

**What students can do:**

* Run code with interactive `input()`.
* Use the **terminal** like a small Linux command line: `ls -l`, `cd`, `pwd`, `cat`, `grep`, `head`, `tail`, `wc`, `find`, `tree`, `which`, `mkdir`, `touch`, `cp`, `mv`, `rm`, `chmod`, pipes (`|`) and redirects (`>`), plus `python file.py`. Type `help` for the list. Read-only (R) files can't be changed, assignment files can't be deleted, and hidden (H) files don't exist for students. Files their programs create appear in the file tree (if you allow new files in Settings).
* Run the tests as many times as they like. Each run sends the score to D2L, and by default the best score counts.
* Reset a file to its starter code.
* Download their work.
* Their work saves automatically in their browser.

## 6. Save your work
* Your work **autosaves in this browser** as you go.
* **Project → Save Project** downloads a .zip of the full project, including solutions. Keep it for next semester.
* **Project → Open…** loads a saved project, or an exported D2L package. Packages contain no solutions.
* To make a project the template's default, replace the `assignment` folder with the one inside the project .zip.

## About test security
Tests run inside the student's browser. That rules out the casual ways of tampering:

* Tests are encoded rather than stored as plain files.
* Tests never appear in the file tree.
* Protected files are locked and restored before every test.
* Each grading run uses a fresh Python instance with access to the browser blocked.

However, no in-browser grading can stop a determined student with developer tools from faking a score sent to D2L. For high-stakes work, also have students submit their downloaded .zip to a D2L Assignment folder, and spot-check their code.
