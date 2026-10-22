# Choose workspace access

A workspace is a local folder you explicitly make available to Farol. Start with [a sample workspace](../start/first-workspace.md) before using real project material.

## Add or change a workspace

In **Setup → Workspaces**, use **+ Add workspace** and review the selected physical path. Adding a workspace saves **Read & write** and checks access immediately. Do not infer a read-only grant from the picker.

Use each row's **Access** control to choose:

| Saved access     | Meaning                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| **Read only**    | Allows supported listing, search and reads in the approved scope.                                              |
| **Read & write** | Allows guarded file changes; changes still require approval. It does not grant unrestricted command execution. |

A changed choice saves and checks access immediately; wait for the confirmed result. There is no separate save or cancel action for this control. Navigating away does not undo an already submitted or uncertain change.

**✓ Works** must apply to the current saved scope and build. Use **Check access** when offered. Changing access can invalidate other rows' checks; check those rows before continuing. A returning, current workspace can simply continue. The guided flow requires at least one workspace and current checks for every listed workspace.

## Keep the scope understandable

Review exclusions and avoid granting a home directory or broad shared root when a project workspace is sufficient. Read-only prevents permitted file changes; it does not make readable content private from ChatGPT. An approved root may contain sensitive files. Path restrictions are not a guarantee against every alias to the same data.

**Commands** is separate from **Access** and shared across all workspaces: changing any row's toggle changes every row. Command access and Git history are broader grants than ordinary file reads. Git history can contain content excluded from current-file access. The current Shell/Git route remains subject to [separate qualification](file-and-shell.md); a visible permission control is not proof that the route is active or accepted.

## Narrow or remove access

To narrow access, select **Read only** and inspect the confirmed result. To remove a grant, choose **Remove [workspace name]** beside that workspace and wait for the confirmed result. Removing access keeps the files on disk.

An admitted workspace change settles the configured connection through the existing stop/access/check operations. Wait for the original result; a separate manual stop or second submission is not part of this ordinary flow. Finish the Workspaces step before reconnecting under **Connect this Mac**. Removing the last workspace leaves no workspace access and blocks continuing the guided flow until a workspace is added and checked.

Pending work or an unknown result may pause permission changes. If Setup is open, use **Find a page → Home** to reach the sidebar. Choose **Review unresolved actions** in the sidebar to open **Unresolved actions**. This control appears only while something is unresolved. Inspect the original action and use **Refresh status** to observe available evidence. Do not widen access or remove the workspace to erase an uncertain effect. See [Recovery](recovery.md).

[User guides](README.md) · [Detailed setup semantics](../setup-connection.md)
