# Connect Farol to ChatGPT

Open **Setup** and follow **Overview → Sign in → Workspaces → Connection → Add to ChatGPT**. Sign-in inside Farol is optional when you use external ChatGPT. Use **Continue** and **Previous**, or select a section directly; the last section offers **Review setup** to return to Overview. Entering Sign in may observe its existing page. Navigation does not save settings, change access or connection bindings, verify a step, or replay an action. Opening **Connection guide** or **Open connection guide** is read-only help.

## Overview: fresh and returning profiles

For a fresh profile, use the fresh setup instructions below to approve and verify a workspace, configure the local connection, and check its attachment in ChatGPT. Embedded sign-in is optional.

For a returning or partially configured profile, review the saved workspace, connection and current checks. Keep saved credentials unless they need to change. Continue through sections whose checks are current; complete only the unfinished steps. Reviewing Setup does not reset the profile or repeat an earlier action.

The overview distinguishes **Not checked**, **Check in progress**, **Result needs review**, **Status unavailable** and **Verified**. Treat each as its actual result. **Open Home** appears only when the required workspace, local connection and external attachment checks are current and Computer is ready; optional sign-in can remain unchecked.

## Sign in (optional)

Entering this step observes the existing embedded page without opening it or changing settings. **Signed in** means the current page was observed; choose **Continue**. Otherwise, choose **Sign in** to use your own account inside Farol, or **Skip for now** to proceed without this optional step for external Computer access. Returning from the sign-in window observes the page again. Opening sign-in alone does not confirm authentication; signing in does not approve workspaces or prove an external connection.

**Checking sign-in…** is a bounded read. **Signed out** or **Current sign-in is unknown** is not an authenticated result. Saved account settings alone do not establish a current check. The normal wizard offers one Sign in action rather than a separate Open/Check sequence. Original **Outcome unknown** remains unresolved even after a page observation: review the existing result in Diagnostics and do not repeat sign-in. Leaving and returning to this step obtains a new page observation; a refresh or renderer remount does not replay an action.

## Workspaces

For fresh setup, choose **Add workspace…**, select a folder, then confirm **Add selected workspace read-only**. Picking a folder alone does not approve access. Review its saved path in the approved list, then choose **Verify workspace** when offered.

For a returning profile with a current verified workspace, Setup shows its path, **Saved access** and **Access checked**. It says **Current workspace for Connection. Access is checked for this build and saved scope. Continue when ready.** Use **Continue** without re-verifying. **Verify workspace** is hidden while that workspace is current and no action is paused. **Edit** is secondary and opens access controls only when you intend to change them.

Select an approved workspace and review **Saved access**. In Setup, choose **Edit** to open **Workspace access**, then choose **Read-only** or **Read & write**:

- **Save** submits a changed access choice. Read & write allows guarded changes that still require approval; it does not establish unrestricted execution. Verify access again after a confirmed save.
- **Cancel** discards the unsaved access draft. A refused or unknown save retains its draft; cancelling that draft does not undo an operation already submitted or resolve uncertainty.
- **Remove** opens a confirmation beside that workspace. **Confirm removal** revokes Farol access and keeps the files on disk. **Keep workspace** dismisses the confirmation without submitting removal.

When a workspace check is needed, choose the offered **Verify workspace** with no access draft or removal confirmation open. It checks the current Connection workspace without changing its binding, or checks another selected workspace and prepares it for Connection. Selection alone does not choose the Connection workspace. A saved workspace or stale check alone is insufficient for **Access checked**.

Changes may be paused while another dependent action is pending or uncertain. If a coding task is using the workspace, wait for it to finish. When the connection is running, adding a workspace, saving access or confirming removal uses one admitted action to drain that connection and apply the original change. Wait for its result; a manual Diagnostics stop or a second submission is not required. After a confirmed change, verify the selected workspace and use the offered Connection control if it needs to reconnect. The saved key remains saved.

