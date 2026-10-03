# Candidate launch and troubleshooting

For downloads and installed updates, use [installation](installation.md). For the
first connection and controls, use [Getting started](getting-started.md). This page
covers a verified source candidate and profile-specific remedies.

## Open a packaged candidate

From a clean committed checkout with an existing `task package` result:

```sh
task run
```

The command does not build. It checks source identity against
`_output/package/artifact.json`, copies the package into a new private launch
snapshot, verifies that final path, and launches those bytes. A concurrent package
build cannot replace its snapshot. Missing, stale, dirty, or mismatched candidate
inputs are refused with rebuild guidance.

A second launch reopens only a running instance whose nonce-bound acknowledgment
matches the candidate's source/build identity. Startup requests wait for the same
initialization to finish. A different or unverifiable running build is refused.
Quit it normally before switching candidates.

The launcher uses an allowlisted environment and removes its snapshot after observed
application exit. An interrupted launcher/host can leave a private temporary copy;
it is never reused as a candidate. Same-user processes that deliberately mutate this
unsigned snapshot are outside its integrity threat boundary.

Run `task package` for a fresh candidate after committing the intended source. Direct
execution inside `_output/package` or direct `tooling/run-preview.mjs` invocation
bypasses the supported admission path and is unsupported.

## Explicit launch modes

| Command                            | Meaning                                                      |
| ---------------------------------- | ------------------------------------------------------------ |
| `task run`                         | Ordinary packaged candidate with the product profile         |
| `task run -- --hidden`             | Same admission/profile, with all product windows hidden      |
| `task run -- --demo`               | Explicit scripted fixture tasks                              |
| `task dev`                         | Current working-tree build in the separate Farol Dev profile |
| `task dev -- --acceptance-profile` | Further isolated Dev acceptance profile                      |

Hidden candidate mode requires normal Quit/drain and does not prove visible UI.
It refuses an existing-instance reopen. Older primaries can leave its version-3
background request unverified after the bounded wait; the remedy is Quit, not a
foreground fallback. Test-only debug/profile overrides are not enabled by it.

## Product and Dev identities

| Identity                    | Farol                        | Farol Dev                   |
| --------------------------- | ---------------------------- | --------------------------- |
| Visible app name            | `Farol`                      | `Farol Dev`                 |
| App ID                      | `local.farol.next.preview`   | `local.farol.dev`           |
| Ordinary app-data directory | `Farol Next Preview`         | `Farol Dev`                 |
| Runtime partition           | `persist:farol-next-preview` | `persist:farol-dev-runtime` |
| ChatGPT partition           | `persist:farol-next-chatgpt` | `persist:farol-dev-chatgpt` |
| Runtime service             | `Farol Next Runtime`         | `Farol Dev Runtime`         |

These machine identities come from
[desktop-environment.ts](../src/apps/desktop/desktop-environment.ts). The visible
Farol brand does not rename compatibility state/receipt roots. Dev and product keep
separate connector, configuration, browser, and instance state. Neither copies
cookies, keys, personal Codex configuration, or the older product's state.

Acceptance Dev profiles use an additional `Farol Dev Acceptance` parent. A retained
legacy `Farol DEV` directory can be reused only by the metadata-based resolver.
Two distinct profiles fail with `DEV_PROFILE_DIRECTORY_AMBIGUOUS`; they are never
merged. A same-inode case alias does not cause a profile move.

A ChatGPT app's exact saved display name remains independent of build environment.
A renamed app needs explicit reselection for the same tunnel/generation. Creating a
duplicate tunnel or copying credentials is not a display-name migration.

## If something goes wrong

| Symptom                                     | Remedy                                                                                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Candidate missing or source mismatch        | Commit intended changes and run `task package`; then use `task run`                                                                                                                                                |
| Another build is already running            | Quit that exact Farol normally before launching the candidate                                                                                                                                                      |
| `SETTINGS_CORRUPT` after downgrade          | Preserve the file and reopen with the newer compatible build; do not delete state to force startup                                                                                                                 |
| `CONFIG_RENAME_REQUIRED`                    | Close all processes using this product profile. If only `product-settings.json` exists, rename it in place to `config.json`; if both exist, reconcile deliberately. See [configuration](config-model-discovery.md) |
| `DEV_PROFILE_DIRECTORY_AMBIGUOUS`           | Preserve both physical directories and reconcile their ownership/content before using Dev                                                                                                                          |
| Folder or command verification refused      | Read the classified reason, inspect the selected folder and its approval, and reverify after an explicit correction                                                                                                |
| Connection not attached                     | Check the saved app name, tunnel/generation, and exact local receipt through Setup; see [Getting started](getting-started.md)                                                                                      |
| Verification pending or outcome unknown     | Observe the existing operation. Do not retarget or resend it                                                                                                                                                       |
| Update baseline or staging recovery blocked | Preserve package/receipt/journal evidence and use [installed update recovery](installed-update-runtime.md); do not clear records by hand                                                                           |
| Product Agent returns `AGENT_NOT_READY`     | This is the explicit disabled route in [current status](status.md); a saved setting does not enable it                                                                                                             |

Setup remains available from Settings and from the task menu, including an empty
profile. A configuration error stays on the sidebar Setup surface with classified
diagnostics. Optional sign-in and folder steps never become verified merely because
you visited or skipped them.

## Quit and state retention

Closing the last window leaves the app and its utility runtime running. The Dock or
same-build second launch reopens one window. `Command+Q` requests bounded normal
shutdown; an unresolved operation or unconfirmed child is recorded as such.

Product configuration, task/conversation correlation, and effect receipts have their
own durable stores. Demo state is not promised across Quit. A retained conversation
or summary does not prove provider completion or renew Computer authority.

## Local promotion

[Installation](installation.md#establish-an-updater-managed-installation) owns the
current `task promote` plan/apply procedure. Promotion uses only an empty fixed
`$HOME/Applications/Farol.app` slot and a genuine installation receipt. A partial copy
or absent receipt never authorizes deletion or another install attempt.

Historical preview-slot retirement and closed recovery are controlled maintenance
operations in [product cutover](product-cutover.md), with exact evidence and a closed
application window. They are not ordinary startup fixes or automatic updates.

---

[Documentation index](README.md) · [Project overview](../README.md)
