# Change folder access

Approve one folder for the work you want to perform, then verify the changed
access. Start with an existing [checked connection](../start/first-connection.md).

## Choose an access level

In **Setup → Folders**, add the physical folder with the native picker or review
an existing selection. Choose **Read only** for reading and search, or explicitly
approve **Read and write** for file changes. Review exclusions before checking it.

**Check:** Farol records current verification for the selected folder and build.
Choosing a folder, opening its page, or skipping a step does not establish that
verification. If the folder changed or became unavailable, stop and resolve the
classified diagnostic.

## Enable commands deliberately

In **Computer**, review the selected folder and the command access needed for this
work. The command modes have different scopes:

| Access                              | Use it for                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| Verified commands                   | Fixed Git status and exact HEAD checks                                                           |
| Workspace shell                     | Ordinary commands within the selected task scope                                                 |
| Full Git and user settings approval | Repository history, linked metadata, and declared ordinary user Git settings needed by shell Git |

Workspace shell keeps networking denied. Full Git is a separate explicit approval
because history can contain material excluded from current-file reads. Read/write
folder access does not imply any of these command or native task permissions.

**Check:** verify the selected access after the change. Keep any partial or unknown
transition visible; a settings readback does not silently complete it. Use the
[Computer reference](../reference/computer/capabilities.md) for the exact effect,
Git, shell, and cleanup contracts.

## Narrow or revoke access

Review the folder's current access in Farol, settle pending work, and explicitly
narrow the permissions or remove the folder. Recheck the resulting state before
starting more work. A retained conversation or summary does not renew approval.

If an earlier change is unresolved, inspect that existing operation first.
[Unknown-outcome recovery](troubleshooting.md#an-operation-has-an-unknown-outcome)
explains what evidence to preserve.

## Next

Return to your task in ChatGPT. For the underlying model, read
[authority and unknown outcomes](../architecture/authority.md).

---

[Practical guides](README.md) · [Documentation](../README.md)
