# Troubleshoot Farol

Start from the visible symptom. Keep the classified error and existing operation
state so the remedy can be checked against the same work.

## Find the problem

| Symptom                                 | Go to                                                             |
| --------------------------------------- | ----------------------------------------------------------------- |
| The app or candidate will not open      | [Startup and build identity](#the-app-or-candidate-will-not-open) |
| Connection verification is pending      | [Connection checks](#the-connection-check-is-pending)             |
| A folder or command is refused          | [Folder access](#folder-access-is-refused)                        |
| The profile/configuration cannot load   | [Configuration](#configuration-or-profile-is-ambiguous)           |
| An update has no baseline or is blocked | [Updates](#updates-are-unavailable-or-blocked)                    |
| An effect may have happened             | [Unknown outcomes](#an-operation-has-an-unknown-outcome)          |

## The app or candidate will not open

For a downloaded beta, check the [installation requirements](../start/installation.md)
and retain its manifest/checksums. The package is unsigned.

A running beta shares the product profile with another beta copy. Quit the exact
running Farol normally before switching builds. A different or unverifiable build
is refused rather than joined.

For `task run`, a missing or mismatched candidate needs a clean committed source
snapshot and a new `task package` result. Follow [candidate packaging](../development/packaging.md).
The launcher does not build. A hidden launch that cannot verify a prior instance
needs normal Quit; it does not fall back to showing a window.

## The connection check is pending

Check the saved tunnel and exact attached app name in **Setup**. Read the local
receipt/status for the existing check. A visible chip or ordinary model reply does
not prove attachment.

A renamed app needs explicit reselection for the same tunnel/generation. Keep a
pending or unknown Send on its original operation; do not duplicate a tunnel,
retarget the operation, or send the challenge again blindly.

Use [first connection](../start/first-connection.md) for the setup sequence and
[setup links](../reference/setup-links.md) for its external destinations.

## Folder access is refused

Review the physical folder, exclusions, requested operation, and granted access in
**Folders** and **Computer**. Correct the explicit issue and verify the changed
access on this build. A missing/unavailable file is different from an empty result.

For shell Git, review the separate full Git/user settings approval. Do not widen
permissions merely to suppress a diagnostic. See [folder access](folder-access.md)
and the [Computer reference](../reference/computer/capabilities.md).

## Configuration or profile is ambiguous

| Diagnostic                         | Remedy                                                                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SETTINGS_CORRUPT` after downgrade | Keep the file and reopen with the newer compatible build                                                                                                   |
| `CONFIG_RENAME_REQUIRED`           | Close all processes using that profile. If only `product-settings.json` exists, rename it in place to `config.json`; if both exist, reconcile deliberately |
| `DEV_PROFILE_DIRECTORY_AMBIGUOUS`  | Preserve both physical directories and reconcile their ownership/content before using Dev                                                                  |

The [configuration reference](../reference/configuration.md) and
[profile identities](../reference/profiles.md) describe the exact ownership.
Do not delete state to force startup or merge two profiles automatically.

## Updates are unavailable or blocked

A downloaded app can have no accepted installation receipt. Read
[the installation baseline](../development/packaging.md#establish-an-installed-baseline)
before treating that as an update-server failure.

For staging, helper, or journal recovery, keep the exact evidence and use
[the update guide](updates.md). Deleting a journal or predecessor can destroy the
proof needed for safe recovery. Native task or browser obligations must be settled
through their owning route; the updater does not cancel unrelated work for you.

## An operation has an unknown outcome

An effect may have occurred without a trustworthy acknowledgment. Inspect the
existing operation's status and receipt. Keep its task/call/operation identity and
the classified error.

Do not resubmit it under another key, replace its child process, switch executors,
or erase its journal. Completion needs the correlated evidence defined by that
route. A command's root exit or cancellation signal alone does not prove descendant
cleanup. See [authority and recovery](../architecture/authority.md).

## An experimental route is unavailable

Model and Product Agent are explicitly disabled. `AGENT_NOT_READY` is their current
source gate; a saved setting cannot enable it. Native Codex tasks need separate
host/project/workspace admission, and Claude remains fixture-only. Check
[current status](../reference/status.md) and the [task reference](../reference/tasks/README.md).

## Prepare useful diagnostics

Record the app version/build, relevant profile, visible symptom, classified error,
and the existing operation's status. Use allowlisted Activity/support diagnostics
when available. Keep credentials, prompts, answers, browser state, and file contents
out of a public report. If more evidence is needed, decide its scope before sharing.

---

[Practical guides](README.md) · [Documentation](../README.md)
