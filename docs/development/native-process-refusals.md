# Native process refusal investigation

This source investigation addresses intermittent `PROCESS_NATIVE_REFUSED` reports
from installed 0.5.23. It uses the selected source baseline
`03397151d15543d1ad894292d66c4de1dc701d42`, CPU doubles and disposable test state.
It does not inspect an installed profile, run a command in an owner workspace,
launch Farol, or establish the exact historical cause.

## Resolution and launch

`boot/connectorshell.go` selects the attested `/bin/bash` pin, binds the selected
workspace/root identity and cwd, and supplies `--noprofile --norc -c` with the
requested command. A tool request cannot select an executable, environment or
root. `DiscoverInstalledHostRuntime` runs read-only discovery, without version
probes or shell startup files. Its Git candidates, in order, are:

1. `/Library/Developer/CommandLineTools/usr/bin/git`
2. `/Applications/Xcode.app/Contents/Developer/usr/bin/git`
3. `/opt/homebrew/bin/git`
4. `/usr/local/bin/git`

See `hostRuntimeCandidates`, `discoverHostRuntime` and `hostRuntimeLayoutFor` in
`modules/computer/infra/process/host.go`. A qualified physical installation
contributes its bin directory before the fixed base executable directories in
`seatbeltEnvironment`. Therefore ordinary `git` resolves to the first qualified
installation, not automatically Homebrew or the `/usr/bin/git` Apple shim. If no
optional installation qualifies, the base PATH remains; an available base
`/usr/bin/git` may resolve there. There is no command-specific lookup performed
by the Go process adapter. The incident's selected physical Git cannot be known
without its original runtime plan; source alone does not prove that selection.

The environment is explicitly constructed, never inherited. Root-scoped mode
sets HOME, scratch TMPDIR, XDG_CONFIG_HOME, ordered PATH, LANG/LC_ALL,
`GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0` for read-only work. Installed
host runtime adds pinned Git exec/template paths when available, disables system
Git config/attributes, and disables Python bytecode/user-site loading. Global Git
settings require the existing approval; otherwise global config is disabled.
No environment values are added to refusal diagnostics.

Seatbelt remains the enforcement boundary. The compiler seals exact roots,
image/resource access, credential exclusions, no-network authority and mount
denials. The retained watchdog starts only after qualification and current-owner
checks; its private protocol prepares the wrapped `/usr/bin/sandbox-exec` command
and requires another measurement/qualification/owner check before release.

## Checks before a user command can start

The following can refuse the original preflight. Several repeated checks retain
their original order and one-attempt lifecycle:

- Selected invocation, callback/context availability, original lease deadline,
  sealed command/profile and exact environment (`process.go`, `watchdog.go`,
  `confinement.go`). Admission and durable reservation failures may instead use
  their existing distinct public codes.
- Support compiler/OS build/architecture, owner UID, current backend identity,
  fixed executable/import pins and protected bundle (`platformqualification.go`).
- Root and scope approval, frozen mount topology, APFS/local/root-volume class,
  no unsupported nested mounts, exact root/cwd/scratch/protected-state identities
  (`platformqualification.go`, `mountboundaries.go`, `measurement.go`).
- Descriptor-relative directory opening, no symlink substitution, cwd containment,
  scratch mode/owner and unchanged protected directory facts (`measurement.go`,
  `measuredarwin.go`).
- Image canonical path, regular/executable file, owner, non-writable mode,
  permitted link count, size, SHA-256 and unchanged descriptor/named identity
  (`spawn.go`, `measuredarwin.go`). Hardlink-policy failures are executable
  integrity failures; the closed classification contains no file name.
- Entire selected installed Git/Python inventory, aliases, imports, directory
  listings and metadata; or the separately qualified Git resource closure
  (`hostruntime.go`, `hostruntimedarwin.go`, `gitruntime.go`).
- Watchdog image pin, socket-pair creation, IPC connection setup and final current
  owner check (`watchdogdarwin.go`, `watchdog.go`).

The direct adapter's OS `cmd.Start` error and any possible-start watchdog/IPC
failure are already outcome unknown. A post-release sandbox denial, Git exit or
xcrun behavior cannot by itself explain a _known preflight_ native refusal. Null
journal timing alone is not a native no-spawn witness; the native classification
provides that distinction. This change preserves every unknown outcome.

## Most likely hypothesis and confirmation

The strongest source-based hypothesis for intermittent refusal is **installed
runtime inventory drift between discovery and preflight recheck**. Confidence in
this mechanism is high; confidence that it caused these eight historical events
is low without a captured reason. `HostRuntimePlan.recheck` compares every frozen
node, including directory mtime/ctime, size/link metadata and selected listings.
The physical-path walk also captures installation ancestors. A concurrent tool
update, Python cache/directory change or installation ancestor change can invalidate
the snapshot while leaving the requested `git status` itself unchanged. This is
not a command-specific admission distinction: selected Python is measured even
for a Git-only shell command. CPU tests demonstrate metadata drift refusal.

Other live-dependent candidates are root/scratch identity or privacy drift,
mount topology drift, support/image changes, read/descriptor errors, and loss of
the original authority/deadline while measurements run. Permanent selection or
profile mismatch would ordinarily be deterministic. The reported 1–1.5 seconds
is compatible with preflight measurement but identifies none of these checks.

No confinement or launch-policy fix is justified by the available evidence.
Ignoring mutable inventory or directory metadata could conceal an unsafe
replacement, so this milestone changes diagnostic propagation only. The next
`runtime_integrity` refusal would support the leading hypothesis; it would not
identify the exact changed file or distinguish drift from a read failure.
`workspace_root_identity`, `cwd_fence`, `filesystem_policy`,
`executable_integrity`, `directory_policy`, `helper_preflight` or
`admission_policy` would redirect the investigation to the corresponding stage.
A narrow follow-up can split that stage into additional closed, path-free
measurement classes if necessary. No retry or broader permission follows from
any reason.
