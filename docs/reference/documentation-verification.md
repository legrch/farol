# Documentation audit and verification

Audit date: **14 October 2026**. Runtime source baseline: `75b15c789b7c5c0dd83bf4bd38eb6d2c8520a3eb`. This is an independent documentation range; the Lead retains integration and the current Computer/Git delivery. No runtime changes, app launches, provider Sends, installation, update, signing or publication are part of this audit.

## Integration of the existing documentation branch

The preserved branch `docs/github-guide` at `1b2643cf` supplied the Start / Guides / Development navigation, first-workspace exercise, symptom-based troubleshooting and offline checker foundations. Its historical base and published beta1 instructions are obsolete for this source. This range records that branch as a merge parent and manually reconciles the selected material with current source; it does not restore the branch's old architecture rewrites, release assumptions or installer recipe.

The previous current README and docs index are retained as [historical README](readme-history-2026-10-09.md) and [acceptance history](acceptance-history.md), with relative links rebased. Original files are still recoverable from the pinned source and Git history. The [frozen archive](../archive/distribution-20261010/README.md) remains unchanged.

## Source and external checks

| Documentation claim                                               | Owning evidence inspected                                                                                                                                                                                                                        | Limit                                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Public v0.2.3, assets and release status                          | GitHub API `repos/legrch/farol/releases/latest` and published release list; [public release](https://github.com/legrch/farol/releases/tag/v0.2.3).                                                                                               | Metadata and release notes only; no archive verification or installation.             |
| Source version/build                                              | [package.json](../../package.json): `0.2.4`, build `33`, `github-stable`.                                                                                                                                                                        | Source metadata, not a public or installed release.                                   |
| Setup order and passive navigation                                | [setup-checklist.ts](../../src/ui/renderer/setup-checklist.ts), [setup.tsx](../../src/ui/renderer/setup.tsx), [setup-navigation.ts](../../src/ui/renderer/setup-navigation.ts).                                                                  | Source inspection; older builds may differ.                                           |
| Add-workspace default, access, save/cancel/remove and diagnostics | [settings.tsx](../../src/ui/renderer/settings.tsx) (including `continueWorkspaceSetup`) and [setup semantics](../setup-connection.md).                                                                                                           | Source-backed; not a fresh native picker or filesystem journey.                       |
| Tunnel and ChatGPT destinations                                   | [setup-media.json](../../resources/setup-media.json), [setup links](../setup-links.md), current Connection and embedded-check source.                                                                                                            | External pages require account access; live ChatGPT entitlement/UI was not exercised. |
| Update menu, labels, preference and recovery                      | [menu-bar.ts](../../src/apps/desktop/menu-bar.ts), [shell.tsx](../../src/ui/renderer/shell.tsx), [automatic-update-choice.tsx](../../src/ui/renderer/automatic-update-choice.tsx), [installed updater contract](../installed-update-runtime.md). | No new OTA, helper, rollback or installed witness.                                    |
| Credential privacy                                                | [connector-key-store.ts](../../src/apps/desktop/connector-key-store.ts).                                                                                                                                                                         | Private filesystem store, not Keychain or protection against every same-user process. |
| Signing and platform metadata                                     | [package.mjs](../../tooling/package.mjs), public release notes.                                                                                                                                                                                  | Unsigned/non-notarized; plist minimum is not a supported-OS acceptance result.        |
| Install/adoption gap                                              | [adoption.md](../../modules/release/adoption.md), Release service/port files, [wire schema](../../api/desktop/v1/schema.json), [promotion reference](../owner-preview.md#optional-local-promotion--owner-action-only).                           | Proposed contract, not an available external installer.                               |
| File, Shell/Git and experimental capability limits                | [Computer evidence](../computer-parity.md), [access policy](../sandbox-approvals.md), [native composition](../../boot/nativeruntime.go), historical installed summaries.                                                                         | Scoped existing evidence; no Tasks/Agent/Git SSH/PDF shipping claim.                  |

## Journeys checked by documentation and source review

- Fresh recipient: README → installation requirements/download inspection → explicit first-install hold and blocker checklist.
- Existing accepted install: Setup → tunnel/key → matching ChatGPT app → one deliberate check and local receipt.
- First folder: sample file → picker → explicit change from saved Read & write to Read-only → checked scope → requested read → grant removal without deleting files.
- Returning or interrupted setup: retain saved key/current checks → observe pending/unknown operation → continue without replay or destructive reset.
- Existing-baseline update: manual check → download/verification → one Install and Relaunch → version/connection review; recovery stays separate.
- Uninstall: settle work → revoke matching grants/external resources deliberately → normal Quit → recoverable exact-app removal; complete erasure remains unqualified.

These are checked paths through the written documentation and inspected implementation, not newly executed installed-product or live-provider journeys. The [offline checker](../tools/README.md) validates its declared local-link/anchor and command scope; formatting and diff checks supplement it. It does not verify external URLs, release bytes or GUI behavior.

## Checks performed

- `python3 docs/tools/check.py`: PASS for 23 reader pages, 254 local links/anchors, 34 command references and 7 inbound README links at this checkpoint.
- Prettier **3.9.6**: PASS on all 26 owned Markdown files, using the existing local pinned dependency installation. This worktree did not install dependencies.
- `git diff --check`: PASS. Owned changes are Markdown and the offline documentation checker only.
- `python3 scripts/scan-working-tree.py`: PASS, no leaks found in tracked and nonignored source bytes.
- Gitleaks **git** scan of the six incoming documentation commits (`75b15c78..1b2643cf`): PASS, no leaks found before the reconciliation commit.

The original documentation checkpoint did not run full source CI, packaging, GUI, installed or live-provider checks. Subsequent integration evidence must bind the selected stable range; these scoped documentation checks do not replace it.

## Remaining screenshots and installed acceptance

No current UI screenshot has been approved for public use in this task, so none is added. The Lead should obtain and approve these exact installed-release captures after the corresponding journey succeeds:

- Setup Overview with current checked states and optional sign-in.
- Connection showing safe empty credential fields and a non-sensitive status; omit tunnel IDs, keys and account identity.
- A synthetic workspace with Saved access: Read-only and Access checked; omit personal paths.
- Check showing the receipt-confirmed current attachment, with no private transcript or request identity.
- Update dialog for the actual accepted installed/current successor versions and the recovery entrypoint.

Use a synthetic folder and approved account-safe surfaces. Existing design-lab assets and screenshots from earlier builds are not silently promoted. Fresh-recipient installation/adoption, native picker/clipboard, live tunnel attachment, current installed read/write/revocation, real successor update and complete uninstall/reinstall remain product acceptance work under [the checklist](install-readiness.md).

[Technical references](README.md) · [Documentation](../README.md)
