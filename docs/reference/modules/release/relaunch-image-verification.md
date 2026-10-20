# Relaunch launch-image verification

The native execution runtime checks, after the one original `/usr/bin/open -a`
returns, that the process it started runs the image it verified. This is
**detection, not prevention**. The relaunch route stays unselected: the Python
helper remains the selected helper. The unselected live helper
(`run-live-release-helper`) now accepts `relaunch: true` for apply, where it
launches after `verified`, and for rollback, where it never launches (Python
parity); it alone installs the self measurement and the relaunch argument
capability. The closed helper supplies neither and still refuses relaunch; recover is
refused by both.

**Divergence from Python.** Python writes `completed` after `open` returns zero,
whatever started. This verification is strict: zero, ambiguous or mismatched
candidates are uncertain, the journal stays `launch_requested` and the helper
exits 79. That is deliberate, so an unverified launch is reconciled rather than
reported complete.

## Contract

The owner chose the cooperative-writer contract. A hostile process running as the
same user is out of scope: it can already act as the owner. In scope are
concurrent accidental writers and detection of a substituted launch image.

The launch is still by pathname. Between the held-tree check and the exec, a
writer can replace the bundle, and the substituted executable can run before the
mismatch is seen. This verification does not close that window and no document,
receipt or review may say it does. It narrows the outcome: a substitute is found,
contained when that is safe, and reported as a classified failure rather than as
a successful relaunch.

## Sequence

Everything runs inside the existing `launch:open` scope, under the same fence,
journal phase (`launch_requested`) and original deadline. There is no new phase,
no retry and no replay. A second launch attempt in the same scope is refused as
`recovery_attempt_unknown`.

1. Before launch, the expected identity is derived from descriptors that were
   pinned before the tree was verified. The executable (or, for the script
   launcher, the runtime executable it names) is opened without following links and without blocking (a FIFO or device substituted for it is refused from `fstat` before any read, never waited on)
   under the held application directory, and its identity is recorded. The tree
   verification then covers the entries those descriptors name. After it, the
   derivation proves that each descriptor still has the recorded device, inode,
   mode, size, mtime and ctime, that the name still resolves to the same object,
   and that it did not change while being read. Only then is the SHA-256 (or
   SHA-1/SHA-384) digest of the best `CodeDirectory` from the executable's
   `LC_CODE_SIGNATURE`, truncated to 20 bytes, computed from that descriptor,
   together with the device and inode. The executable is never reopened by name
   to read it, so a swap between verification and derivation is refused as
   `launch_image_unconfirmed` (uncertain once `open` has run). A universal binary yields the hash of every slice, and a live hash is accepted when it equals any of them: LaunchServices, Rosetta or a user preference chooses the slice, so none is assumed. Every slice is part of the verified bytes, so this does not weaken the file binding, which is checked separately by device and inode. No `codesign` is run.
2. `open` runs once. Its argument is the relaunch hint, which names the operation
   id and the helper pid and start, so it acts as a nonce for this launch.
3. The child is found by polling same-effective-user processes whose
   `kern.procargs2` argv contains the exact hint, for at most three seconds and
   never past the original deadline.
4. For exactly one candidate the kernel reports its cdhash
   (`csops(CS_OPS_CDHASH)`) and the vnode its text mapping came from
   (`proc_info(PROC_PIDREGIONPATHINFO)`: device and inode of the first executable
   file-backed region). The vnode is used because, unlike `proc_pidpath`, it does
   not follow a renamed path. The birth time comes from `kern.proc.pid`
   (microseconds).
5. On a match the held tree is verified once more, then the launch succeeds.

## Outcomes

