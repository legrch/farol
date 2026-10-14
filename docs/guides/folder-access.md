# Choose folder access

A workspace is a local folder you explicitly make available to Farol. Start with [a sample folder](../start/first-workspace.md) before using real project material.

## Add or change a workspace

In **Setup → Workspaces**, use **Add workspace…** and review the selected physical path. In the audited source, adding a workspace saves **Read & write**, checks access and restores a configured connection. Do not infer a read-only grant from the picker.

Use **Workspace access** to choose:

| Saved access     | Meaning                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| **Read-only**    | Allows supported listing, search and reads in the approved scope.                                              |
| **Read & write** | Allows guarded file changes; changes still require approval. It does not grant unrestricted command execution. |

Choose **Save** for a changed choice and wait for the result. A confirmed change is followed by an access check and restoration of the configured connection. **Cancel** discards an unsaved draft. Cancelling does not undo an already submitted or uncertain change.

**Access checked** must apply to the current saved scope and build. Use **Verify workspace** when offered. Selecting a row alone does not bind it to Connection; that verification checks the current workspace or prepares another selected workspace. A returning, current workspace can simply continue.

## Keep the scope understandable

Review exclusions and avoid granting a home directory or broad shared root when a project folder is sufficient. Read-only prevents permitted file changes; it does not make readable content private from ChatGPT. An approved root may contain sensitive files. Path restrictions are not a guarantee against every alias to the same data.

Command access and Git history are broader grants than ordinary file reads. Git history can contain content excluded from current-file access. The current Shell/Git route remains subject to [separate qualification](file-and-shell.md); a visible permission control is not proof that the route is active or accepted.

## Narrow or remove access

To narrow access, select **Read-only**, choose **Save** and inspect the confirmed result. To remove a grant, choose **Remove** beside that workspace, then **Confirm removal**. **Keep workspace** cancels the removal confirmation. Removing access keeps the files on disk.

When the connection is running, an admitted workspace change drains it before applying the change. Wait for the original result; a separate manual stop or second submission is not part of this ordinary flow. After a confirmed removal, the remaining workspace checks and configured connection are restored. Removing the last folder restores a connection with no folder access.

Pending work or an unknown result may pause permission changes. Open **Workspace diagnostics** to inspect the original action. Do not widen access or remove the workspace to erase an uncertain effect. See [Recovery](recovery.md).

[User guides](README.md) · [Detailed setup semantics](../setup-connection.md)
