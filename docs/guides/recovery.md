# Recover an interrupted setup

Reopen **Setup** and review saved state before starting again. Returning to a section is safe navigation; it does not reset the profile or repeat an action. A full reset is not required to continue an incomplete setup.

## Choose the next step from the result

| Observed state                                | Next action                                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A field was edited but never submitted        | Discard the unsubmitted field edit or finish it intentionally.                                                  |
| Credentials are confirmed saved               | Keep the saved key; review connection status.                                                                   |
| Workspace and attachment checks are current   | **Continue** without rechecking, or **Start using Farol** when all steps pass.                                  |
| An action is pending or its result is unknown | Observe the original action in **Unresolved actions** before another change.                                    |
| An action is explicitly refused               | Read its classified reason and saved state; refusal alone does not prove that every earlier step had no effect. |
| Configuration cannot be read                  | Preserve it and request scoped maintenance help.                                                                |

## Observe an uncertain action

Choose **Review unresolved actions** in the sidebar to open **Unresolved actions**. The sidebar control is shown only while something is unresolved. Inspect the listed original action, its operation identity, state and classified code. **Refresh status** reads current state; it does not replay a Send, edit, connection start or install. For an existing workspace edit, use **Observe existing edit** when offered; review its result before **Record result delivery**. Only existing workspace edits support operation readback here; refreshing is not a general operation query.

Preserve the original operation identity, status and error. For an unknown edit, the file may already contain the change. For an unknown verification Send, the message may already have been sent. Cancelling a draft or reopening the window does not resolve either uncertainty. Do not create a new operation ID or substitute an executor to repeat the work.

If the exact operation cannot be reconciled through the UI, stop that dependent action and ask the maintainer for a bounded read-only diagnosis. Other independent work need not be erased.

## Resume after a normal quit

Once work is settled and the current status permits it, **Command+Q** quits Farol; closing the window alone does not. Reopen the same accepted build and review Setup. A saved credential and folder remain configuration, while current connection/attachment checks may need review. Do not repeat an uncertain check because the app restarted.

## Resetting is a separate maintenance action

There is no general supported “delete the profile and start over” recovery procedure here. Profile data includes credentials, permissions and durable records needed to distinguish completed from unknown work. Do not delete settings, journals, `.farol-stage-*` folders or update predecessors to clear a status.

A fresh developer profile is a [developer test lane](../development/setup.md), not recovery of an installed user's unresolved operation. Legacy Farol and installed `codex-chatgpt-web` state are separate identities and must not be changed as a reset workaround.

## Interrupted updates or partial installation

Use **Settings → General → Update recovery…** for an existing recorded update. A partial owner promotion without its receipt must be preserved and reconciled; the absent receipt does not authorize deletion or a second installation. [Install readiness](../reference/install-readiness.md) describes the remaining first-recipient recovery gates.

[User guides](README.md) · [Troubleshooting](troubleshooting.md)
