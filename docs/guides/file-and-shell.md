# File and Shell operations

Use only capabilities exposed by the connected Farol build. A permission setting, source adapter or native test does not establish that an operation is available through your installed ChatGPT connection. [Current status](../reference/status.md) records that distinction.

## Read files

With a checked workspace and attachment, ask ChatGPT to list, search or read within the approved folder. Start with [the sample exercise](../start/first-workspace.md). Review the returned scope and any classified error. Unavailable access is not an empty result.

File contents returned through Farol go to ChatGPT. Do not request secrets or approve a broader folder just because a file was refused. Binary files and PDF transfer are not a promised part of the current public File journey.

## Make guarded file changes

In **Setup → Workspaces**, choose **Read & write** in the intended row's **Access** control only when you want changes. File changes still require approval. Farol's guarded write/edit path binds the request to an operation identity and, where required, the exact source digest. Review the target and requested change before approval, then inspect the returned result and file.

A refused change, a conflict and an unknown outcome are different results. If Farol cannot confirm whether a change happened, inspect that original operation and the file before any further action. Do not repeat the same change under another operation ID. Recovery may need a retained `.farol-stage-*` directory; do not delete it simply to clear an error.

Installed beta evidence covers catalogue/bootstrap, reads and specific guarded create/edit journeys. It does not qualify every file operation on every later build. [The Computer reference](../computer-parity.md) retains the exact evidence.

## Shell and ordinary Git

A qualified internal installation has completed real ChatGPT → Farol → native Git commits with an unchanged symlinked `commit-msg` hook using an `env`/Python shebang. Controlled fixtures separately verify accepted and rejected commits, normal configuration, system attributes and linked worktrees. Check [the exact installed build and limits](../reference/status.md); the older public download does not inherit this evidence.

Before using commands, review the selected workspace's command access and Git/user-settings approval. Those grants can expose repository history, linked Git metadata, hooks and ordinary user Git configuration. Command access is separate from file read/write access, and executable/interpreter resources must be qualified.

For an authorized repository, begin by asking ChatGPT to run `git status` through Farol. Before a commit, inspect staging again, identify the exact intended paths, and retain the normal hooks and configuration. A hook rejection is a real failure to correct, not permission to bypass the hook. A successful selected Python hook does not authorize arbitrary interpreters or every project's toolchain.

The current generic Shell has no network authority and does not select SSH. Fetch, pull and push require a separate explicitly authorized transport capability; local command grants do not provide it.

Command output, cancellation and root-process exit must be interpreted through the exact operation status. Sending a cancellation signal alone does not prove that all descendants stopped. If a command outcome is unknown, preserve its original identity and inspect it; do not start a replacement executor.

## Other workflows

Tasks, Product Agent and Agent workflows require their own activation and installed/live acceptance. Their source contracts are [technical references](../reference/README.md), not a user procedure for this public beta. Git SSH and PDF/binary preview or transfer are also outside the shipped-capability claim.

[User guides](README.md) · [Folder access](folder-access.md) · [Recovery](recovery.md)
