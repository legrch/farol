# Asset and build-tool notices

## Bundled font assets

- `source/LiberationSans-Regular.ttf` and `source/LiberationSans-Bold.ttf`: Liberation Sans, unmodified. Copyright 2010 Google Corporation; copyright 2012 Red Hat, Inc. Licensed under the SIL Open Font License, Version 1.1. Full notice: `licenses/Liberation-Sans-OFL.txt`.
- The CSS name `DemoSans` is only a local font-family alias. The fonts themselves have not been renamed or modified.

## Existing Farol material

- `source/farol-sunrise.png` comes from Farol's `resources/brand/sunrise-dock/farol-sunrise.png`.
- `source/shell.css` and `source/setup.css` are adapted from Farol's renderer. Generated scene markup follows Farol's setup labels and uses authored tutorial graphics.
- This contribution is intended for the same project. No license for the entire Farol repository is asserted or added here.

## Build-only tools, not bundled

The requirements file references tools installed separately by the builder. Their packages and binaries are not redistributed in this source archive.

- WeasyPrint: BSD-3-Clause.
- Beautiful Soup: MIT.
- Pillow: HPND / PIL license (see its distribution's license file).
- FontTools: MIT.
- pydyf and cssselect2: BSD-3-Clause.
- tinycss2: BSD-3-Clause.
- CFFI: MIT.
- Poppler (`pdftoppm`): GPL-2.0-or-later, invoked as a separate command-line program. It is not linked into or bundled with the scene source.

Use each installed tool's full distributed license as authoritative. The renderer uses Poppler rather than bundling a PDF-rendering Python library. No third-party package license is represented as a new license on Farol itself.

OpenAI, ChatGPT, Google, Apple, and Microsoft names shown in illustrative UI belong to their respective owners. The tutorial is not presented as endorsed by them.
