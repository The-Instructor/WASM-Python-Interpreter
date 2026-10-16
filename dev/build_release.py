#!/usr/bin/env python3
"""Build the instructor download: dist/Python_LMS_Workspace_SCORM.zip

The zip holds the contents of Python_LMS_Workspace_SCORM/ at its root (imsmanifest.xml
is not inside a folder), so it can be uploaded to D2L as a SCORM/xAPI object as-is,
or unzipped and opened with the Start-Instructor-Workspace scripts.

Only git-tracked files are packaged. The build fails if the manifest lists a file
that is not in the zip.

Usage:  python3 dev/build_release.py [--out PATH]
"""
import argparse
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SRC = 'Python_LMS_Workspace_SCORM'
ZIP_NAME = 'Python_LMS_Workspace_SCORM.zip'
EXCLUDE = {'HANDOFF.md'}  # developer notes, not for instructors
EPOCH = (2020, 1, 1, 0, 0, 0)  # fixed timestamps -> identical zips for identical sources


def tracked_files():
    out = subprocess.run(['git', 'ls-files', '-s', '--', SRC], cwd=REPO, check=True,
                         capture_output=True, text=True).stdout
    for line in out.splitlines():
        meta, path = line.split('\t', 1)
        rel = path[len(SRC) + 1:]
        if rel not in EXCLUDE:
            yield rel, meta.split()[0] == '100755'


def manifest_files(xml_text):
    ns = {'cp': 'http://www.imsproject.org/xsd/imscp_rootv1p1p2'}
    root = ET.fromstring(xml_text)
    hrefs = [r.get('href') for r in root.iterfind('.//cp:resources/cp:resource', ns) if r.get('href')]
    hrefs += [f.get('href') for f in root.iterfind('.//cp:resources/cp:resource/cp:file', ns)]
    return hrefs


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', type=Path, default=REPO / 'dist' / ZIP_NAME)
    args = ap.parse_args()

    files = sorted(tracked_files())
    names = {rel for rel, _ in files}
    if 'imsmanifest.xml' not in names:
        sys.exit(f'error: {SRC}/imsmanifest.xml is not tracked')
    missing = [h for h in manifest_files((REPO / SRC / 'imsmanifest.xml').read_text('utf-8')) if h not in names]
    if missing:
        sys.exit('error: imsmanifest.xml lists files that are not in the package:\n  ' + '\n  '.join(missing))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.out, 'w', zipfile.ZIP_DEFLATED) as zf:
        for rel, executable in files:
            info = zipfile.ZipInfo(rel, EPOCH)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3  # unix, so the permission bits below are honored
            info.external_attr = (0o100755 if executable else 0o100644) << 16
            zf.writestr(info, (REPO / SRC / rel).read_bytes())
    print(f'Built {args.out.relative_to(REPO) if args.out.is_relative_to(REPO) else args.out} ({len(files)} files)')


if __name__ == '__main__':
    main()
