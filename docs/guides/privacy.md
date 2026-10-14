# Privacy and security

Farol makes selected local resources available to a connected ChatGPT app. Folder approval is a disclosure decision as well as an access decision: requested file contents and tool results can be returned to ChatGPT. Review what you share under your ChatGPT account/workspace policies.

## Folder and command boundaries

You approve workspaces and saved read or write access in Farol. A model cannot expand those grants by asking for another path. **Read & write** still requires approval for changes. Empty workspace selection grants no file access.

Use a narrow project folder and review exclusions. Approved roots may contain sensitive material; Farol does not promise to identify every secret by filename. Path containment is not object-level confidentiality: hardlink aliases and Git history can expose content beyond what a current-file view suggests. Read-only limits allowed changes, not disclosure of readable data.

Shell, full Git/history/user-settings access and networking are separate authority boundaries. Their source controls do not establish [installed/live qualification](file-and-shell.md). Git history can contain older excluded data, and hooks/configuration can affect commands. Git SSH is not a shipped capability claim.

## Credentials and browser state

Use a Restricted runtime key scoped to **Tunnels Read and Use**. The audited implementation stores it in a local file restricted to the current user, under a private directory; it does not use Keychain for this store. The submitted key is not read back into the settings field. Local-owner access remains a trust boundary; file permissions are not protection from every process running as you.

Signing in inside Farol creates a dedicated browser session. Keep credentials, cookies, browser profiles and session state private. Removing the app alone does not erase that state or revoke a runtime key. See [Safe uninstall](uninstall.md).

## Diagnostics and uncertain operations

Activity and the support export use allowlisted, content-free fields rather than prompts, answers, file contents, private paths or bearer values. This statement applies to those diagnostic surfaces; it is not a claim that every local state record is content-free. Inspect anything you intend to share and avoid raw profile uploads.

Durable operation identities preserve uncertainty when a reply is lost. An unknown outcome is not permission to repeat a file change, provider Send, command or update. [Recovery](recovery.md) keeps that evidence intact.

## Distribution trust

The current app is unsigned and not notarized. Published SHA-256 checks compare downloaded bytes with the published checksum, but do not establish an Apple-verified developer identity, notarization or an accepted update baseline. Read [First installation](../start/installation.md) before using a downloaded copy.

Farol Dev and the installed app use separate profiles and connections. Keep their grants, tunnels and keys separate. The historical owner guard is a protected-path fingerprint, not a filesystem sandbox or a general guarantee of isolation.

[User guides](README.md) · [Technical access policy](../sandbox-approvals.md)
