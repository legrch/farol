# Connect this Mac to ChatGPT

Start from an accepted running Farol installation. New users should read [installation status](installation.md) first. These steps describe the UI in the audited source candidate; an older public or installed build may show different labels. See [current status](../reference/status.md).

## Review Setup

Open **Setup**, choose **Start setup**, and follow **Sign in → Workspaces → Connect this Mac → Add to ChatGPT**. **Continue** advances only after the current step passes. **Back** reviews an earlier step without repeating an action. Navigation does not save settings, grant access or submit a verification message.

In **Sign in**, choose **Sign in** or **Open ChatGPT**, finish signing in with your own account, then return to Setup. Farol confirms the signed-in page automatically; choose **Check sign-in** only if the step still needs confirmation. When **✓ Sign-in checked** appears, choose **Continue**. This guided flow requires the sign-in check; there is no skip. Signing in does not establish local workspace access or an external connection.

## Choose workspace access

In **Workspaces**, choose **+ Add workspace** and select a workspace. Adding it saves **Read & write** and checks access. For a read-only trial, select **Read only** in the row's **Access** control before asking ChatGPT to use it. The choice saves and checks access immediately; wait for its confirmed result. Use [Your first workspace](first-workspace.md) for a small sample.

At least one workspace is required in this guided flow, and every listed workspace must show **✓ Works** before continuing. A selected path alone does not establish access. A pending or unknown change must be observed before another submission; see [Recovery](../guides/recovery.md).

## Configure the tunnel

1. In **Connect this Mac**, choose **Open OpenAI Tunnels**, signed in to the organization you intend to use.
2. Create or select a tunnel associated with your intended **ChatGPT workspace**. A tunnel belonging only to a Platform organization may not appear in ChatGPT.
3. Obtain a **Restricted** runtime key scoped to **Tunnels Read and Use** only. Use the tunnel/key instructions shown in Farol; do not substitute an admin or full-access key.
4. Enter **Tunnel ID** and **Key** in Farol. Choose **Connect** once, then wait for **✓ Connected**.

Connect discovers and validates the connection helper before using it. If it is unavailable, follow the displayed cause and [helper troubleshooting](../guides/troubleshooting.md#connection-helper-needed). A discovered candidate is not proof that it is usable.

The key clears from the entry field on submission and is not read back into it. Keep it out of chats, repositories, screenshots and support messages. **Key saved** means you can leave the field empty to retain the saved key; an empty form does not mean it was lost. Enter a replacement only when the details actually need to change. If saving or connecting was unconfirmed, inspect the original result before another change.

**✓ Connected** establishes local setup only; it does not prove the ChatGPT attachment.

## Add the ChatGPT app and check it

In **Add to ChatGPT**, follow [ChatGPT app connection](../guides/chatgpt-connection.md) to attach the same tunnel in your intended ChatGPT workspace. Reuse the app already attached to that tunnel. Its display name does not select an environment; the tunnel and running Farol instance must match.

Choose **Test in ChatGPT** once. Farol sends one short verification request in a separate ordinary chat using Instant and checks the matching receipt from this Mac. **Back to setup** returns from the embedded check without resending.

**✓ Everything works** requires the matching attachment receipt and current workspace access checks. A visible app chip or a model reply alone is insufficient. The check does not read file contents. Choose **Start using Farol** when all four steps have current checks.

For an existing current check, continue without resending. If the result is pending, unconfirmed or unknown, use [Recovery](../guides/recovery.md). Reopening Setup never requires a reset.

[Start](README.md) · [Detailed setup semantics](../setup-connection.md)
