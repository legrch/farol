"""Build dark setup GIFs in disposable scratch; retain light outputs unchanged."""
from pathlib import Path
import os,shutil,subprocess,sys,tempfile,json,hashlib
ROOT=Path(__file__).resolve().parent
OUT=ROOT/'output';OUT.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='farol-dark-setup-') as scratch:
 media=Path(scratch)
 shutil.copytree(ROOT.parent/'onboarding',media/'onboarding',ignore=shutil.ignore_patterns('output','captures','.venv','__pycache__'))
 shutil.copytree(ROOT,media/'dark',ignore=shutil.ignore_patterns('output','__pycache__'))
 package=media/'onboarding'
 for folder in ['output','captures']:(package/folder).mkdir()
 for name in ['build_remaining.py','render.py','assemble.py']:
  subprocess.run([sys.executable,str(package/'source'/name)],cwd=package,env=dict(os.environ,FAROL_MEDIA_THEME='dark'),check=True)
 manifest=json.loads((package/'validation.json').read_text());entries=[]
 for entry in manifest['artifacts']:
  source=package/'output'/entry['file'];name=source.name.replace('-light.gif','-dark.gif');dest=OUT/name;shutil.copy2(source,dest)
  entry.update(file=name,sha256=hashlib.sha256(dest.read_bytes()).hexdigest(),bytes=dest.stat().st_size);entries.append(entry)
 (ROOT/'setup-validation.json').write_text(json.dumps({'theme':'dark','layout_issues':manifest['layout_issues'],'artifacts':entries},indent=2)+'\n')
