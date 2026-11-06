#!/usr/bin/env python3
"""Build the synthetic Farol tutorial locally. No service or network calls."""
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
if not shutil.which('pdftoppm'):
    raise SystemExit('Install Poppler (pdftoppm) before building; see README.md.')
for folder in ('captures', 'output'):
    (ROOT / folder).mkdir(exist_ok=True)
for script in ('build_remaining.py', 'render.py', 'assemble.py'):
    subprocess.run([sys.executable, str(ROOT / 'source' / script)], check=True, cwd=ROOT)
subprocess.run([sys.executable, str(ROOT / 'verify.py')], check=True, cwd=ROOT)
