#!/bin/bash
# Double-click to open the Instructor Workspace in your browser.
# (First time: right-click > Open if macOS warns about an unidentified developer.)
cd "$(dirname "$0")" || exit 1
PORT=8765
echo "Python Lab Workspace running at http://localhost:$PORT"
echo "Keep this window open while you work. Close it (or press Ctrl+C) to stop."
(sleep 1; open "http://localhost:$PORT/index.html") &
python3 -m http.server "$PORT" --bind 127.0.0.1
