# Relaunch image verification

The native execution runtime relaunches the installed image after a verified
update the way Sparkle and Squirrel.Mac do: verify the update before install,
replace it atomically through a helper, ask LaunchServices to open the result,
and report done. The owner chose this model (Brain 04 §6: copy best practice,
invent nothing). The desktop selects this route: its updater spawns the Go helper
entries and never falls back to Python (`update_helper.py` stays shipped under the
[bridge rule](../../../installed-update-helper.md#retiring-the-python-helper-bridge-rule)). The live helper (`run-live-release-helper`)
accepts `relaunch: true` for apply and for recover, where it launches after
`verified` only, and for rollback, where it never launches (Python parity); it
alone installs the self measurement and the relaunch argument capability. The
closed helper supplies neither and still refuses relaunch and recover; offline
recover (`relaunch: false`) is refused by both.

The helper retains the existing terminal contract: a zero exit from
`/usr/bin/open` moves the journal to `completed`. This is not proof that a new
GUI primary started. Installed acceptance must separately observe the successor
process, canonical bundle path, Dock identity and ordinary Quit/reopen.

## Sequence

Everything runs inside the existing `launch:open` scope, under the same fence,
journal phase and original deadline. There is no retry and no replay. A second
launch attempt in the same scope is refused as `recovery_attempt_unknown`.

1. The Milestone proceeds only from `verified`, with the target tree verified
   again through held descriptors.
2. The target remains in its permanent shared or owner-home Applications slot.
   No new private GUI capture is created.
3. The journal moves to `launch_requested`, and the helper measures itself.
4. `LaunchTarget` verifies the accepted tree, the installed executable
   signatures and the held/named slot identity, then checks that the arguments
   name exactly that permanent slot (`launchBound`). Any other path refuses.
5. `/usr/bin/open -a <slot> --args <hint>` runs once. The hint names the
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

The owner chose the cooperative-writer contract. Other Farol installation
writers are in scope and must obey the existing update lock, promotion lease
and journal fences. A separate actor able to replace the shared Applications
entry without those locks is outside this unsigned distribution's
execution-authenticity guarantee, whether its action is deliberate or accidental.

The launch is by pathname, like the Python reference helper. Between the final
held-tree check and LaunchServices resolving the path, a same-user writer could
replace the bundle (copying is not a same-user exclusion boundary, see
[install namespace](install-namespace.md)). This runtime cannot atomically bind
the pathname to the earlier verified vnode, and no document, receipt or review
may say it does. It also
does not check, after `open` returns, that the process that started runs the
verified image.

The updater checks the exact accepted tree and the signatures of the installed
Go and Electron executables. These checks do not close the pathname race or
establish Developer ID identity for the unsigned outer bundle. Actors capable
of replacing the installation namespace after the final check are outside the
current unsigned distribution's execution-authenticity guarantee. Future
Developer ID adoption needs an explicit designated requirement and system
assessment contract; signing alone does not imply that LaunchServices enforces
the expected Farol Team ID.

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
