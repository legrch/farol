# Try your first workspace

Use a small folder containing only files you are comfortable returning to ChatGPT. Start with an accepted installation and follow [the connection guide](first-connection.md); Workspaces is the second Setup step.

## Prepare a sample

In Finder, create a folder named `Farol sample` in a location you control. Add a plain-text file named `hello.txt` with a harmless sentence, such as `This is my Farol sample.` Avoid personal documents, secrets, symlinks and shared repositories for the first trial.

## Review saved access before using it

1. In **Setup → Workspaces**, choose **+ Add workspace** and select the sample folder.
2. Review its path and **Access**. Adding a workspace saves **Read & write** and checks access; the picker does not create a read-only grant.
3. Select **Read only** in the row's **Access** control. It saves and checks access immediately. Wait for the confirmed result. If **Check access** is offered afterward, use it and inspect its result.
4. Confirm **Access: Read only** and **✓ Works** for this workspace. Every listed workspace needs a current check before **Continue** advances to **Connect this Mac**.

A pending or unknown change is not a confirmed permission change. Use [Recovery](../guides/recovery.md) before another submission. Navigating away does not undo an action already submitted.

## Ask ChatGPT to read it

Complete **Connect this Mac** and the current [attachment check](../guides/chatgpt-connection.md#verify-the-attachment) in **Add to ChatGPT** if needed. In a conversation with the matching Farol app selected, send a request such as:

> Use Farol to list my approved workspaces and read hello.txt in the Farol sample workspace. Do not change files or run commands.

Review the tool result and compare it with the file you created. Refused or unavailable access is a result to investigate; it is not an empty workspace or permission to select a broader path.

## Finish the trial

Keep the grant if you need it, or use **Remove [workspace name]** beside the workspace and wait for the confirmed result. The files remain on disk. Removing the last workspace leaves no workspace access and blocks continuing the guided flow until a workspace is added and checked. See [Workspace access](../guides/folder-access.md) before moving to real project data.

This exercise is a user procedure derived from source and retained File evidence. It has not been executed as a fresh-recipient installation acceptance test for this documentation change.

[Start](README.md) · [Documentation](../README.md)
