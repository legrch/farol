"""Same local HTML → WeasyPrint → Poppler pipeline as onboarding."""
from pathlib import Path
import json
import subprocess
import tempfile
from weasyprint import HTML

ROOT = Path(__file__).resolve().parent
checks = []
for name in json.loads((ROOT / 'scenes.json').read_text()):
    doc = HTML(filename=str(ROOT / f'{name}.html')).render()
    assert len(doc.pages) == 1, (name, len(doc.pages))
    page = doc.pages[0]
    overflow = []
    for box in page._page_box.descendants():
        if type(box).__name__ == 'TextBox':
            if box.position_x < 0 or box.position_y < 0 or box.position_x + box.width > 1320 or box.position_y + box.height > 740:
                overflow.append(box.text)
    assert not overflow, (name, overflow)
    with tempfile.TemporaryDirectory() as tmp:
        pdf = Path(tmp) / 'scene.pdf'
        doc.write_pdf(str(pdf))
        subprocess.run(['pdftoppm', '-r', '96', '-f', '1', '-singlefile', '-png', str(pdf), str(ROOT.parent / 'captures' / name)], check=True)
    checks.append({'scene': name, 'pages': 1, 'text_overflow': overflow})
    print(name, flush=True)
(ROOT.parent / 'layout-checks.json').write_text(json.dumps(checks, indent=2) + '\n')
