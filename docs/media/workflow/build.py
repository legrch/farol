"""Build synthetic workflow diagrams locally, without service calls."""
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parent
for name in ('captures','output'):
    (ROOT/name).mkdir(exist_ok=True)
for name in ('build_scenes.py','render.py','assemble.py'):
    subprocess.run([sys.executable,str(ROOT/'source'/name)],cwd=ROOT,check=True)
subprocess.run([sys.executable,str(ROOT/'verify.py')],cwd=ROOT,check=True)