| Observation                                                                               | Result                                                                                                                             |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| One candidate, hash and vnode match                                                       | success after one more held-tree check                                                                                             |
| One candidate, same mismatch seen twice at least 50 ms apart                              | `launch_image_mismatch`, definite; SIGKILL is sent to the exact pid only after the exit watch, birth-time and no-exit checks below |
| Mismatch but exit watch refused or fired, birth time changed, process gone or kill failed | `launch_image_mismatch`, uncertain; nothing is killed unless every containment check passes                                        |
| Mismatch that changes between observations (an exec still in progress)                    | keep polling; never killed unless it settles                                                                                       |
| Zero candidates by the cap or deadline                                                    | `launch_unverified`, uncertain; no kill, no retry                                                                                  |
| Two or more candidates                                                                    | `launch_image_ambiguous`, uncertain; no kill                                                                                       |
| Deadline reached while polling                                                            | uncertain                                                                                                                          |

### Binding the kill to the observed process

A pid alone does not name a process, and macOS has no `pidfd`. Before the kill,
the runtime therefore:

1. registers `EVFILT_PROC` with `NOTE_EXIT` for the pid on a private kqueue; if the
   process no longer exists, nothing is killed;
2. rereads the birth time, which must equal the one observed with the mismatch;
3. polls the kqueue with a zero timeout immediately before the signal; a pending
   exit means nothing is killed;
4. sends SIGKILL, and closes the kqueue on every path.

**Residual window.** Between the final zero-timeout poll and the kill system call
the target can still exit and its pid be reused by an unrelated process. That
needs a full pid wraparound inside that interval. The window is reduced, not
eliminated, which is consistent with detection rather than prevention.

**Authority.** Discovery can last seconds after the last operation fence. The
runtime's own fence (retained uncertainty, routes and the owner's reverification)
runs again when containment starts and immediately before the kill. A failing
fence means no kill and an uncertain result.

**Deadline.** The original deadline is checked again immediately before
containment starts and immediately before the kill. An observation that arrives
late, including a candidate scan that returns after the deadline, never leads to
a signal and leaves the outcome uncertain. The candidate scan stops between
processes once the context ends.

**Delivered signal only.** A kill that fails, including `ESRCH` (no signal was
sent), is an uncertain `launch_image_mismatch`. Only a delivered SIGKILL is
definite.

The retained launch image is never touched. The journal stays at
`launch_requested`.

The scope retains any failure after the launch as an unknown outcome, as it does
for every effect; the definite code is the method's own classification.

## What is bound

Bound: the main executable's code pages (cdhash) and the file they were mapped
from (device and inode). The package launcher is a shell script that `exec`s the
Electron runtime. When the only executable in `Contents/MacOS` is such a script
and names the runtime path, the expected identity is the runtime executable's,
because that is what the kernel reports after the exec.

Not bound: resources. The package is unsigned and its Electron executable carries
an ad-hoc signature that seals no resources, so `app.asar` and the rest of
`Contents/Resources` are outside the cdhash and stay bound only by the tree digest
checked before launch and again after discovery. Anything that ran between the
exec and the check has already run.

Developer ID signing with a designated requirement and sealed resources is the
later hardening step; it is not a precondition.

## Tests

Deterministic tests drive every branch through a private OS seam with the real
runtime, journal and tree verification. `milestonerelaunch_test.go` runs
`Milestone.Execute` through apply, relaunch and verification (completion, clean
launch failure, uncertain verification that never completes, rollback that never
launches, and refusal without capabilities); boot wiring tests cover which
capabilities each helper carries. A golden test compares the Mach-O cdhash parser
with `codesign -d -vvv`, including a universal binary and a two-hash signature.

The native lane (`FAROL_RELAUNCH_NATIVE=1`) reads real processes with the
production kernel reads and includes a negative swap with an unmutated control. It
replaces only `open` with a direct exec of a scratch executable, because the
identity policy requires the production bundle id that a running Farol also
carries; LaunchServices is therefore not exercised by that lane.
`TestNativeMilestoneRelaunchEndToEnd` in the same lane drives `Milestone.Execute`
end to end (a real apply, then the relaunch) over scratch bundles, with a
swapped-bundle negative that must not complete.

Not covered: the real LaunchServices `/usr/bin/open`, a shared install end to end
(it needs a root-owned Applications parent), and any packaged or installed run.
The whole Go helper path is unselected; the desktop still spawns the Python helper.
