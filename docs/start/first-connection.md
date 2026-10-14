# Connect this Mac to ChatGPT

Start from an accepted running Farol installation. New users should read [installation status](installation.md) first. These steps describe the UI in the audited source candidate; an older public or installed build may show different labels. See [current status](../reference/status.md).

## Review Setup

Open **Setup** and review **Overview → Sign in → Connection → Workspaces → Check**. **Continue**, **Previous** and **Back to overview** move between sections. Navigation does not save settings, grant access or submit a verification message.

**Sign in** is optional when you use ChatGPT in another browser. Use **Skip for now** for that path. Signing in inside Farol is needed for the embedded ChatGPT check; it does not establish local folder access or an external connection.

## Configure the tunnel

1. In **Connection**, open [Organization tunnels](https://platform.openai.com/settings/organization/tunnels), signed in to the organization you intend to use.
2. Create or select a tunnel associated with your intended **ChatGPT workspace**. A tunnel belonging only to a Platform organization may not appear in ChatGPT.
3. Obtain a **Restricted** runtime key scoped to **Tunnels Read and Use** only. Use the tunnel/key instructions shown in Farol; do not substitute an admin or full-access key.
4. Enter **Tunnel ID** and **Runtime key** in Farol. Choose **Save & connect** once, then wait for the result.

The key is cleared from the entry field on submission and is not read back into it. Keep it out of chats, repositories, screenshots and support messages. **Tunnel credentials saved** means you can retain the saved key; an empty form does not mean it was lost. Use **Edit connection** only when the connection details actually change.

**Connection started** establishes local setup only. If credentials were saved but connection did not complete, keep the saved key and inspect that result. For a missing or incompatible helper, use the offered **Find connection helper** and [troubleshooting](../guides/troubleshooting.md#connection-helper-needed); a discovered candidate is not proof that it is usable.

## Add the ChatGPT app

Follow [ChatGPT app connection](../guides/chatgpt-connection.md) to attach the same tunnel in your intended ChatGPT workspace. Reuse the app already attached to that tunnel. A name such as Farol Dev does not select an environment; the tunnel and running Farol instance must match.

## Choose folder access

You can continue with no workspace to check the connection without file access. For a first file trial, use [Your first workspace](first-workspace.md). Review the saved access: **Add workspace…** saves **Read & write** in this source candidate. Select **Read-only** and **Save** before making a read-only trial.

## Complete Check

Choose one method in [the attachment guide](../guides/chatgpt-connection.md#verify-the-attachment): a manual request in external ChatGPT, or the explicitly selected embedded check. Each sends one verification request. Do not run both simply to advance the wizard.

**Connected to this Mac · ChatGPT check needed** means the local connection is current. **Attachment checked · Computer ready** requires the matching attachment receipt and current access evidence for any selected workspace. A visible app chip or a model reply alone is insufficient. With no workspace selected, a checked connection still grants no file access.

For an existing current check, continue without resending. If the result is pending, unconfirmed or unknown, use [Recovery](../guides/recovery.md). Reopening Setup never requires a reset.

[Start](README.md) · [Detailed setup semantics](../setup-connection.md)
