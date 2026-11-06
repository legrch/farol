# Animated Farol setup guide

Eight light-theme UI recreations show the setup flow with synthetic values. They are not screen recordings or evidence of a live setup. Start from an **accepted, running Farol installation**; [installation requirements and limits](../../start/installation.md) still apply. Service screens and account-specific choices may differ.

**Motion is optional.** Read the complete steps below without opening a GIF. Each section has a static image link outside its animation. The GIFs loop when opened and do not have an in-image pause control; collapse the section to hide the animation, or use the static image and text. [Build source and accuracy notes](README.md) explain the recreations.

## Steps

- [1. Sign in to ChatGPT](#1-sign-in-to-chatgpt)
- [2. Add a workspace](#2-add-a-workspace)
- [Optional: edits and commands](#optional-edits-and-commands)
- [3. Create a tunnel](#3-create-a-tunnel)
- [4. Create a restricted key](#4-create-a-restricted-key)
- [5. Connect this Mac](#5-connect-this-mac)
- [6. Add Farol to ChatGPT](#6-add-farol-to-chatgpt)
- [7. Test the connection](#7-test-the-connection)

## 1. Sign in to ChatGPT

1. Open **Setup → Start setup** and choose **Sign in** or **Open ChatGPT**.
2. Use your own ChatGPT account, then return to Setup. If confirmation is still needed, choose **Check sign-in**.
3. Wait for **✓ Sign-in checked**, then choose **Continue**. This does not yet grant local file access.

[Static image: 1. sign in to chatgpt](output/Farol-01-sign-in-light.png)

<details>
<summary>Show animation: 1. Sign in to ChatGPT</summary>

![Sign in in Farol, return to Setup, check sign-in, and continue; illustrated with synthetic data](output/Farol-01-sign-in-light.gif)

</details>

## 2. Add a workspace

1. In **Workspaces**, choose **+ Add workspace** and select a small, non-sensitive sample folder.
2. Review the path and saved **Read only** access. Wait for **✓ Works**; every listed workspace needs a current check.
3. Choose **Continue** when the checks are current. [Try a sample workspace](../../start/first-workspace.md) for a complete read-only exercise.

[Static image: 2. add a workspace](output/Farol-02-workspace-light.png)

<details>
<summary>Show animation: 2. Add a workspace</summary>

![Choose a sample folder, keep Read only, and wait for Works; illustrated with synthetic data](output/Farol-02-workspace-light.gif)

</details>

## Optional: edits and commands

Keep Read only and Commands off for the first reading exercise. If a later task needs changes, choose **Read & write** in the workspace row and wait for the saved access check. Review **Commands** separately: it is shared across approved workspaces, not a per-folder sandbox. The animation demonstrates optional changes; it is not a required setup step. See [Best practices](../../guides/best-practices.md).

[Static image: optional: edits and commands](output/Farol-02b-edits-and-commands-light.png)

<details>
<summary>Show animation: Optional: edits and commands</summary>

![Review optional Read & write and the shared Commands grant; illustrated with synthetic data](output/Farol-02b-edits-and-commands-light.gif)

</details>

## 3. Create a tunnel

1. From **Connect this Mac**, choose **Open OpenAI Tunnels** in the intended Platform organization. Reuse an appropriate existing tunnel if you already have one.
2. For a new tunnel, fill **Name** and the required **Description**, review **Organizations**, and select the intended **ChatGPT workspaces**. A workspace may display as an ID. Review any optional security settings under your organization's policy.
3. Choose **Create** once and observe the result. Copy the complete tunnel ID from its row.
4. Paste that ID into Farol before copying the key, so the next Copy action does not replace your only copy of the ID. A Platform-organization-only tunnel may not be available in ChatGPT.

[Static image: 3. create a tunnel](output/Farol-03-create-tunnel-light.png)

<details>
<summary>Show animation: 3. Create a tunnel</summary>

![Create a tunnel for the intended ChatGPT workspace, copy its ID, and paste it into Farol; illustrated with synthetic data](output/Farol-03-create-tunnel-light.gif)

</details>

## 4. Create a restricted key

1. Open the API-key form and choose the intended project and expiration under your organization's policy. The available menus were not verified and are deliberately not illustrated.
2. Choose **Restricted**. Under **Tunnels**, select **Read** and **Use** only; leave unrelated permissions at **None**. “All selected” inside that selector means both Tunnels choices, not full-key access.
3. When the key is created, use **Save your key → Copy → Done**, then return to Farol. Keep the real key private. The visible demo key is invalid and must not be used.

Do not substitute a full-access or admin key. Never paste the key into a chat, repository, screenshot or support message.

[Static image: 4. create a restricted key](output/Farol-04-restricted-key-light.png)

<details>
<summary>Show animation: 4. Create a restricted key</summary>

![Select Restricted and Tunnels Read plus Use, then copy the key privately; illustrated with synthetic data](output/Farol-04-restricted-key-light.gif)

</details>

## 5. Connect this Mac

1. Confirm the **Tunnel ID** is present and paste the key into Farol's masked **Key** field.
2. Choose **Connect** once. Wait for the existing result; do not resubmit while it is pending or unknown.
3. Continue after **✓ Connected**. This confirms the local connection, not the ChatGPT attachment. If Farol says **Key saved**, leaving the field empty retains it; do not create or paste a replacement just because the field cleared.

[Static image: 5. connect this mac](output/Farol-05-connect-this-mac-light.png)

<details>
<summary>Show animation: 5. Connect this Mac</summary>

![Use the tunnel ID and masked key, connect once, and wait for Connected; illustrated with synthetic data](output/Farol-05-connect-this-mac-light.gif)

</details>

## 6. Add Farol to ChatGPT

1. Choose **Open ChatGPT Apps** in Farol. In the intended ChatGPT workspace, open **Plugins → Add → Add custom MCP server**. Reuse a plugin already attached to the same tunnel instead of duplicating it.
2. Set **Name** to the editable app name shown in Farol, **Connection: Tunnel**, the same **Tunnel ID**, and **Authentication: No authentication**. Read the risk disclosure and decide whether to accept it before choosing **Create as a plugin**.
3. Review the separate **Connect** dialog and data-sharing notice. Choose **Connect** once, wait, and find Farol in the plugin list.
4. Open **⋯ → Manage → Permission** to review **Permissions**. The animation leaves **Allow low-risk tools (Default)** unchanged.

The other choices are **Always ask**, **Allow read-only tools** (read without asking, but ask before changes), and **Allow all tools (Elevated risk)**. These are the UI descriptions, not guarantees for every call. Allow all tools is optional, requires an informed owner decision and is not necessary to follow this guide. [Compare the permission choices](../../guides/best-practices.md#choose-chatgpt-permissions-deliberately).

[Static image: 6. add farol to chatgpt](output/Farol-06-add-plugin-light.png) · [Static permissions screen](output/Farol-plugin-permissions-light.png)

<details>
<summary>Show animation: 6. Add Farol to ChatGPT</summary>

![Create and connect the plugin, find it, and review four permission levels without changing the default; illustrated with synthetic data](output/Farol-06-add-plugin-light.gif)

</details>

## 7. Test the connection

1. Return to Farol and choose **Test in ChatGPT** once. It uses a separate ordinary chat with Instant and the exact app name saved for this tunnel.
2. Wait for the original test. **Back to setup** returns without sending again.
3. Choose **Start using Farol** after **✓ Everything works** and current workspace checks. A model reply or plugin chip alone does not establish this result. The check does not read file contents.

If a check is already current, continue without repeating it. The successful state in the animation is simulated; it is not proof that your own setup passed.

[Static image: 7. test the connection](output/Farol-07-test-connection-light.png)

<details>
<summary>Show animation: 7. Test the connection</summary>

![Run one ChatGPT test, wait for the matching receipt, and return to Setup; illustrated with synthetic data](output/Farol-07-test-connection-light.gif)

</details>

## If a step is interrupted

Observe the original result before another connection attempt, key change or verification message. **Back** reviews an earlier step without replaying an action. Follow [Recovery](../../guides/recovery.md) for pending or unknown effects; do not widen access, delete state or choose another tunnel to clear uncertainty.

[Text connection guide](../../start/first-connection.md) · [Best practices](../../guides/best-practices.md) · [Start](../../start/README.md)
