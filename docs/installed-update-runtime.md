# Installed updater lifecycle

The updater is enabled only for the exact installed Farol Next Preview slot and
its existing owner data directory. Temporary `task run` copies do not update the
installed app. The GitHub channel and package identity are fixed by the release
contract; no source checkout, credentials or local diagnostics are published.

Electron's ASAR filesystem must not reinterpret release bytes. The desktop copy
port uses Electron's `original-fs`, and trusted verifier/readback subprocesses use
`ELECTRON_RUN_AS_NODE=1` plus `ELECTRON_NO_ASAR=1`. The ordinary application keeps
its normal filesystem semantics.

A durable ready record binds the verified archive to an operation before helper
dispatch. Only the helper's exact readiness acknowledgment permits normal Quit.
Unknown acknowledgment or completion never permits another apply. The same child
handle remains observable while the original app is alive.

At startup the updater reads the same operation journal and measures the current
slot and predecessor/staged/failed pair. It does not launch a helper while
rendering or silently download a replacement. A settled target offers the measured
predecessor through **Restart & Restore Previous Version**. A known interrupted
pair offers **Restart & Finish Recovery**. Both actions acquire the existing work
admission fences, record their exact dispatch intent, and use the helper's normal
Quit protocol. The helper, not the renderer, owns atomic exchange and reconciliation.

A restore intent whose result is still unknown stays blocked. A matching changed
terminal journal plus measured running build reconciles it on the next launch.
A rolled-back or cancelled build is not automatically offered again. All prior
payloads and journals remain available; this lifecycle never deletes the
predecessor or modifies workspaces/settings to make an update admissible.

These source tests exercise ports and disposable filesystem state. They are not
proof of a public GitHub download, installed N-to-N+1 upgrade, native relaunch,
configuration preservation or rollback on the owner's live installation. Those
require separate release/update receipts from the accepted packaged candidate.
