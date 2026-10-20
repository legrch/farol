# Relaunch image verification

The native execution runtime relaunches the installed image after a verified
update the way Sparkle and Squirrel.Mac do: verify the update before install,
replace it atomically through a helper, ask LaunchServices to open the result,
and report done. The owner chose this model (Brain 04 §6: copy best practice,
invent nothing). The desktop selects this route: its updater spawns the Go helper
entries and never falls back to Python (`update_helper.py` stays in the tree
until a deletion packet). The live helper (`run-live-release-helper`)
accepts `relaunch: true` for apply and for recover, where it launches after
`verified` only, and for rollback, where it never launches (Python parity); it
alone installs the self measurement and the relaunch argument capability. The
closed helper supplies neither and still refuses relaunch and recover; offline
recover (`relaunch: false`) is refused by both.

This matches the Python helper: a zero exit from `/usr/bin/open` is the end of
the helper's work and the journal moves to `completed`. Nothing looks for the
launched process afterwards. An earlier revision (PR #57) added a post-launch
check that located the child, compared its kernel code-signing identity with the
verified image and killed a mismatch. It was removed as more machinery than the
industry model uses, with no behavior left that depends on it.

## Sequence

Everything runs inside the existing `launch:open` scope, under the same fence,
journal phase and original deadline. There is no retry and no replay. A second
launch attempt in the same scope is refused as `recovery_attempt_unknown`.

1. The Milestone proceeds only from `verified`, with the target tree verified
   again through held descriptors.
2. For a shared install the verified image is copied into a private capture
   (`launch-Farol.app`) under the operation directory and verified again. A slot
   install launches the owner's `~/Applications/Farol.app`.
3. The journal moves to `launch_requested`, and the helper measures itself.
4. `LaunchTarget` verifies the image once more under the fence (the private
   capture's identity for a shared install), then checks that the arguments name
   exactly that image (`launchBound`): the capture, or the owner's slot. Any
   other application path refuses before the effect.
5. `/usr/bin/open -a <image> --args <hint>` runs once. The hint names the
   operation id, action, build and this helper's pid and start, with phase
   `completed`. The image is verified again from the open's fence callbacks.
6. A zero exit journals `completed` and the helper exits 0.

## Outcomes

| Observation                                           | Result                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| `open` returns zero                                   | journal `completed`, exit 0                                                  |
| `open` returns a clean nonzero status                 | `launch_failed`, phase `launch_requested`, exit 70, nothing retained         |
| Timeout, lost fence, unclean child or unknown outcome | uncertain; the journal stays `launch_requested`, exit 79, no retry           |
| Image or arguments fail the checks before `open`      | refused before the effect (`tree_mismatch`, `launch_image_unconfirmed`, ...) |
| Rollback, cancelled or any non-`verified` outcome     | never launches                                                               |

## Contract and limits

The owner chose the cooperative-writer contract. A hostile process running as the
same user is out of scope: it can already act as the owner. In scope are
concurrent accidental writers.

The launch is by pathname, like the Python reference helper. Between the final
held-tree check and LaunchServices resolving the path, a same-user writer could
replace the bundle (copying is not a same-user exclusion boundary, see
[install namespace](install-namespace.md)). This runtime neither narrows nor
widens that window, and no document, receipt or review may say it does. It also
does not check, after `open` returns, that the process that started runs the
verified image.

Protection against a substituted image is the later Developer ID signing step:
a designated requirement and sealed resources let the operating system itself
refuse a mismatched executable. That step is not a precondition for this
relaunch.

## Tests

Deterministic tests drive `Milestone.Execute` through apply, relaunch and
recover over the real runtime, journal and tree verification, with only
`/usr/bin/open` replaced by a private seam (`Config.open`): `open` exit zero
completes (journal `completed`), a clean nonzero open is `launch_failed`, an
unknown open outcome never completes, rollback never launches, a recovery
relaunches only after it settled `verified`, missing capabilities refuse before
`open`, and `launchBound` rejects any other application path. Boot tests cover
which capabilities each helper carries and the terminal line and exit code of
each result.

The native lane (`FAROL_RELAUNCH_NATIVE=1`) runs the same Milestone end to end
over scratch bundles on the real filesystem (a real apply, then the relaunch),
replacing only `open` with a direct exec of the installed scratch executable,
because the identity policy requires the production bundle id that a running
Farol also carries. LaunchServices is therefore not exercised.

Not covered: the real LaunchServices `/usr/bin/open`, a shared install end to
end (it needs a root-owned Applications parent), and any packaged or installed
run. The whole Go helper path is selected by the desktop with no Python fallback;
these gaps are acceptance gaps, not a different route.
