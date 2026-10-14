# Recover an interrupted setup

Reopen **Setup** and review saved state before starting again. Returning to a section is safe navigation; it does not reset the profile or repeat an action. A full reset is not required to continue an incomplete setup.

## Choose the next step from the result

| Observed state                                | Next action                                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A field was edited but never submitted        | **Cancel** the local draft or finish it intentionally.                                                          |
| Credentials are confirmed saved               | Keep the saved key; review connection status.                                                                   |
| Workspace and attachment checks are current   | **Continue** or **Back to overview** without rechecking.                                                        |
| An action is pending or its result is unknown | Observe the original action in Diagnostics before another change.                                               |
| An action is explicitly refused               | Read its classified reason and saved state; refusal alone does not prove that every earlier step had no effect. |
| Configuration cannot be read                  | Preserve it and request scoped maintenance help.                                                                |

## Observe an uncertain action

Use **Connection help → Connection diagnostics** or **Workspace diagnostics**. Inspect **Actions needing observation** and **Action details**. **Refresh status** reads current state; it does not replay a Send, edit, connection start or install.

Preserve the original operation identity, status and error. For an unknown edit, the file may already contain the change. For an unknown verification Send, the message may already have been sent. Cancelling a draft or reopening the window does not resolve either uncertainty. Do not create a new operation ID or substitute an executor to repeat the work.

If the exact operation cannot be reconciled through the UI, stop that dependent action and ask the maintainer for a bounded read-only diagnosis. Other independent work need not be erased.

## Resume after a normal quit

Once work is settled and the current status permits it, **Command+Q** quits Farol; closing the window alone does not. Reopen the same accepted build and review Setup. A saved credential and folder remain configuration, while current connection/attachment checks may need review. Do not repeat an uncertain check because the app restarted.

## Resetting is a separate maintenance action

There is no general supported “delete the profile and start over” recovery procedure here. Profile data includes credentials, permissions and durable records needed to distinguish completed from unknown work. Do not delete settings, journals, `.farol-stage-*` folders or update predecessors to clear a status.

A fresh developer profile is a [developer test lane](../development/setup.md), not recovery of an installed user's unresolved operation. Legacy Farol and installed `codex-chatgpt-web` state are separate identities and must not be changed as a reset workaround.

## Interrupted updates or partial installation

Use **Settings → Diagnostics → Update recovery** for an existing recorded update. A partial owner promotion without its receipt must be preserved and reconciled; the absent receipt does not authorize deletion or a second installation. [Install readiness](../reference/install-readiness.md) describes the remaining first-recipient recovery gates.

[User guides](README.md) · [Troubleshooting](troubleshooting.md)
