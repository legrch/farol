# Best practices for Farol

Start with the smallest access that covers the task. These recommendations describe the current controls; they do not guarantee that every operation will be allowed or that every risk will be detected.

## Begin with a small read-only workspace

Use a sample folder with non-sensitive files. New workspaces start **Read only**. Verify the saved path, exclusions and **✓ Works** before asking ChatGPT to read anything. Read access can disclose file contents to ChatGPT, even when edits are blocked.

Grant a project folder rather than your home directory. An approved root can still contain secrets or aliases to sensitive data. Repository history may contain information no longer visible in current files. See [Workspace access](folder-access.md) and [Privacy and security](privacy.md).

## Keep three controls separate

- **Farol workspace Access:** Read only or Read & write for file operations in the approved scope.
- **Farol Commands:** a separate grant shared across all approved workspaces. Leave it off for the first file-reading exercise. Check the build's [Shell/Git availability](file-and-shell.md) and review hooks and configuration before enabling it.
- **ChatGPT plugin Permissions:** when ChatGPT asks before using tools. This does not widen Farol's local grants or turn an unavailable capability into an available one.

## Choose ChatGPT permissions deliberately

After connecting the plugin, find it in **Plugins**, open its **⋯** menu, choose **Manage**, then **Permission** to reach **Permissions**. The interface observed on 6 November 2026 offers:

- **Always ask:** the UI describes asking before reading or making changes.
- **Allow read-only tools:** the UI describes reading without asking, but asking before making changes. Consider this when you want routine reads without prompts and confirmation for changes.
- **Allow low-risk tools (Default) — recommended for this guide:** keep this default to let ChatGPT automatically approve low-risk tools; sensitive tools may be denied. The demonstration leaves this setting unchanged.
- **Allow all tools (Elevated risk):** the UI describes using tools without asking. This is optional and carries elevated risk. Choose it only if you understand and accept that broader behavior; it is not required by this guide.

These are the setting descriptions, not a promise that every call is accepted or that every change produces a prompt. Account rules, tool classification and Farol's own controls still apply. Review your actual screen before making a choice. The tutorial displays the options without switching them.

[Watch the connection and permission review](../start/setup.md#6-add-farol-to-chatgpt) or follow the [text connection guide](chatgpt-connection.md).

## Make changes in small steps

Ask for the intended scope, review a proposed edit, and keep a backup or version-controlled baseline where appropriate. Enable **Read & write** only for work that needs it, wait for the saved access check, and inspect the resulting file or diff. Do not assume a model's success message proves the effect happened.

Turn Commands on only for a task that needs them. This grant includes broader command and Git-history access across approved workspaces. A Read only file setting is not a substitute for reviewing the separate Commands grant.

## Keep the connection key private

Use a **Restricted** runtime key with **Tunnels Read + Use** and unrelated permissions at **None**. Choose project and expiration according to your organization; the animations do not establish the available menu choices. Keep the key out of chats, source control, screenshots and support messages.

Paste the tunnel ID into Farol before copying the key, so the second copy does not replace your only copy of the ID. Match the ChatGPT plugin to that same tunnel. Keep development and installed-app connections separate.

## Wait for the original result

Choose **Connect** or **Test in ChatGPT** once and observe its result. A pending or unknown outcome is not permission to repeat it. Use **Review unresolved actions** when offered and follow [Recovery](recovery.md). Do not delete state, switch environments or widen access to clear an uncertain effect.

After a confirmed task is finished, narrow or remove unneeded folder grants using the normal controls. Removing a workspace keeps its files on disk; removing the app alone does not revoke a key or erase browser state. Follow [Safe uninstall](uninstall.md) for that separate process.

[User guides](README.md) · [Start](../start/README.md)
