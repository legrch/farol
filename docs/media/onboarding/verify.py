#!/usr/bin/env python3
"""Scoped artifact, font-license, and publication-text checks."""
from pathlib import Path
import hashlib
import json
import re
from PIL import Image, ImageStat
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent
manifest = json.loads((ROOT / 'validation.json').read_text())
assert not manifest['layout_issues'], manifest['layout_issues']
assert len(manifest['artifacts']) == 8
report = {'passed': True, 'artifacts': [], 'fonts': [], 'text_files_checked': 0,
          'theme': 'light', 'contrast_pairs': [],
          'scope': 'Generated package only. Synthetic fixtures, frame decoding, dimensions, loop, target bounds, font metadata, and common private-data patterns. Not a full repository security or legal audit.'}
for entry in manifest['artifacts']:
    path = ROOT / 'output' / entry['file']
    assert entry['file'].endswith('-light.gif'), path.name
    assert hashlib.sha256(path.read_bytes()).hexdigest() == entry['sha256'], path
    im = Image.open(path)
    assert im.size == (1320, 900), (path, im.size)
    assert im.info.get('loop') == 0
    duration = 0
    minimum_mean_luminance = 255.0
    for i in range(im.n_frames):
        im.seek(i)
        im.load()
        rgb = im.convert('RGB')
        assert min(rgb.getpixel((10, 450))) >= 230, (path.name, i, 'non-light outer canvas')
        mean_luminance = ImageStat.Stat(rgb.convert('L')).mean[0]
        assert mean_luminance >= 200, (path.name, i, 'unexpected dark scene')
        minimum_mean_luminance = min(minimum_mean_luminance, mean_luminance)
        duration += im.info['duration']
    assert duration == entry['duration_ms'], (path, duration)
    for event in entry['timeline']:
        if event['target']:
            x, y = event['target_center']
            assert 40 <= x <= 1280 and 145 <= y <= 797, event
    poster = path.with_suffix('.png')
    assert Image.open(poster).size == (1320, 900)
    report['artifacts'].append({'file': path.name, 'frames': im.n_frames,
                                'duration_ms': duration, 'sha256': entry['sha256'],
                                'minimum_mean_luminance': round(minimum_mean_luminance, 2)})
permissions = Image.open(ROOT / 'output/Farol-plugin-permissions-light.png')
permissions.load()
assert permissions.size == (1320, 900)
fonts = list((ROOT / 'source').glob('*.ttf'))
assert {p.name for p in fonts} == {'LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf'}
for path in fonts:
    with TTFont(path) as font:
        names = {r.nameID: r.toUnicode() for r in font['name'].names if r.nameID in (1, 13)}
        assert names[1] == 'Liberation Sans' and 'SIL Open Font License' in names[13], names
        report['fonts'].append({'file': path.name, 'license': names[13],
                                'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
assert (ROOT / 'licenses/Liberation-Sans-OFL.txt').is_file()
secret_pattern = re.compile(r'\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b')
mail_pattern = re.compile(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}')
tunnel_pattern = re.compile(r'tunnel_[A-Za-z0-9]{12,}')
for path in [*ROOT.glob('*.md'), *ROOT.glob('*.py'), *ROOT.glob('*.txt'), *ROOT.joinpath('source').glob('*')]:
    if not path.is_file() or path.suffix not in ('.md', '.py', '.txt', '.css', '.html', '.json'):
        continue
    text = path.read_text()
    assert not secret_pattern.search(text), f'Credential-like value in {path.name}'
    assert all(m.endswith('@example.com') for m in mail_pattern.findall(text)), path.name
    assert all(m == 'tunnel_' + '0' * 31 + '1' for m in tunnel_pattern.findall(text)), path.name
    assert ('/workspace/' + 'scratch/') not in text and ('/home/' + 'agent/') not in text, path.name
    assert all(value == '00000000-0000-0000-0000-000000000001' for value in re.findall(r'\b[A-Za-z0-9]{8}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{12}\b', text)), path.name
    report['text_files_checked'] += 1
def luminance(hex_color):
    channels = [int(hex_color[i:i+2], 16) / 255 for i in (1, 3, 5)]
    linear = [v / 12.92 if v <= 0.04045 else ((v + .055) / 1.055) ** 2.4 for v in channels]
    return sum(a * b for a, b in zip(linear, (.2126, .7152, .0722)))
for label, foreground, background in [
    ('main caption', '#29292f', '#f6f5f9'),
    ('form text', '#263241', '#ffffff'),
    ('secondary form text', '#657080', '#ffffff'),
    ('small notes', '#686274', '#f6f5f9'),
    ('service primary button', '#ffffff', '#25262c'),
    ('Farol primary button', '#ffffff', '#6750b8'),
    ('Connect button', '#ffffff', '#0078c8'),
    ('risk warning', '#715123', '#fff6e8')]:
    a, b = sorted([luminance(foreground), luminance(background)])
    ratio = (b + .05) / (a + .05)
    assert ratio >= 4.5, (label, ratio)
    report['contrast_pairs'].append({'label': label, 'ratio': round(ratio, 2)})
(ROOT / 'audit.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'passed': True, 'gifs': len(report['artifacts']), 'fonts': len(report['fonts']), 'text_files_checked': report['text_files_checked']}))
