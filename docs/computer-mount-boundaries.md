# Shell mount boundaries

The supported native class remains `local-apfs-no-nested-mounts-v1`.
A local APFS approved root can contain NFS, devicefs or another mounted volume.
An unsupported root now refuses during preparation, before execution reservation,
with `PROCESS_FILESYSTEM_UNSUPPORTED`. That known refusal starts no helper and
must not leave the connector waiting for a nonexistent child during Quit/update.
The original operation remains non-replayable. Start still repeats the native
checks against the same sealed invocation and original deadline.

## Rejected static-denial experiment

Native macOS testing on 12 October 2026 used disposable disk images and synthetic
files. The installed application, owner permissions and existing volumes were
unchanged. The experiment measured mount names before sealing, denied their
subtrees and checked the same list again before execution.

- Existing mounted subtree: read/write/exec returned permission denial through
  its direct name, APFS Data spelling and a symlink.
- A new volume mounted after the confined helper was ready: read and write were
  allowed. Execution was unconfirmed; the ordinary executable positive control
  also failed, so no positive execution conclusion is supported.
- A separate native sandbox-extension experiment likewise allowed a read from
  a newly mounted volume after the helper became ready.

These are negative qualification results. Neither path denials nor a directory
sandbox extension establishes a continuous filesystem boundary. Polling topology
and stopping a process afterward cannot undo an access already completed.
The experimental implementation and raw native observations are retained privately;
the production constructor has no newly admitted filesystem class.

A future implementation must demonstrate kernel enforcement for late mounts,
replacement mounts, aliases and symlinks, alongside ordinary local read/write/exec
and read-only controls. Pre-launch snapshots alone cannot qualify that claim.
Do not release support for nested mounts or describe installed Bash/Git as accepted
until those tests and the real external Computer journey pass.
