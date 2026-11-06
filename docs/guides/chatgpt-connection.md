# Add Farol to ChatGPT

ChatGPT may call this an **app**, **connector** or **plugin**. In these guides, the ChatGPT app is the connection attached to your Secure MCP Tunnel; it is separate from Farol's Mac app. You need a [configured local connection](../start/first-connection.md) and access to the relevant ChatGPT workspace features.

## Attach the intended tunnel

1. In Farol, open **Setup → Add to ChatGPT** after the **Sign in**, **Workspaces** and **Connect this Mac** checks pass. Choose **Open ChatGPT Apps**.
2. In the intended ChatGPT workspace, open **Plugins → Add → Add custom MCP server**. Reuse a plugin already attached to this tunnel instead of creating a duplicate.
3. If a new plugin is needed, enter **Name: the editable app name shown in Farol**, **Connection: Tunnel**, the same **Tunnel ID**, and **Authentication: No authentication**. Read the risk disclosure and decide whether to accept it before choosing **Create as a plugin**.
4. Review the separate **Connect** dialog, including its data-sharing notice. Choose **Connect** once and wait for the existing result. Find Farol in the plugin list after it connects.
5. To review tool confirmations, use **⋯ → Manage → Permission**. The **Permissions** page offers Always ask, Allow read-only tools, Allow low-risk tools (Default), and Allow all tools (Elevated risk). See [permission choices](best-practices.md#choose-chatgpt-permissions-deliberately). Allow all tools is optional, not a setup requirement.

These external screens were checked against current references from 6 November 2026. Farol's button still says **Open ChatGPT Apps**, while ChatGPT uses Plugins; account-specific labels and availability may differ. Farol may describe No authentication as None or No additional sign-in. If the creation control, Developer mode or Tunnel is unavailable, stop and check workspace availability; a URL alone does not establish eligibility. Do not improvise a public server URL or substitute another environment's tunnel.

[Watch the illustrated plugin flow](../media/onboarding/walkthrough.md#6-add-farol-to-chatgpt). It shows the permission choices without changing the default or creating any real credential.

## Verify the attachment

In **Setup → Add to ChatGPT**, choose **Test in ChatGPT** once. Farol selects the exact app name saved in Setup for this tunnel, sends one short verification message in a separate ordinary chat using Instant, and checks the matching local receipt. The check verifies approved workspace access without reading file contents. **Back to setup** returns from the embedded check without sending another message.

Farol checks the exact selection and retains the attempt. If the check becomes uncertain, inspect the original result through [Recovery](recovery.md); do not select another app or repeat the Send. This check is an explicit use of your ChatGPT account, not a navigation step. Do not use a saved request from an earlier build or connection.

## Recognize completion

**✓ Everything works** means the retained receipt matches the current build, connection and approved workspace access. A provider answer, app name or successful copy alone does not establish this check. An already current check hides the first-time test button; continue without resending. Choose **Start using Farol** when all four Setup steps have current checks.

Use [Troubleshooting](troubleshooting.md) for a mismatch and [Recovery](recovery.md) for an unknown result. Review [Workspace access](folder-access.md) before asking ChatGPT to read project files.

## Manual tests in ChatGPT

The ChatGPT toolbar offers **Test connection** and **Deep test** as requests in the current chat. Farol checks the selected app and the existing draft before requesting one Send; **Send requested** confirms the click acknowledgement, while the response and its diagnostic findings appear in ChatGPT. Starting or running a manual test does not itself change the verified Setup receipt or connection status; a real connection change remains visible. If Send cannot be confirmed, check the chat before starting a new test.

**Activity** shows requests by default. Select **System** to inspect background connection observations or **All** to see both. A terminal process record displays its exit separately from the fact that the observation was recorded; expand the entry for its details.

[User guides](README.md) · [Documentation](../README.md)
