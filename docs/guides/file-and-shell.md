# File and Shell operations

Use only capabilities exposed by the connected Farol build. A permission setting, source adapter or native test does not establish that an operation is available through your installed ChatGPT connection. [Current status](../reference/status.md) records that distinction.

## Read files

With a checked workspace and attachment, ask ChatGPT to list, search or read within the approved folder. Start with [the sample exercise](../start/first-workspace.md). Review the returned scope and any classified error. Unavailable access is not an empty result.

File contents returned through Farol go to ChatGPT. Do not request secrets or approve a broader folder just because a file was refused. Binary files and PDF transfer are not a promised part of the current public File journey.

## Make guarded file changes

Choose **Read & write** for the intended workspace only when you want changes. File changes still require approval. Farol's guarded write/edit path binds the request to an operation identity and, where required, the exact source digest. Review the target and requested change before approval, then inspect the returned result and file.

A refused change, a conflict and an unknown outcome are different results. If Farol cannot confirm whether a change happened, inspect that original operation and the file before any further action. Do not repeat the same change under another operation ID. Recovery may need a retained `.farol-stage-*` directory; do not delete it simply to clear an error.

Installed beta evidence covers catalogue/bootstrap, reads and specific guarded create/edit journeys. It does not qualify every file operation on every later build. [The Computer reference](../computer-parity.md) retains the exact evidence.

## Shell and ordinary Git

The public [v0.2.3 notes](https://github.com/legrch/farol/releases/tag/v0.2.3) describe packaged Shell preparation fixes and native tests for ordinary Git. Current source includes a build-selected Shell route. A successful external ChatGPT-to-installed-Shell/Git journey remains unqualified in this audit, so this guide provides no claimed supported command exercise.

For a future accepted route, review the selected workspace's command access and full Git/user-settings approval before use. Those grants can expose repository history, linked Git metadata, hooks and ordinary user Git configuration. They are separate from file read/write access. Networking is a separate authority boundary; neither a folder grant nor ordinary local Git establishes Git SSH or remote push support.

Command output, cancellation and root-process exit must be interpreted through the exact operation status. Sending a cancellation signal alone does not prove that all descendants stopped. If a command outcome is unknown, preserve its original identity and inspect it; do not start a replacement executor.

## Other workflows

Tasks, Product Agent and Agent workflows require their own activation and installed/live acceptance. Their source contracts are [technical references](../reference/README.md), not a user procedure for this public beta. Git SSH and PDF/binary preview or transfer are also outside the shipped-capability claim.

[User guides](README.md) · [Folder access](folder-access.md) · [Recovery](recovery.md)
