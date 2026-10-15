# Documentation audit and verification

Refreshed **15 October 2026** by the existing Lead. Runtime source snapshot: `5dc8fbbc940c17f30f2b3364d7e5e119252c648e`. This documentation-only refresh reconciles the accepted earlier guides with completed internal delivery and current distribution evidence. It performs no new app launch, installation, update, signing or binary publication. Exact build identities belong in [current status](status.md), while README and the installation guide use the latest-release link without fixed app versions.

## Integration of the existing documentation branch

The preserved branch `docs/github-guide` at `1b2643cf` supplied the Start / Guides / Development navigation, first-workspace exercise, symptom-based troubleshooting and offline checker foundations. Its historical base and published beta1 instructions are obsolete for this source. The accepted documentation integration recorded that branch as a merge parent and manually reconciled the selected material with its source baseline; it does not restore the branch's old architecture rewrites, release assumptions or installer recipe.

The previous current README and docs index are retained as [historical README](readme-history-2026-10-09.md) and [acceptance history](acceptance-history.md), with relative links rebased. Original files are still recoverable from the pinned source and Git history. The [frozen archive](../archive/distribution-20261010/README.md) remains unchanged.

## Source and external checks

| Documentation claim                                               | Owning evidence inspected                                                                                                                                                                                                                        | Limit                                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Public v0.2.3, assets and release status                          | GitHub API `repos/legrch/farol/releases/latest` and published release list; [public release](https://github.com/legrch/farol/releases/tag/v0.2.3).                                                                                               | Fresh metadata agrees with the previously assessed downloaded ZIP; no public app launch or first install. |
| Source version/build                                              | [package.json](../../package.json): `0.2.7`, build `36`, `github-stable`.                                                                                                                                                                        | Source metadata, not a public or installed release.                                                       |
| Setup order and passive navigation                                | [setup-checklist.ts](../../src/ui/renderer/setup-checklist.ts), [setup.tsx](../../src/ui/renderer/setup.tsx), [setup-navigation.ts](../../src/ui/renderer/setup-navigation.ts).                                                                  | Source inspection; older builds may differ.                                                               |
| Add-workspace default, access, save/cancel/remove and diagnostics | [settings.tsx](../../src/ui/renderer/settings.tsx) (including `continueWorkspaceSetup`) and [setup semantics](../setup-connection.md).                                                                                                           | Source-backed; not a fresh native picker or filesystem journey.                                           |
| Tunnel and ChatGPT destinations                                   | [setup-media.json](../../resources/setup-media.json), [setup links](../setup-links.md), current Connection and embedded-check source.                                                                                                            | External pages require account access; live ChatGPT entitlement/UI was not exercised.                     |
| Update menu, labels, preference and recovery                      | [menu-bar.ts](../../src/apps/desktop/menu-bar.ts), [shell.tsx](../../src/ui/renderer/shell.tsx), [automatic-update-choice.tsx](../../src/ui/renderer/automatic-update-choice.tsx), [installed updater contract](../installed-update-runtime.md). | No new OTA, helper, rollback or installed witness.                                                        |
| Credential privacy                                                | [connector-key-store.ts](../../src/apps/desktop/connector-key-store.ts).                                                                                                                                                                         | Private filesystem store, not Keychain or protection against every same-user process.                     |
| Signing and platform metadata                                     | [package.mjs](../../tooling/package.mjs), public release notes.                                                                                                                                                                                  | Unsigned/non-notarized. Vendor-derived source/package minimum is 13.0; clean-Mac acceptance is pending.   |
| Install/adoption gap                                              | [adoption.md](modules/release/adoption.md), Release service/port files, [wire schema](../../api/desktop/v1/schema.json), [promotion reference](../owner-preview.md#optional-local-promotion--owner-action-only).                                 | Proposed contract, not an available external installer.                                                   |
| File, Shell/Git and experimental capability limits                | [Computer evidence](../computer-parity.md), [access policy](../sandbox-approvals.md), [native composition](../../boot/nativeruntime.go), historical installed summaries.                                                                         | Actual installed local Git and unchanged-hook commit verified; Tasks/Agent/Git SSH/PDF remain unaccepted. |

## Internal delivery evidence incorporated

The qualified internal installation is source `12fd195d1b98acae0d3008a1cfcdfc6bc4bad82b`, build ID `2f30a2a592348bd6bfa30960e0cb3e683ad14c71ccfc529a0c4eb4e7eaba3cc9`. The Lead retained its original package, native Go/MCP and installed operation results privately. Evidence includes actual Quit/relaunch/reconnection, ordinary Git with the existing symlinked Python hook, hook-rejection controls and retained command output after reconnection. Personal repository paths, commit messages, operation handles and transcripts are excluded from these public guides.

Fresh read-only inspection confirms the installed outer app's location, bundle ID and version/build. The separate source package remains source `5dc8fbbc940c17f30f2b3364d7e5e119252c648e`, build ID `ee1254f87424ac150615bffc449c628af6417e9936c63ecae8e68ad1edde6a0a`; it was not installed. GitHub's latest-release API still reports public v0.2.3 and the ZIP digest listed in [status](status.md).

Native assessment of a disposable copy of that public archive found no usable code signature. The app was not launched, its quarantine remained present, and the exact Finder warning was not reproduced. Neither that assessment nor the working internal install establishes a supported first-recipient journey.

## Journeys checked by documentation and source review

- Fresh recipient: README → installation requirements/download inspection → explicit first-install hold and blocker checklist.
- Existing accepted install: Setup → tunnel/key → matching ChatGPT app → one deliberate check and local receipt.
- First folder: sample file → picker → explicit change from saved Read & write to Read-only → checked scope → requested read → grant removal without deleting files.
- Returning or interrupted setup: retain saved key/current checks → observe pending/unknown operation → continue without replay or destructive reset.
- Existing-baseline update: manual check → download/verification → one Install and Relaunch → version/connection review; recovery stays separate.
- Uninstall: settle work → revoke matching grants/external resources deliberately → normal Quit → recoverable exact-app removal; complete erasure remains unqualified.

These are checked paths through the written documentation and inspected implementation, not newly executed installed-product or live-provider journeys. The [offline checker](../tools/README.md) validates its declared local-link/anchor and command scope; formatting and diff checks supplement it. It does not verify external URLs, release bytes or GUI behavior.

## Original documentation checkpoint checks

- `python3 docs/tools/check.py`: PASS for 23 reader pages, 254 local links/anchors, 34 command references and 7 inbound README links at this checkpoint.
- Prettier **3.9.6**: PASS on all 26 owned Markdown files, using the existing local pinned dependency installation. This worktree did not install dependencies.
- `git diff --check`: PASS. Owned changes are Markdown and the offline documentation checker only.
- `python3 scripts/scan-working-tree.py`: PASS, no leaks found in tracked and nonignored source bytes.
- Gitleaks **git** scan of the six incoming documentation commits (`75b15c78..1b2643cf`): PASS, no leaks found before the reconciliation commit.

The original documentation checkpoint did not run full source CI, packaging, GUI, installed or live-provider checks. The later runtime/package/installed results above are separate exact-byte evidence, not new tests performed by a Markdown change. The refresh uses the focused offline checker, pinned Markdown formatter, final diff review and source/history secret scans; recorded results are reported with its commit.

## Remaining screenshots and installed acceptance

No current UI screenshot has been approved for public use in this task, so none is added. The Lead should obtain and approve these exact installed-release captures after the corresponding journey succeeds:

- Setup Overview with current checked states and optional sign-in.
- Connection showing safe empty credential fields and a non-sensitive status; omit tunnel IDs, keys and account identity.
- A synthetic workspace with Saved access: Read-only and Access checked; omit personal paths.
- Check showing the receipt-confirmed current attachment, with no private transcript or request identity.
- Update dialog for the actual accepted installed/current successor versions and the recovery entrypoint.

Use a synthetic folder and approved account-safe surfaces. Existing design-lab assets and screenshots from earlier builds are not silently promoted. Fresh-recipient installation/adoption, native picker/clipboard, receipt-confirmed Setup, broader current read/write/revocation, real successor update and complete uninstall/reinstall remain product acceptance work under [the checklist](install-readiness.md). Completed installed Git checks do not close those separate journeys.

[Technical references](README.md) · [Documentation](../README.md)
