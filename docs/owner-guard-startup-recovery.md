# Owner guard startup recovery

The owner guard fingerprints protected installation paths before and after a
wrapped command. It is an integrity check, not a sandbox. Existing protected
roots, profile allowances and narrow runtime churn exclusions remain in force.

## Filesystem objects

- Inspect with `lstat`. Symlink targets are fingerprinted without following them.
- FIFO, socket and device nodes are never opened as streams. Their device/inode,
  type, permissions, ownership, rdev, size, mtime and ctime form the fingerprint.
  atime is excluded because observing an ordinary file can update it.
- Open regular files with `O_NOFOLLOW`, `O_NONBLOCK` and `O_CLOEXEC`, then require
  a regular descriptor with the same metadata. Read at most 4 MiB plus an EOF
  check, in chunks no larger than 64 KiB. Recheck descriptor and path metadata.
- Larger regular files retain the existing bounded metadata policy, strengthened
  with identity and mutation metadata. This is not a full content hash of large
  files. Directory symlinks remain visible without recursive traversal.
- An interruptible content open has a five-second SIGALRM deadline. A blocked
  or unavailable deadline fails before command spawn. POSIX/Darwin does not
  provide an atomic regular-only content open: a device substituted after lstat
  can reach open, but is rejected by fstat before any stream read. This does not
  prove absence of driver-side open effects or bound uninterruptible kernel I/O.
  Device-race atomicity remains a stated platform limit, not a passed guarantee.
  Apple XNU's [vnode open implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/vfs/vfs_vnops.c)
  invokes the vnode open operation; `O_EVTONLY` is not used as an invented
  regular-only filter. No live devices are opened to test this limit.
- Unreadable or unstable objects fail with an explicit incomplete verification.
  Do not ignore protected tmp/runtime trees or retire live fixtures to get PASS.

## Cancellation

SIGINT and SIGTERM during preflight terminate with 130 or 143 and no command
spawn. A short POSIX signal-mask section protects child publication; the original
mask is restored before child exec. Signals pending before this section prevent
spawn; signals received during spawn are relayed to the exact published child.
Foreground SIGINT continues to reach the child through its process group.
SIGTERM sent to the guard is forwarded to the child. The guard waits for the
actual child exit and then verifies protected state.

Postflight cancellation reports the observed child exit and incomplete
verification. It cannot yield a successful guard result. Ordinary child exits
and signal exits remain observable. No global process kill or detached cleanup
facility is added by this fix.

## Verification and candidate boundaries

`tests/integration/owner-protection.test.mjs` uses disposable HOME only. A native
Node supervisor owns an isolated fixture process group; fixture children must
not escape that group. At the five-second deadline it signals only that owned
group and observes actual root termination and group absence. Pipe EOF and group
cleanup each have an additional two-second bound. Unverified cleanup retains
HOME and fails the test; signal delivery alone is never cleanup PASS. External
preflight cancellation tests correlate the readiness PID and reap the same
owned process; no application child may create its marker. Race tests deliberately
replace regular objects with FIFO, symlink or a different regular inode.
Socket/device classification tests use metadata fixtures, not live device reads.

Focused fixtures do not prove native launch, installed parity or connector
acceptance. Preserve the original failed launch receipt and reconcile its native
processes separately. Any guard source change requires a new committed exact
candidate through `task package`; do not patch the frozen package or invoke its
binary to bypass `task run`. Required gates and earlier platform refusals remain
separate requirements.
