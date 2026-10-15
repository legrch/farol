# Design records and asset provenance

The [current renderer contract](../desktop/renderer.md) describes present source
behavior and its acceptance limits. The [preview design record](../design.md)
retains the historical Watch Rail presentation with an explicit current-source
qualification. Design studies do not establish native, packaged or installed
product acceptance.

- [September lab directions](lab-directions-2026-09.md) and
  [product brief](lab-product-brief-2026-09.md) retain their original historical
  status; the prototypes and screenshots remain in `design-lab/`.
- [Font provenance](../reference/font-provenance.md) preserves upstream packages,
  integrity hashes, attribution and license scope. Font binaries and OFL texts
  stay beside their asset consumers.
- [Brand provenance](../reference/brand-assets.md) indexes
  [Signal / Color](../reference/brand-assets/signal-color.md),
  [Sunrise source](../reference/brand-assets/sunrise.md) and the
  [Sunrise Dock delivery pair](../reference/brand-assets/sunrise-dock.md).

## Frozen offline handoff exceptions

The [October desktop shell archive](../archive/desktop-shell-2026-10.md) indexes
the original 168-file offline package, documented as restored from
`920ab197fa74af10db8df1ce61c83940441fc773`. The ten Markdown files below remain
co-located because [MANIFEST.sha256](../../design-lab/desktop-shell-2026-10/MANIFEST.sha256)
binds their exact bytes and the self-contained package uses relative navigation.
Moving or rewriting them would invalidate that integrity ledger. The original
asset/font licenses also stay with their files. These are historical archive
records, with no duplicate current specification under `docs/`.

| Preserved file                                                                                                                             | Custody role                              |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| [design-lab/desktop-shell-2026-10/README.md](../../design-lab/desktop-shell-2026-10/README.md)                                             | Offline package entry and relative links. |
| [design-lab/desktop-shell-2026-10/DECISIONS.md](../../design-lab/desktop-shell-2026-10/DECISIONS.md)                                       | Dated approval and rejected alternatives. |
| [design-lab/desktop-shell-2026-10/HANDOFF.md](../../design-lab/desktop-shell-2026-10/HANDOFF.md)                                           | Original implementation handoff.          |
| [design-lab/desktop-shell-2026-10/design-notes.md](../../design-lab/desktop-shell-2026-10/design-notes.md)                                 | Revision 4 interaction record.            |
| [design-lab/desktop-shell-2026-10/design-notes-v1.md](../../design-lab/desktop-shell-2026-10/design-notes-v1.md)                           | Historical revision.                      |
| [design-lab/desktop-shell-2026-10/v2/design-notes.md](../../design-lab/desktop-shell-2026-10/v2/design-notes.md)                           | Historical revision.                      |
| [design-lab/desktop-shell-2026-10/v3/design-notes.md](../../design-lab/desktop-shell-2026-10/v3/design-notes.md)                           | Historical revision.                      |
| [design-lab/desktop-shell-2026-10/assets/PROVENANCE.md](../../design-lab/desktop-shell-2026-10/assets/PROVENANCE.md)                       | Bundled asset/font provenance.            |
| [design-lab/desktop-shell-2026-10/assets/dock-v4/README.md](../../design-lab/desktop-shell-2026-10/assets/dock-v4/README.md)               | Rejected comparison artwork.              |
| [design-lab/desktop-shell-2026-10/verification/original/README.md](../../design-lab/desktop-shell-2026-10/verification/original/README.md) | Original verification provenance warning. |

The placement checker permits exactly these files through its
[exception inventory](../tools/placement-exceptions.json), requires this canonical
index entry and refuses stale exceptions. New ordinary design documents belong
under `docs/`.

[Documentation layout](../development/documentation.md) · [Technical references](../reference/README.md)
