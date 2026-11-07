"""Create the matched light comparison page from the dark README preview."""
from pathlib import Path
ROOT=Path(__file__).resolve().parent
REPO=ROOT.parents[2]
s=(REPO/'README.md').read_text().split('\n\n',1)[1]
for story in ('ask-your-files','change-your-code','install'):
 s=s.replace(f'docs/media/dark/output/Farol-{story}-dark.gif',f'docs/media/dark/output/Farol-{story}-light.gif')
s=s.replace('docs/media/dark/output/Farol-0','docs/media/onboarding/output/Farol-0').replace('-dark.gif','-light.gif')
s=s.replace('](docs/','](../../../docs/').replace('src="resources/','src="../../../resources/')
s='> **Light illustration preview** · [Switch to the dark preview](../../../README.md). The stories use the same timing and drawing code in both palettes.\n\n'+s
(ROOT/'light-preview.md').write_text(s)
