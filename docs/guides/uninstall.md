# Uninstall Farol safely

Removing the app, revoking ChatGPT access and deleting local state are separate actions. You can disconnect and remove an idle app while preserving the evidence needed for later recovery.

## Disconnect and remove the app

1. Review Diagnostics and settle active or unknown setup, edit, command and update operations. If an operation cannot be reconciled, preserve the app and its state for maintenance before removal.
2. If you want to revoke folder grants before quitting, use **Setup → Workspaces → Remove → Confirm removal** for each folder and wait for confirmed results. This keeps your files on disk.
3. In your ChatGPT workspace, remove or disable the matching Farol app connection. In the organization that owns the tunnel/key, revoke the dedicated runtime key and retire the tunnel if nothing else uses it. Confirm the matching connection before revocation; do not remove shared or Farol Dev resources by name alone.
4. Quit Farol normally with **Command+Q**. Confirm that work and any helper-driven recovery are settled.
5. In Finder, identify the exact Farol app you used and move only that app to the Trash. Keep the Trash recoverable until you have confirmed the correct app was removed.

No workspace files need to be deleted. Removing the app by itself does not revoke its external ChatGPT/tunnel configuration or remove its local profile. The current alpha slot and proposed production slot are [different installation boundaries](../start/installation.md#installation-paths-and-adoption); do not remove every similarly named copy automatically.

## Local data and complete erasure

The current product retains compatibility names such as **Farol** for its profile. Farol Dev, legacy Farol and installed `codex-chatgpt-web` have separate ownership. A product name is not enough to identify safe deletion targets.

A supported consumer flow for complete local data erasure, credential cleanup and update-baseline retirement is not qualified. Ask the maintainer to identify the exact owned paths and unresolved records before deleting local state. Keep any maintenance backup private: it can contain credentials and browser state. Developer retirement tools are not a public uninstall command.

This is a conservative manual disconnect/removal guide, not a witnessed complete-uninstall acceptance test. Full erasure and reinstall acceptance remain on the [Lead checklist](../reference/install-readiness.md).

[User guides](README.md) · [Privacy and security](privacy.md)
