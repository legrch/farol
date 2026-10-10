# Installed startup blocked after unconfirmed shutdown

## Confirmed incident

On 2026-10-10, one hidden launch of the owner's installed Farol exited with
status 1 before displaying the application:

```text
FAROL_NEXT_STARTUP_FAILURE:DESKTOP_PREVIOUS_QUIT_UNCONFIRMED
FAROL_NEXT_SECOND_INSTANCE_RESULT:startup-failed
```

The installed package identifies itself as `0.2.0-owner.beta.3`, build `17`,
source `24cc7c32f12f2633156efef40c91ea0817109a4c`, build ID
`d381182bc7e529db2a21f1c1ded25288cdb4e34a6e33701ed8a7233c7efc3a5c`.
The selected slot is `~/Applications/Farol.app`, bundle ID
`local.farol.next.preview`. Its ordinary profile is `Farol Next Preview`.
Legacy Farol and `codex-chatgpt-web` are separate identities.

The ordinary profile retains a `farol-next-state/running.json` from
2026-10-09T01:16:19.330Z. Its latest `last-quit.json`, dated
2026-10-10T01:24:23.799Z, reports:

```json
{ "drained": false, "unconfirmed": ["go-core", "connector"] }
```

The startup code checks the presence of `running.json` under the promotion
lease. With a Go-enabled package, a retained marker refuses startup before
configuration, Go startup, the main window, or connector resume. No existing
operation was replayed by the diagnostic launch.

Read-only process inspection found no installed Farol or `farol-backend`
process. A legacy `codex-chatgpt-web` tunnel process was observed and left alone.
The installed Chat lifecycle has no retirement publication. There are 204
Computer mutation records: 200 report completed receipts and four report
classified failures. These observations do not prove original host drain,
settle Chat acknowledgements, or authorize clearing the startup fence.

The original reason that Go/connector shutdown did not confirm is **unknown**.
The retained quit receipt does not distinguish a rejected closer from an
expired shared deadline. Process absence now cannot recreate the original
retirement exchange. There is no evidence here of executable corruption or
that the verified update journal caused the failure.

## Applicability to current development

The same guard is present at inspected development source
`3034ed3911173a19cf56f4d28d780f42e2c5fcf2`, in
`src/apps/desktop/main.ts`. `startDesktopGoCore` independently requires the
previous host drain witness. Updating the binary alone cannot unlock this
profile.

`tooling/recover-empty-chat.mjs` deliberately supports only the ordinary Dev
namespace and a qualified empty Chat selection. This installed profile has
retained history and Computer records. Reusing that Dev tool, inventing a clean
Quit, removing `running.json`, or treating stored handoff bytes as a fresh
acknowledgement is not a qualified recovery.

The accompanying narrow source fix corrects the startup report: an unconfirmed
previous shutdown now requires profile recovery instead of suggesting a
rebuild/relaunch. It preserves the error code, nonzero exit and startup fence.
This is a diagnostic correction, not implementation of installed recovery.

## Handoff for the active Lead

1. Treat crash-to-next-launch as a release acceptance journey. A clean Quit
   test does not cover this incident. Include rejected/timed-out Go and
   connector closers, lost retirement acknowledgement, and failed quit-record
   persistence.
2. Present a usable, content-free recovery explanation before ordinary owner
   launch exits. A terminal-only diagnostic is invisible when launching from
   Finder or the Dock. Respect hidden/secondary-display test presentation.
3. Provide an explicit installed-profile recovery design that retains Chat
   history, Computer mutations and unknown effects. Bind the original profile,
   failed run, exact operation and observed process closure; do not automatically
   retry Send, tools, connector configuration or unknown acknowledgements.
4. Distinguish an isolated fresh working profile from recovery of the old one.
   Preserving the complete old profile and starting a new profile can restore
   access, but does not settle old operations or make old local history available
   in the new interface. Keep the retained profile closed.
5. Add content-free quit diagnostics for per-closer rejection versus deadline
   exhaustion. Bind them to the original run without recording payloads,
   credentials or private transcripts.

This document is a prepared handoff; no message to another task is implied.
Source tests, installed launch, working connector and live provider use require
separate evidence.

## Diagnostic-fix verification

At the inspected source base plus this document's companion change, Node
`24.20.0` ran 72 passing tests across `desktop-startup-failure.test.ts`,
`quit-drain.test.ts` and `run-marker.test.ts`. The root strict TypeScript check,
production lint, owned-file Prettier check and `git diff --check` passed.
The source change has R0 scope: error-remedy text with regression coverage;
it changes no profile storage, admission, retirement, retry or execution policy.
Full CI, a newly packaged application, installation and a repaired-profile
restart are not established by those checks.
