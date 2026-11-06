"""Synthetic workflow diagrams, using the onboarding HTML/CSS rendering stack."""
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parent
SCENES = []
for kind in ('read', 'edit'):
    edit = kind == 'edit'
    title = 'Understand files. Make requested changes.' if edit else 'ChatGPT, connected to your folders.'
    subtitle = 'File edits require an existing Read & write grant.' if edit else 'Start with one selected folder and Read only access.'
    stages = ['Ask for a specific change', 'Check the selected access', 'Read and apply the requested edit', 'See what changed'] if edit else ['Choose a folder', 'Ask in ChatGPT', 'Read approved files', 'Get a grounded answer']
    for stage in range(4):
        name = f'{kind}-{stage}'
        chat = ('<div class="response">✓ File updated<small>greeting.ts · Your requested change is saved.</small></div>' if edit else '<div class="response">✓ Project summary<small>Based on your selected files.</small></div>') if stage == 3 else ('<div class="bubble">Fix the typo in greeting.ts.</div>' if edit else '<div class="bubble">Explain this project.</div>') + '<div class="ghost"></div><div class="ghost second"></div>'
        file = '<div class="file">greeting.ts<div class="code' + (' done' if stage >= 2 else '') + '">return &quot;' + ('Hello' if stage >= 2 else 'Helo') + '&quot;;</div></div>' if edit else '<div class="file">README.md<small>src/ &nbsp; · &nbsp; docs/</small></div>'
        html = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="workflow.css"></head><body>
<div class="brand"><img src="farol-sunrise.png" alt="">Farol</div><div class="tag">{'READ + EDIT' if edit else 'HOW IT WORKS'}</div>
<h1>{title}</h1><div class="subtitle">{subtitle}</div>
<div class="mac"></div><div class="mac-label">ON YOUR MAC</div>
<div class="link a"></div><div class="link b"></div><div class="link-label a">OpenAI Tunnel</div><div class="link-label b">Access check</div>
<div class="chat"><div class="chat-title">ChatGPT</div>{chat}</div>
<div class="bridge"><img src="farol-sunrise.png" alt=""><strong>Farol</strong><span>Local bridge</span></div>
<div class="folder"><div class="folder-title"><span>▱</span>my-project</div><div class="selected">Selected folder</div><div class="access">{'Read &amp; write' if edit else 'Read only'}</div>{file}</div>
<div class="scope">Other folders are not shared</div>
<div class="stage"><b>0{stage+1}</b>{stages[stage]}</div><div class="dots">{''.join('<i'+(' class="active"' if n==stage else '')+'></i>' for n in range(4))}</div>
<div class="footer">Illustrative workflow · Requested file contents and results can be returned to ChatGPT.</div>
</body></html>'''
        (ROOT / f'{name}.html').write_text(html)
        SCENES.append(name)
(ROOT / 'scenes.json').write_text(json.dumps(SCENES, indent=2) + '\n')
