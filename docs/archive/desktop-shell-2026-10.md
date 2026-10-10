# October 2026 desktop shell archive

This is a **nonshipping historical design reference**. The complete 168-file
[desktop shell handoff](../../design-lab/desktop-shell-2026-10/README.md) is
restored byte-for-byte from commit
`920ab197fa74af10db8df1ce61c83940441fc773` (preserved branch
`desktop-shell-design-handoff`). The archive itself is unchanged, including its
dated decisions, manifest, prototype, screenshots, fonts and verification files.

Start with the archived [decision](../../design-lab/desktop-shell-2026-10/DECISIONS.md),
[handoff](../../design-lab/desktop-shell-2026-10/HANDOFF.md) and
[interactive entry](../../design-lab/desktop-shell-2026-10/start.html). Their
October 2 UI approval and Dock-pending statements describe that historical
snapshot; they do not replace current implementation or asset authority.

Current shipping Dock assets are the exact **Sunrise delivery pair**, governed by
[its resource notes](../../resources/brand/sunrise-dock/README.md) and the pinned
[brand contract](../../tooling/brand-contract.mjs). Restoring this archive does
not change those assets, source mappings, bundle identities or package inputs.
Iris Glass, Prism and Aurora Enamel in `assets/dock-v4/` remain explicitly rejected
comparison studies and must not ship. Signal Color is also a retained historical
asset set, not the current Dock mapping.

The prototype uses synthetic state. Its `verify.mjs`, inspection reports and
screenshots document DOM reference behavior, not current React implementation,
native focus or compositor routing, real folder permissions, safe interruption,
provider execution, packaged/installed acceptance or release approval. In
particular, mock update interruption is not an implemented release command.
Preserve useful acceptance questions without transplanting fixture success,
`app.js`, historical geometry or the old shell into production.

The current source and migration limits remain owned by
[the renderer contract](../desktop/renderer.md),
[Desktop Core](../desktop-core.md) and repository instructions. The bounded entry
port in `tests/e2e/react-shell.e2e.mjs` retains its Chromium composition and
same-WebContents close/reopen checks; syntax checking that file is not execution
or acceptance of those journeys. The separate current native harness and
lifecycle qualification remain independent work.
