# Runtime dependency verification

Go owns backend policy, state, orchestration and native execution. React and
TypeScript retain UI, Electron/browser/IPC and thin transport adapters. The target
normal installation requires no separately installed Python, Node/npm, Go or
Xcode Command Line Tools. Source wiring and fixtures do not establish that
installation acceptance.

## Current selected source owners

The connection path selects the app-owned full Tunnel Client CLI, with its
reviewed upstream hash checked independently of the build entry ledger before
packaging. Build preparation supplies the reviewed raw executable and notices
in one `_output/tunnel-client` slot. Existing external selections cannot override
the bundle; an admitted replacement requires the previous connector owner to
be confirmed stopped. The init, doctor and run protocol and UNKNOWN fences
remain unchanged. Source wiring does not establish native or signed-release
acceptance, or completion of third-party dependency notice qualification.

| Capability                                                      | Selected owner and adapter                                                                                                                                                                                                                                                                                             | Remaining retirement exit                                                                                                                                                                      |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Computer file operations and Settings search in Go-aware builds | Electron command/IPC → Go Computer authority/service → existing Go filesystem owner. Selected failures do not dispatch Python.                                                                                                                                                                                         | Native, packaged-process and installed qualification; preserve explicit legacy/dev helper compatibility until separately retired.                                                              |
| Chat normal lifecycle                                           | Go Chat journals/state/orchestration with Electron/browser/Responses adapters.                                                                                                                                                                                                                                         | Remaining Responses/model/configuration policy must be inventoried individually; the retained-continuation API is still dormant.                                                               |
| Task/Agent                                                      | Normal Task lifecycle remains unavailable and tools are `not_registered`; the trusted Go selected-reader launch seam is optional and unselected. Reachable TS setup/model/host-verification and retained-assignment cleanup remain.                                                                                    | Qualify scoped reads first, then individual authorized lifecycle capabilities through existing Go Task authority; remove each old policy route after parity.                                   |
| Installed update                                                | Existing TS updater/runtime still owns update policy, discovery, preference/state and recovery orchestration; apply, recover and rollback run the attested bundled `farol-backend` helper entries (`run-closed-release-helper`, `run-live-release-helper`). Legacy builds without the compiled Go core refuse updates. | Native, package and installed qualification of the selected route; drop `update_helper.py` only under the [bridge rule](../installed-update-helper.md#retiring-the-python-helper-bridge-rule). |
| Installed slot-binding publication                              | Go-aware desktop → attested bundled backend → Go Release publisher.                                                                                                                                                                                                                                                    | Selected; the Python string path is removed. Apply/recover/rollback run the selected Go helper entries (row above), not Python.                                                                |

By owner decision of 2026-10-20 the desktop update path spawns the Go helpers and
never falls back to Python: `startInstalledUpdateHelper` runs the qualified
`farol-backend` from the build's private execution image (inventory row
`release.update-go`), a build without the compiled Go core refuses apply, recover
and rollback with `UPDATE_HELPER_GO_CORE_REQUIRED` (such a build is updated by hand),
and the maintainer's supervised controller uses the accepted target package's own
declaration or refuses before the predecessor is asked to quit. The Python file
`resources/native/update_helper.py` is no longer dispatched by the desktop, including
slot-binding publication. It stays in the tree as the behavioural reference of the Go
entries and in the package under the [bridge rule](../installed-update-helper.md#retiring-the-python-helper-bridge-rule):
installed predecessors verify a target's exact resource set, so the file leaves the
package only after a release with the tolerant verifier has been installed.
`resources/native/safe_open.py` is still dispatched by the readonly workspace (including
the Codex agent probe and the development MCP proof) and the snapshot helper. Those two
helper-dispatch sites remain inventoried. Both resources remain packaged. `update-archive.py` is a Go executable
under a historical resource name, not an interpreter script.

By owner decision of 2026-10-20, the Settings "Git status" and "Git HEAD"
checks (the Python snapshot plus Command Line Tools Git) are unavailable in
Go-aware builds: they refuse with `WORKSPACE_COMMAND_UNAVAILABLE` and the
buttons are disabled; they run only in explicit legacy builds. The Codex agent
check lists through the Go settings list in a Go-aware build and never falls
back to Python.

Electron supplies its bundled Node runtime. Go/compiler/npm/CLT development tools
and Python build/test/maintenance scripts are separate from the installed app.
Explicit user-selected Codex/Claude executables and authorized user Git hooks may
require their own toolchains, including Python. No runtime guard grants those
tools authority or widens generic Shell networking.

## Lightweight regression checks

Run `npm run runtime:check`. The existing CI includes it. The semantic manifest
in `tooling/runtime-launch-manifest.mjs` records exact launcher functions,
executable expressions, compatibility classifications and owned resources. New
or changed launchers, stale exceptions, direct interpreter/toolchain additions,
and changes to the selected Settings search edge fail review. Dynamic executable
values remain the declared owner's responsibility; this static ratchet is not
whole-program control-flow, reflection, Go type-checker or sandbox proof.

Go builds and package verification also check owned executable closure against
the existing build/core entry ledgers. Missing, unexpected, mistyped, redirected,
hardlinked or writable runtime resources fail. Existing compiler, artifact/hash,
native helper, Electron tree, package and provenance validators retain authority;
header checks never establish Go provenance or signing acceptance.

Keep source, packaged, installed, live and owner-accepted states separate.
macOS/Seatbelt, installed Git hooks, clean-Mac setup, actual provider Tasks and
OTA/rollback require their real environments and remain NOT RUN from portable
fixtures.
