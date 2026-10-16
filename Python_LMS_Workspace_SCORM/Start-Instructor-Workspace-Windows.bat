@echo off
REM Double-click to open the Instructor Workspace in your browser.
cd /d "%~dp0"
set PORT=8765
echo Python Lab Workspace running at http://localhost:%PORT%
echo Keep this window open while you work. Close it to stop.
start "" "http://localhost:%PORT%/index.html"
python -m http.server %PORT% --bind 127.0.0.1 2>nul || py -m http.server %PORT% --bind 127.0.0.1
pause
