# Add Farol to ChatGPT

ChatGPT may call this an **app**, **connector** or **plugin**. In these guides, the ChatGPT app is the connection attached to your Secure MCP Tunnel; it is separate from Farol's Mac app. You need a [configured local connection](../start/first-connection.md) and access to the relevant ChatGPT workspace features.

## Attach the intended tunnel

1. In the intended ChatGPT workspace, enable Developer mode and open [ChatGPT connectors](https://chatgpt.com/plugins), as linked by Farol's setup instructions.
2. Reuse the app attached to your chosen tunnel. If none exists, use the add action, name the app, select **Tunnel** as the connection type and choose that tunnel or enter its ID.
3. Select the matching app in the ChatGPT conversation you intend to use.

These are the external destinations and steps bundled with the audited Farol source. Their availability depends on the current ChatGPT account and UI. If Developer mode or Tunnel is unavailable, stop and check workspace availability; a URL alone does not establish eligibility. Do not improvise a public server URL or substitute another environment's tunnel.

## Verify the attachment

Choose one method deliberately. The connection test checks the approved workspace catalogue and returns counts, without reading file contents. A connection can also be checked with no workspace selected in the audited source.

### Manual check in external ChatGPT

1. In Farol's **Check** section, choose **Copy verification request** when the current request is available. Copying does not send it.
2. Paste and send it once in the intended ChatGPT conversation with the matching app selected.
3. Return to Farol and choose **Check attachment** to inspect the matching local receipt. It does not send another ChatGPT message.

If copying fails, **Technical details** lets you select the current request manually. Do not use a saved request from an earlier build or connection. A missing request requires status review.

### Embedded check inside Farol

Sign in to your account inside Farol first. Under **ChatGPT app and technical options**, enter the exact **ChatGPT app name** and choose **Select ChatGPT app**. Use the selected app in a Temporary Chat with the Instant model, then choose **Check in ChatGPT once** when ready to send one short verification message.

Farol checks the exact selection and retains the attempt. If the check becomes uncertain, inspect the original result; do not select another app or repeat the Send. This check is an explicit use of your ChatGPT account, not a navigation step.

## Recognize completion

**Attachment checked · Computer ready** means the retained receipt matches the current build, connection and selected workspace, or the explicit no-workspace selection. A provider answer, app name or successful copy alone does not establish this check. An already current check hides the first-time controls; use **Back to overview** without resending.

Use [Troubleshooting](troubleshooting.md) for a mismatch and [Recovery](recovery.md) for an unknown result. Review [Folder access](folder-access.md) before asking ChatGPT to read project files.

[User guides](README.md) · [Documentation](../README.md)
