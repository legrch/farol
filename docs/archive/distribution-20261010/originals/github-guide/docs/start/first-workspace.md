# Read your first workspace

Read one known file through your approved Farol connection and compare the answer
with its contents. This exercise uses a small folder you create yourself.

**Before reading:** [connect ChatGPT](first-connection.md) and observe its matching
connection receipt. This is a suggested live exercise, not a claim that account
and provider acceptance has been completed for every beta user. You can prepare the
small folder below before connecting.

## Prepare a small folder

In Finder, create a new empty folder named `FarolExample` in a location you choose.
If that name already belongs to another project, use a different empty folder.

Create a plain UTF-8 file named `README.md` inside it. In TextEdit, choose
**Format → Make Plain Text** and save these contents:

```markdown
# Farol Example

This folder is for my first read-only Farol session.

Project goal: learn how approved workspace access works.
```

**Check:** Finder shows the folder and file. Opening the file shows this text,
without a hidden `.txt` extension or rich-text formatting.

## Approve this folder

In Farol's **Setup → Folders**, select the physical folder with the native picker.
Keep it **Read only**, review exclusions, and verify access on the current build.
You do not need write or shell access for this exercise.

**Check:** this folder has current verification evidence. A picker selection alone
is not the completed access check.

## Read your example

In ChatGPT, select the app connected to this Farol instance. Ask:

> List the workspaces available through Farol. Use only my FarolExample workspace,
> read its README.md, and tell me the project goal. Do not edit files or run commands.

If you chose another folder name, use that name in your request. Let ChatGPT obtain
the actual workspace ID from Computer; do not invent an ID or paste a private path.

**Check:** the answer identifies the goal you wrote: learn how approved workspace
access works. Inspect any available tool result and compare the answer with the
local file. A plausible answer without a completed read is insufficient evidence.

If the folder or file is unavailable, use [folder troubleshooting](../guides/troubleshooting.md#folder-access-is-refused).
If a read has an unknown outcome, inspect the existing operation rather than
issuing it again under another key.

## What to notice

ChatGPT works inside the approved scope. Applicable `AGENTS.md` instructions can be
read, but they cannot enlarge that scope. A bounded read or search also does not
promise a complete recursive inventory.

You now have a concrete reference point for later work: a known folder, known
contents, and the evidence from a real read on your account.

## Next

Learn how to [change folder access](../guides/folder-access.md), keep the
[keyboard shortcuts](../reference/shortcuts.md) handy, or read
[how workspace context is built](../reference/computer/workspace-context.md).

---

[Start](README.md) · [Documentation](../README.md)
