# Set up Farol with ChatGPT

Open **Setup**, choose **Start setup**, and follow **Sign in → Workspaces → Connect this Mac → Add to ChatGPT**. The progress line shows the checks that passed. **Continue** stays disabled until the current step passes. **Back** lets you review an earlier step without repeating an action.

Setup uses your own ChatGPT account and the workspaces you approve on this Mac. Opening Setup does not reset your profile, replace a key or send a ChatGPT message. A returning profile keeps its saved settings. A saved check permits Continue only while its evidence still matches the current inputs: the signed-in document, every workspace and its access, the tunnel ID/key/helper generation, and the selected ChatGPT app. Sign-in needs an explicit successful check in the current window. Unknown, pending, refused, missing and stale results all block Continue and show a cause with one recovery action. Refresh observes an existing result; it never resubmits an unknown action. Editing the tunnel ID or entering a replacement key withdraws Continue until the new inputs pass their check.

## 1. Sign in

Choose **Sign in**, or **Open ChatGPT** if Farol cannot recognize the existing page. Finish signing in and return to Setup. When your signed-in page is recognized, choose **Check sign-in**. This saves the existing account-readiness check needed by the embedded ChatGPT test. Opening a page alone is not a passed check.

When **✓ Sign-in checked** appears, choose **Continue**. There is no skip in this guided flow. A connection used outside Farol can still have independent external verification; that does not replace this flow's sign-in check.

## 2. Workspaces

Choose **+ Add workspace** and select a workspace in the native picker. Farol saves **Read & write** access and checks it immediately. Each row shows its path, saved access and **✓ Works** only when its access check matches this build and saved workspace identity.

- Choose **Read only** or **Read & write** on each row. Farol saves the choice and checks access again. Changes to files still ask for approval.
- Use **Commands** to allow git, tests and builds. Each run still asks for approval. The existing command-access setting is shared across all workspaces: changing any row's toggle changes every row. These are not independent per-workspace command grants.
- Use **Check access** when a row has no current check. Changing access can invalidate other rows' checks; check those rows before continuing.
- **Remove [workspace name]** revokes access and keeps the files on disk.

At least one workspace is required in this guided flow, and every listed workspace must pass its check. A saved path alone does not establish working access. If access cannot be checked, confirm that the workspace still exists and this macOS account can open it. A pending or unconfirmed action blocks changes; refreshing only observes its saved result.

Workspace changes use the existing admitted stop/access/check operations. Finish the Workspaces step before reconnecting in the next step. A refused or unconfirmed stop is never repeated automatically.

## 3. Connect this Mac

Watch **Create a tunnel and a key**, or use its numbered static frames when reduced motion is enabled. The walkthrough is an illustration; it never signs in, creates a tunnel or handles a real key.

1. Choose **Open OpenAI Tunnels** to open [OpenAI organization tunnels](https://platform.openai.com/settings/organization/tunnels).
2. Create a tunnel named **Farol** and select the ChatGPT workspace you intend to use. Copy its tunnel ID.
3. In the same organization's API keys, create a key named **Farol** with **Restricted** permissions. Allow **Tunnels: Read and Use**. Copy the key when it is shown.
4. Enter the **Tunnel ID** and **Key** in Farol, then choose **Connect** once.

Connect finds and validates `tunnel-client`, including the existing account-owned adoption path when applicable, saves the key through Farol's credential owner, starts the connection and checks its health. Only **✓ Connected** lets you continue. This is a local connection check; the next step separately verifies access from ChatGPT.

A saved key is never read back into the form. The field clears on submission. For a returning profile, leave the field empty to use the saved key; enter a replacement only when details need to change. Connect uses the existing stop operation before replacing details on a running connection.

### If tunnel-client is unavailable

Install OpenAI's supported `tunnel-client` for the same macOS account that runs Farol, following the installation instructions on the OpenAI Tunnels page. Return to Farol and choose **Connect**. Farol validates the executable and may adopt an existing supported installation into its own account-owned location. It will not use an unchecked helper or assume another account's installation is usable.

If a key cannot be saved, check this account's key storage before reconnecting. A local storage error does not prove that OpenAI rejected the key. If connection health cannot be confirmed, keep the saved key and follow the displayed action. Never resubmit an action with an unconfirmed outcome.

## 4. Add to ChatGPT

Watch the second illustrated walkthrough. Choose **Open ChatGPT Apps**, then open **Settings → Apps → Create** in ChatGPT and enter:

| Field      | Value                                         |
| ---------- | --------------------------------------------- |
| Name       | **Farol**                                     |
| Connection | **Tunnel**, with the tunnel ID shown in Farol |
| Sign-in    | **None**                                      |

Use the app attached to this exact tunnel. Keep development and production profiles and tunnels separate; the app's display name does not select the Farol environment. ChatGPT may require an eligible account, workspace permission or developer mode before it offers Create; see [OpenAI's custom-app setup guidance](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt).

Return to Farol and choose **Test in ChatGPT** once. Farol selects the app named **Farol** for this tunnel, sends one short request in a Temporary Chat using Instant, and checks the matching receipt from this Mac. **Back to setup** returns from the embedded check without sending it again.

**✓ Everything works** means ChatGPT used Farol, reached this Mac and verified access to the approved workspace. The existing bounded check lists the approved root and verifies a receipt; it does **not** read a file's contents or prove that a README was read. A model's reply alone, a saved app name or a local connection is insufficient.

Choose **Start using Farol** when all four steps have current checks. This opens Home. Home shows **Finish setup** until the four checks are current. Once ready, it shows connection status, **Check now**, any items needing attention and the latest activity with **Show all**.

The sidebar stays visible on every page, including Setup. Use **Collapse sidebar** or **Expand sidebar** (⌃⌘S, also in the View menu) to switch between icons and labels. Farol remembers this choice. Narrow windows show the icon rail automatically and restore labels when widened. Hover an icon for its name and state. Settings has its own **General**, **Appearance** and **Keyboard shortcuts** section list inside the page. Activity filters stay inside Activity.

## Chat conversations

Open **ChatGPT**, then choose **Chat conversations** in its toolbar. To start
with a typed message, choose **Check account**, review the signed-in account in
ChatGPT, and choose **Use this account and send** only for the account you intend
to use. A workspace-backed conversation requires a verified workspace with
read-only access: choose a text file, review its metadata, inspect and confirm
the account, then explicitly send. Opening this sheet never reads a file or
sends a message. If an outcome is unconfirmed, do not submit it again.

The same sheet offers **Load saved answers** for retained answers from an earlier
app session and **Stored replies** for recovery copies. These readers load only
on explicit action; saved answers cannot be continued here. Chat conversations
belong to the ChatGPT area and remain separate from Settings.

## Settings and support

**Settings → General** has the Setup status card and **Open Setup**, **Install updates automatically**, **Version**, **Check for updates**, **Update recovery…** for a recorded update, and **Save support file…**. Appearance and Keyboard shortcuts remain separate pages. Workspace access, commands and connection setup belong in Setup.

If an action's result is unconfirmed, choose **Review unresolved actions** in the sidebar to open **Unresolved actions**. This control appears only while something is unresolved. Inspect the original action and use **Refresh status** to observe available evidence. Existing workspace edits also offer **Observe existing edit** and, after review, **Record result delivery**; other actions do not gain operation readback from refreshing. Refresh, navigation and reopening a page do not repeat it or turn uncertainty into success. Do not re-enter the key, rerun the ChatGPT test or change the connection to obtain a green status while an earlier action remains unconfirmed.

For support, save a support file from General and attach it to a GitHub issue. The export excludes messages, keys and file contents.
