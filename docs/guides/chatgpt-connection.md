# Add Farol to ChatGPT

ChatGPT may call this an **app**, **connector** or **plugin**. In these guides, the ChatGPT app is the connection attached to your Secure MCP Tunnel; it is separate from Farol's Mac app. You need a [configured local connection](../start/first-connection.md) and access to the relevant ChatGPT workspace features.

## Attach the intended tunnel

1. In Farol, open **Setup → Add to ChatGPT** after the **Sign in**, **Workspaces** and **Connect this Mac** checks pass. Choose **Open ChatGPT Apps**.
2. In the intended ChatGPT workspace, open **Settings → Apps → Create**. ChatGPT may require developer mode or workspace permission before Create is available.
3. Reuse the app attached to your chosen tunnel. If none exists, create one with **Name: Farol**, **Connection: Tunnel** and the tunnel ID shown in Farol, and **Sign-in: None**.

These are the external destinations and steps bundled with the audited Farol source. Their availability depends on the current ChatGPT account and UI. If Create, developer mode or Tunnel is unavailable, stop and check workspace availability; a URL alone does not establish eligibility. Do not improvise a public server URL or substitute another environment's tunnel.

## Verify the attachment

In **Setup → Add to ChatGPT**, choose **Test in ChatGPT** once. Farol selects the app named **Farol** for this tunnel, sends one short verification message in a Temporary Chat using Instant, and checks the matching local receipt. The check verifies approved workspace access without reading file contents. **Back to setup** returns from the embedded check without sending another message.

Farol checks the exact selection and retains the attempt. If the check becomes uncertain, inspect the original result through [Recovery](recovery.md); do not select another app or repeat the Send. This check is an explicit use of your ChatGPT account, not a navigation step. Do not use a saved request from an earlier build or connection.

## Recognize completion

**✓ Everything works** means the retained receipt matches the current build, connection and approved workspace access. A provider answer, app name or successful copy alone does not establish this check. An already current check hides the first-time test button; continue without resending. Choose **Start using Farol** when all four Setup steps have current checks.

Use [Troubleshooting](troubleshooting.md) for a mismatch and [Recovery](recovery.md) for an unknown result. Review [Workspace access](folder-access.md) before asking ChatGPT to read project files.

[User guides](README.md) · [Documentation](../README.md)
