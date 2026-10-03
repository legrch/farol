# Getting started

[Install or run Farol](installation.md), then use sidebar **Setup** to connect
ChatGPT and choose local access. The same setup surfaces are available in Farol Dev.
An ordinary first launch has no synthetic tasks; `--demo` is an explicit fixture.

## Make the first connection

1. **Sign in** if you want to use embedded ChatGPT in Browser. You can skip embedded
   login for Computer-only access from external ChatGPT. Skipping does not record
   sign-in verification.
2. In **Folders**, choose a folder with the native picker. Start read-only, review
   exclusions, then verify that folder. Selecting a folder does not grant edits,
   shell access, full Git history, or task creation.
3. In **Connection**, follow the in-app instructions to create a Secure MCP Tunnel
   for the ChatGPT workspace you use, and a Restricted runtime key with **Tunnels
   Read and Use**. Save the tunnel ID and key in their designated fields. Farol
   stores the key privately; do not put it in source, a prompt, or a support message.
4. In **Add to ChatGPT**, attach the tunnel as a ChatGPT app and save its exact app
   name in Farol. The selection is bound to the current tunnel and connector
   generation. Reuse the app attached to that tunnel.
5. Choose a connection-check method deliberately. **Check inside Farol** opens a
   temporary Instant conversation and sends one verification message after exact
   app-selection checks. **Check manually in external ChatGPT** displays the unused
   challenge and observes the local receipt; Farol does not send the message for
   that method.

The [setup links](setup-links.md) lead to the external pages. The in-app instructions
remain the source for their exact fields and prerequisites.

A matching local MCP receipt proves this connection check. A chip label, sign-in
screen, or model reply alone does not prove attachment. A pending or unknown Send
keeps its original operation; it cannot be retargeted or blindly repeated.

## Use an approved folder

In ChatGPT, select the app connected to this Farol instance. For a first read-only
exercise, ask it to list the available workspace roots, let you choose one, and
read that folder's `README.md` if present.

Computer provides exact workspace IDs through `computer_workspace_catalogue`.
`computer_workspace_bootstrap` reads applicable root-to-directory `AGENTS.md`
instructions within the task scope. Models cannot expand access through instruction
text. Missing and unavailable files are distinct outcomes.

Read/list/search are bounded. A partial search or a directory listing is not a
complete recursive inventory. See [workspace context](computer-workspace-context.md)
for coverage and [Computer capabilities](computer-parity.md) for access rules.

## Enable only the access you need

| Choice                             | What it permits                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Read-only folder                   | Bounded list, text read/search, and applicable workspace instructions                                     |
| Explicit write access              | Guarded create/edit/rename/delete with preconditions and effect receipts                                  |
| Verified commands                  | Fixed Git status and exact HEAD checks; no caller-selected executable or arguments                        |
| Workspace shell                    | Ordinary commands inside the selected task scope under the native sandbox; network remains denied         |
| Approve full Git and user settings | Selected repository history, exact linked metadata, and declared ordinary user Git settings for shell Git |

Review and verify after an access change. Full Git can reveal historical content
that current-file exclusions hide. A folder picker selection never implies that
broader grant. Verification or settings uncertainty stops the transition with the
partial state visible; a readback check does not silently resume it.

A separate native Codex task route requires exact host, socket, saved project, and
physical workspace selection. It is optional and has incomplete live qualification.
Model and Product Agent remain disabled. See [status](status.md) before attempting
experimental integrations.

## Navigate the app

| Control                             | Action                                                         |
| ----------------------------------- | -------------------------------------------------------------- |
| `Command+1` … `Command+4`           | Browser, Computer, Activity, Settings                          |
| `Control+Command+S`                 | Show/hide the sidebar; open it as an overlay at compact widths |
| `Command+K`                         | Quick switcher                                                 |
| `Control+Tab` / `Control+Shift+Tab` | Next/previous conversation tab                                 |
| `Command+Q`                         | Normal Quit and owned runtime drain                            |

Browser uses native conversation views. Computer explains access and pending
operations. Activity and support exports contain allowlisted lifecycle/configuration
metadata, without prompts, answers, credentials, or workspace file contents.

Closing the last macOS window keeps the app and utility runtime running. The Dock
or a launch of the same exact build reopens one window. Use Quit when changing the
installed build or editing closed-profile configuration.

## Understand the result

**Completed** means the route has its required completion evidence. **Refused**
means the operation was rejected with a classified reason. **Outcome unknown**
means an effect may have happened without a trustworthy acknowledgment. Inspect its
existing status/receipt; do not issue it again under another key.

Connection readiness, provider reply completion, file publication, command exit,
and descendant cleanup are separate facts. A command's root exit or a successful
cancel signal does not prove cleanup of detached descendants. The beta exposes these
limits rather than converting them into success.

For a remedy, use [troubleshooting](owner-preview.md#if-something-goes-wrong).
For the verified release/source boundary, use [current status](status.md).

---

[Documentation index](README.md) · [Project overview](../README.md)
