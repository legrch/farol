# Common connection failures

Begin with the visible state in Farol. Record the version/build and exact error before changing settings. For interrupted or uncertain actions, follow [Recovery](recovery.md).

| Symptom                                     | First check                                                  |
| ------------------------------------------- | ------------------------------------------------------------ |
| Farol will not open                         | [Startup](#farol-will-not-open)                              |
| **Connection helper needed**                | [Helper discovery](#connection-helper-needed)                |
| Tunnel or key is refused                    | [Tunnel and credentials](#tunnel-or-credentials-are-refused) |
| Local connection works but ChatGPT does not | [Attachment](#chatgpt-cannot-reach-this-mac)                 |
| Workspace access is refused                 | [Folder access](#workspace-access-is-refused)                |
| A check stays pending or unknown            | [Observe the original check](#a-check-is-pending-or-unknown) |
| Updates have no accepted baseline           | [Update availability](#updates-are-unavailable)              |

## Farol will not open

The package is unsigned and not notarized. Retain the macOS warning and check [installation status](../start/installation.md). A verified checksum does not resolve a Gatekeeper or first-install/adoption issue.

Closing a window leaves Farol running. If changing between already accepted builds, quit the exact running Farol normally with **Command+Q** after settling work. Different or unverifiable builds are refused rather than silently joined. Do not launch parallel copies or replace an occupied app to force startup.

`SETTINGS_CORRUPT` after a downgrade can mean that newer settings were preserved rather than rewritten. Keep the settings and return to the newer compatible build. Ask for scoped help instead of deleting the profile.

## Connection helper needed

Use **Find connection helper** when offered. Farol must discover and validate a compatible helper before it is usable. A candidate path or saved setting alone is insufficient. Review **Connection help → Connection diagnostics** for the classified result.

A clean-machine helper installation/distribution path is still an open readiness gate. If discovery cannot find a supported helper, retain the diagnostic and ask the maintainer for the accepted prerequisite. This guide does not invent a download or executable-selection workaround.

## Tunnel or credentials are refused

Confirm the intended ChatGPT workspace and the tunnel shown by **Open Tunnels**. The tunnel must be associated with that ChatGPT workspace; an organization-only tunnel may not be selectable there. Use only the restricted runtime key described in [First connection](../start/first-connection.md).

If **Tunnel credentials saved** is shown, the blank key field is intentional. Keep the saved key. If saving or starting was unconfirmed, inspect the original result before replacing a key or choosing **Save & connect** again. If Developer mode or Tunnel is absent in ChatGPT, check account/workspace availability instead of changing Farol's local permissions.

## ChatGPT cannot reach this Mac

A local ready status does not prove the ChatGPT attachment. Confirm that the conversation uses the app attached to the same tunnel. Reuse that app; its display name does not select Farol versus Farol Dev. Do not move credentials between those environments.

Follow [ChatGPT app connection](chatgpt-connection.md) for the current verification request and matching receipt. A stale cached tool catalogue, visible app chip or ordinary model reply does not prove the current serving build. A current checked attachment needs no resend.

## Workspace access is refused

Review the physical path, **Saved access**, exclusions and current **Access checked** state. Use **Verify workspace** when offered for a changed or stale scope. Check that the intended workspace is prepared for Connection. A connection with no workspace grants no file access.

For `WORKSPACE_ROOT_CHANGED`, such as after reconnecting a volume, preserve any pending operation first. The documented owner path is to remove and re-add the folder deliberately; verification alone does not renew its changed physical identity. Review saved access again after adding it. See [Folder access](folder-access.md).

Shell/Git or Tasks being unavailable is not a reason to approve broader file access. Check [capability status](../reference/status.md).

## A check is pending or unknown

Open **Connection help → Connection diagnostics** or **Workspace diagnostics**. Review **Actions needing observation** and **Action details**, then use **Refresh status** to inspect current state. Refresh does not replay an action or establish that it succeeded.

An unknown result may already have taken effect. Keep the same operation and do not send a second challenge, retarget the check, replace credentials or delete the journal. Follow [Recovery](recovery.md).

## Updates are unavailable

A missing or mismatched accepted baseline blocks update preparation. Manual app copying does not establish that baseline. Review [installation status](../start/installation.md) and [Updating Farol](updates.md); this is separate from tunnel connectivity.

## Share useful diagnostics

Use the content-free Activity/support export when available and inspect what you share. Include version/build, the visible symptom, classified code and whether the original action is pending, refused, confirmed or unknown. Keep runtime keys, credentials, browser state, prompts, answers, file contents and personal paths out of public reports. [Technical references](../reference/README.md) are for the maintainer's deeper investigation.

[User guides](README.md) · [Documentation](../README.md)
