# Python Lab Workspace for D2L

Build, test and auto-grade Python assignments that run in the browser and report scores to D2L Brightspace (SCORM 1.2).

## Download

**[⬇ Download Python_LMS_Workspace_SCORM.zip](https://github.com/The-Instructor/WASM-Python-Interpreter/releases/download/template-latest/Python_LMS_Workspace_SCORM.zip)**

This link always serves the latest template. Unzip it and follow `INSTRUCTOR_GUIDE.md` inside. Don't use GitHub's green **Code → Download ZIP** button: that zip wraps everything in extra folders, so D2L can't find `imsmanifest.xml`.

## Repository layout
| Path | What |
|---|---|
| `Python_LMS_Workspace_SCORM/` | The template (what the download contains) |
| `dev/build_release.py` | Builds the download zip locally: `python3 dev/build_release.py` → `dist/` |
| `dev/e2e/` | End-to-end tests (developer only) |
| `.github/workflows/release-zip.yml` | Rebuilds the download on every push to `main` |