An unconfirmed drain or change is not success and does not authorize another stop or submission. Inspect the original result in **Workspace diagnostics**. A stale draft requires cancellation and review of the saved workspace first; cancelling it does not settle an already submitted action.

## Connection

Use the tunnel belonging to the ChatGPT workspace you intend to connect. Keep **Farol Dev** and production **Farol** on their respective tunnels and profiles. A display name does not select an environment. Reuse the existing ChatGPT app attached to the selected tunnel; do not duplicate it or move credentials just to change a name.

For an unconfigured connection, open [Organization tunnels](https://platform.openai.com/settings/organization/tunnels), create a tunnel associated with your ChatGPT workspace if needed, and obtain a Restricted runtime key scoped to **Tunnels Read and Use** only. Enter its **Tunnel ID** and **Runtime key** in Farol, then choose **Save & connect** once. Follow field validation and any pause message.

The saved key is never read back into the form. **Show runtime key** and **Hide runtime key** affect only the local draft you entered. Submission clears that field; **Cancel** clears the draft and restores the saved Tunnel ID. On a returning profile, **Tunnel credentials saved** means you can keep the saved key. Use **Edit connection** only when details change.

| Result                                                     | What to do                                                                                    |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Connection started**                                     | Local setup succeeded. Continue to Add to ChatGPT for external verification.                  |
| **Credentials saved**, but the connection did not complete | Keep the saved key. Review the connection result before another action.                       |
| Unconfirmed or unknown result                              | Inspect the original result in Diagnostics. Do not submit the key or connection action again. |
| Refused request                                            | Review the reason and saved state. Do not assume nothing took effect or blindly repeat it.    |

For a returning profile, review the displayed connection status and use **Continue** when its check is current. **Edit connection** is for changed details; **Check connection** is an explicit local health check, not a required action merely because you reopened Setup. If attention is needed, use the offered control for the current state: **Find connection helper**, **Verify a workspace**, **Connect this Mac**, **Reconnect** or **Check connection**. Helper discovery must confirm a usable helper; local health checks do not establish ChatGPT attachment. For missing or incompatible helpers, review **Connection help → Connection diagnostics** rather than treating discovery as success. Saved credentials and navigation do not establish transport recovery.

## Add to ChatGPT

For fresh or unfinished attachment, follow the current instructions and use only the request available for this connection:

1. Use **Open Tunnels** to review the selected tunnel. In the intended external ChatGPT workspace, enable Developer mode and open [ChatGPT connectors](https://chatgpt.com/plugins). Reuse the app already attached to that tunnel; if none exists, add a connector using the Tunnel connection type and that tunnel. Select the matching Farol Dev or Farol connector in your conversation.
2. Choose **Copy verification request** when the current request is available. Paste and send it yourself in ChatGPT, once. Copying does not send a message. If copying fails, open **Technical details** and select the current request manually. It checks the approved workspace and returns counts without file names or contents.
3. Return to Farol and choose **Check attachment** to inspect and record the matching local verification receipt. This action does not send another ChatGPT message.

For a returning profile with **Attachment checked · Computer ready**, Setup says **The retained attachment check matches this build, connection and workspace. Continue to review setup.** Choose **Review setup** to return to Overview. The first-time attachment instructions, **Copy verification request** and **Check attachment** are hidden for this current checked state; do not resend verification or repeat the check simply to advance. **Open Tunnels** and **Open connection guide** remain available as help.

**Connected to this Mac · ChatGPT check needed** confirms only the local connection. A provider reply, connector name or successful copy is insufficient. **Attachment checked · Computer ready** requires current workspace and attachment evidence for this connection. A missing request or unavailable control requires review of current status, not reuse of an old request.

For pending or unknown outcomes, open **Connection help → Connection diagnostics** or **Workspace diagnostics**, review **Actions needing observation** and **Action details**, and use **Refresh status** to observe current state. Retained results survive page navigation within the window; refresh does not replay an action or settle an unknown outcome by itself. Do not resend verification, replace credentials, retarget the connection or repeat an uncertain action to obtain a green status.
