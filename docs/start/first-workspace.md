# Try your first workspace

Use a small folder containing only files you are comfortable returning to ChatGPT. Start with an accepted installation and a [configured connection](first-connection.md).

## Prepare a sample

In Finder, create a folder named `Farol sample` in a location you control. Add a plain-text file named `hello.txt` with a harmless sentence, such as `This is my Farol sample.` Avoid personal documents, secrets, symlinks and shared repositories for the first trial.

## Review saved access before using it

1. In **Setup → Workspaces**, choose **Add workspace…** and select the sample folder.
2. Review its path and **Saved access**. The current source saves **Read & write** when adding a folder; the picker does not create a read-only grant.
3. Under **Workspace access**, select **Read-only** and choose **Save**. Wait for the confirmed save and automatic access check/connection restoration. If **Verify workspace** is offered afterward, use it and inspect its result.
4. Confirm **Saved access: Read-only** and **Access checked** for this folder. Keep the sample folder selected for Connection when its check is needed.

A **Save** that is pending or unknown is not a confirmed permission change. Use [Recovery](../guides/recovery.md) before another submission. **Cancel** discards an unsaved draft; it does not undo an action already submitted.

## Ask ChatGPT to read it

Complete the current [attachment check](../guides/chatgpt-connection.md#verify-the-attachment) if one is needed. In a conversation with the matching Farol app selected, send a request such as:

> Use Farol to list my approved workspaces and read hello.txt in the Farol sample workspace. Do not change files or run commands.

Review the tool result and compare it with the file you created. Refused or unavailable access is a result to investigate; it is not an empty folder or permission to select a broader path.

## Finish the trial

Keep the grant if you need it, or use **Remove → Confirm removal** beside the workspace. The files remain on disk. Removing the last workspace restores a configured connection with no file access. See [Folder access](../guides/folder-access.md) before moving to real project data.

This exercise is a user procedure derived from source and retained File evidence. It has not been executed as a fresh-recipient installation acceptance test for this documentation change.

[Start](README.md) · [Documentation](../README.md)
