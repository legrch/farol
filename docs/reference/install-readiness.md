# First-install and adoption release blockers

This checklist gates a claim that a new recipient can install Farol and obtain a trusted update baseline. It does not add unrelated work to the Lead's current Computer/Git delivery. Status is from source `75b15c789b7c5c0dd83bf4bd38eb6d2c8520a3eb` on **14 October 2026**; unchecked items are not acceptance receipts.

## Available artifacts and paths

| Path or mechanism                                   | Audited state                                                                                                                                                                                   |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public v0.2.3 ZIP + release manifest + `SHA256SUMS` | Asset names, sizes and publication checked through GitHub API. The archive was not downloaded, extracted, opened or installed in this task. No public DMG/installer is listed for this release. |
| `task package` → `task run`                         | Developer candidate build and verified temporary launch. `task run` does not install. Packaging requires exact clean committed source and declared inputs.                                      |
| `task promote` and explicit `--apply`               | Controlled owner source-promotion path at the fixed alpha slot with a private receipt. Refuses occupied destinations. Not a recipient ZIP installer.                                            |
| Existing installed updater                          | Fixed alpha installation identity, accepted baseline and operation journals. Historical exact OTA transitions exist; fresh-copy adoption is not inferred.                                       |
| Replacement / maintenance tools                     | Scoped owner maintenance and recovery, not general first installation, uninstall or a second baseline authority.                                                                                |
| `/Applications/Farol.app`                           | Proposed production destination in [Release adoption](../../modules/release/adoption.md). No accepted executable first-install/adoption method or desktop wire contract is supplied there.      |
| Archived DMG/bootstrap                              | [Frozen nonshipping proposal](../archive/distribution-20261010/README.md). Ends at prepared bytes; does not install, adopt, launch or qualify OTA.                                              |

## Product implementation gates

- [ ] **Core / Identity / Release / Lead:** accept the final identity/profile, fixed destination and native parent ownership/permissions contract. Reconcile proposed `/Applications/Farol.app` with the distinct alpha `~/Applications/Farol.app`; do not redirect an old helper or infer path authority from a display name.
- [ ] **Release:** expose the one install/verify/adopt contract through accepted composition, with one operation ID and an immutable trusted descriptor binding archive/package manifest, source/build/channel, measured app tree, resources and helpers. A DMG name, sidecar checksum or private promotion receipt must not synthesize that descriptor.
- [ ] **Release:** implement pre-effect admission and durable intent. Physically observe both slots and active profile/work exclusions. Denied, changing or unreadable observations remain unknown; an absent receipt or closed window must not be interpreted as an absent/idle install.
- [ ] **Release:** implement first-launch adoption of an already copied exact app through physical measurement and durable binding to that same build, tree and fixed path. Do not recopy it or reuse another generation/path's evidence.
- [ ] **Identity / Release:** handle the legacy-only slot, both-slot collision, foreign app and unsafe/unknown path cases explicitly. Preserve the existing app/profile and require the selected identity decision before moving a legacy installation.
- [ ] **Release:** preserve interrupted original intent and admission. Observe the same operation after unknown results; do not issue a replacement copy, helper, rename or fallback executor. Keep refusal-before-effect, installed and unknown outcomes distinct.
- [ ] **Desktop / Distribution:** provide the recipient entrypoint and clear results only after the contract is accepted. No proposed installer command should appear in user docs before it exists.

## Distribution and first-run gates

- [ ] **Lead / Distribution:** accept the support matrix, including minimum macOS for the actual bundled Electron/native bytes, Apple Silicon coverage and clean-machine prerequisites. Plist `12.0` is metadata, not an OS acceptance result.
- [ ] **Computer / Distribution:** supply and qualify the connection helper installation/discovery path. The current UI can request a missing helper, but the guides cannot invent a supported helper download. Resolve native Python/Command Line Tools prerequisites without requiring unrelated source-build tools from end users.
- [ ] **Owner / Distribution:** decide the accepted unsigned-beta distribution policy or separately authorize signing/notarization work. Publish the actual status and an accepted macOS opening path; never silently remove quarantine or disable protections. This documentation task grants no signing/release authority.
- [ ] **Desktop:** reconcile stale in-app help. `connection-guide.tsx` still says the Computer check requires a workspace, while the current Setup/state guide supports an explicit empty-workspace connection. Older `owner-preview.md` descriptions also differ from current picker defaults; user docs now describe the actual **Read & write** default.
- [ ] **Lead / Desktop:** accept exact current labels, native picker, clipboard, helper and live ChatGPT/tunnel attachment on the installed release. Source/renderer fixtures alone do not close this journey.

## Required acceptance matrix

For each case, retain the exact source/package identity, destination measurements, original operation identity and classified final result. Private evidence stays private; only a reviewed summary belongs in public docs.

| Case                                                     | Required witness                                                                                                                                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Both slots physically absent                             | One admitted first install, durable accepted baseline, normal first launch and matching running build.                                                                      |
| Exact app already at accepted production slot            | One physical adoption without a second install; app/profile identity and baseline readback agree.                                                                           |
| Only legacy alpha present                                | Explicit identity/adoption decision before a move; preserve compatible state and old operation fences.                                                                      |
| Both slots present                                       | Collision refusal without choosing or modifying a writer implicitly.                                                                                                        |
| Foreign / redirected / unsafe / unreadable slot          | Classified refusal or uncertainty, no overwrite and no invented absence.                                                                                                    |
| Collision after preflight                                | No overwrite after another app appears.                                                                                                                                     |
| Crash or lost reply before/after copy or baseline commit | Same-operation observation and durable recovery across restart; no duplicate install.                                                                                       |
| Native prerequisite or macOS protection failure          | Accurate user-facing result and accepted recovery path on a fresh Mac.                                                                                                      |
| First installed connection                               | Restricted tunnel key, matching ChatGPT app, optional embedded sign-in, empty-workspace check and sample read-only workspace verified through the actual installed route.   |
| First successor update                                   | Adopted baseline discovers, verifies and installs N→N+1; grants/credentials retained and a fresh external File call succeeds.                                               |
| Uninstall / complete erasure / reinstall                 | Exact app and owned state identified; unresolved work protected; dedicated external resources revoked deliberately; clean reinstall does not inherit a fabricated baseline. |

A baseline install result alone is not LaunchServices, GUI, provider or owner acceptance. After those gates close, replace the installation hold with the tested recipient procedure and update [status](status.md), [first installation](../start/installation.md) and [verification](documentation-verification.md) together.

[Technical references](README.md) · [Release adoption contract](../../modules/release/adoption.md)
