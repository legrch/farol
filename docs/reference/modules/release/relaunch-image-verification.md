# Relaunch launch-image verification

The native execution runtime checks, after the one original `/usr/bin/open -a`
returns, that the process it started runs the image it verified. This is
**detection, not prevention**. The relaunch route stays unselected: boot installs
neither the self measurement nor the relaunch argument capability, the closed
helper still refuses relaunch requests, and the Python helper remains the
selected helper.

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

1. Before launch, the held verified application directory yields the expected
   identity: the SHA-256 (or SHA-1/SHA-384) digest of the best `CodeDirectory`
   from the executable's `LC_CODE_SIGNATURE`, truncated to 20 bytes, and the
   executable's device and inode. A universal binary resolves to the running
   architecture's slice. No `codesign` is run.
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

| Observation | Result |
| --- | --- |
| One candidate, hash and vnode match | success after one more held-tree check |
| One candidate, same mismatch seen twice at least 50 ms apart | `launch_image_mismatch`, definite; the exact pid is sent SIGKILL only if its birth time is still the observed one |
| Mismatch but birth time changed, process gone or kill failed | `launch_image_mismatch`, uncertain; nothing is killed unless the birth time matches |
| Mismatch that changes between observations (an exec still in progress) | keep polling; never killed unless it settles |
| Zero candidates by the cap or deadline | `launch_unverified`, uncertain; no kill, no retry |
| Two or more candidates | `launch_image_ambiguous`, uncertain; no kill |
| Deadline reached while polling | uncertain |

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
runtime, journal and tree verification. A golden test compares the Mach-O
cdhash parser with `codesign -d -vvv`, including a universal binary and a
two-hash signature. The native lane (`FAROL_RELAUNCH_NATIVE=1`) reads real
processes with the production kernel reads and includes a negative swap with an
unmutated control. It replaces only `open` with a direct exec of a scratch
executable, because the identity policy requires the production bundle id that a
running Farol also carries; LaunchServices is therefore not exercised by that
lane.
