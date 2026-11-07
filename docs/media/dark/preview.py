"""Create the matched light comparison page from the dark README preview."""
from pathlib import Path
ROOT=Path(__file__).resolve().parent
REPO=ROOT.parents[2]
s=(REPO/'README.md').read_text().split('\n\n',1)[1]
s=s.replace('-dark.gif','-light.gif')
s=s.replace('](docs/','](../../../docs/').replace('src="resources/','src="../../../resources/')
s='> **Light illustration preview** · [Switch to the dark preview](../../../README.md). Both themes use the same scenes and timing.\n\n'+s
(ROOT/'light-preview.md').write_text(s)
