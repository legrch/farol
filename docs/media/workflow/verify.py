"""Decode every frame, check provenance files, hashes, dimensions and light theme."""
from pathlib import Path
import hashlib
import json
import re
from PIL import Image,ImageChops,ImageStat
from fontTools.ttLib import TTFont

ROOT=Path(__file__).resolve().parent
manifest=json.loads((ROOT/'validation.json').read_text())
assert len(manifest['artifacts'])==2
assert all(x['pages']==1 and not x['text_overflow'] for x in json.loads((ROOT/'layout-checks.json').read_text()))
checks=[]
for entry in manifest['artifacts']:
    path=ROOT/'output'/entry['file']
    assert hashlib.sha256(path.read_bytes()).hexdigest()==entry['sha256']
    image=Image.open(path);assert image.size==(1320,740) and image.info['loop']==0
    first=image.convert('RGB');duration=0;min_luma=255
    for i in range(image.n_frames):
        image.seek(i);image.load();rgb=image.convert('RGB')
        assert min(rgb.getpixel((10,370)))>=230
        luma=ImageStat.Stat(rgb.convert('L')).mean[0];min_luma=min(min_luma,luma)
        assert luma>200
        duration+=image.info['duration']
    assert not ImageChops.difference(first,rgb).getbbox(), 'Loop endpoints differ'
    assert duration==entry['duration_ms']==15000
    assert Image.open(path.with_suffix('.png')).size==(1320,740)
    checks.append({'file':path.name,'all_frames_decoded':image.n_frames,'duration_ms':duration,'minimum_mean_luminance':round(min_luma,2),'identical_loop_endpoints':True})
assert (ROOT/'licenses/Liberation-Sans-OFL.txt').is_file()
fonts=[]
for path in (ROOT/'source').glob('*.ttf'):
    with TTFont(path) as font:
        names={r.nameID:r.toUnicode() for r in font['name'].names if r.nameID in (1,13)}
        assert names[1]=='Liberation Sans' and 'SIL Open Font License' in names[13]
        fonts.append({'file':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'license':'SIL OFL 1.1'})
assert len(fonts)==2
secret=re.compile(r'\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b')
for path in [*ROOT.glob('*.md'),*ROOT.glob('*.py'),*(ROOT/'source').glob('*.py'),*(ROOT/'source').glob('*.html'),*(ROOT/'source').glob('*.css')]:
    text=path.read_text()
    assert not secret.search(text),path.name
    assert ('/workspace/'+'scratch/') not in text and ('/home/'+'agent/') not in text,path.name
def luminance(color):
    c=[int(color[n:n+2],16)/255 for n in (1,3,5)]
    return sum(v*w for v,w in zip([x/12.92 if x<=.04045 else ((x+.055)/1.055)**2.4 for x in c],(.2126,.7152,.0722)))
contrast=[]
for fg,bg in [('#29292f','#f6f5f9'),('#686274','#f6f5f9'),('#686274','#eeebf5'),('#2f7555','#ffffff'),('#6750b8','#eee8fa'),('#2f7555','#e8f3ec')]:
    low,high=sorted([luminance(fg),luminance(bg)]);ratio=(high+.05)/(low+.05)
    assert ratio>=4.5,(fg,bg,ratio)
    contrast.append({'foreground':fg,'background':bg,'ratio':round(ratio,2)})
(ROOT/'audit.json').write_text(json.dumps({'passed':True,'checks':checks,'fonts':fonts,'contrast_pairs':contrast,'scope':'Synthetic workflow assets only. Scoped text scan and contrast checks, not full accessibility/security audit; not runtime or installed acceptance.'},indent=2)+'\n')
print(json.dumps({'passed':True,'gifs':len(checks)}))
