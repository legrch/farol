# Installed startup blocked after unconfirmed shutdown

## Normal Quit repair, 2026-10-10

Source checkpoint `561900153bb620b3037a05d44c541119c7a7510a` fixes two
concrete shutdown defects. Generic Quit previously invoked Go-core and connector
closure concurrently, although MCP drain and admitted account work still needed
the Go endpoint. The new desktop closer composition joins the original connector
and saved-chat cleanup before starting the original Go retirement. A rejected
dependent remains a separately named unconfirmed outcome; host cleanup does not
convert it into success. Reentrant Quit never creates another cleanup attempt,
and a dependency that settles after the original drain deadline cannot start a
late Go retirement.

The desktop now has one 60-second absolute Quit budget, with preparation capped
at 10 seconds and 2 seconds reserved for its terminal receipt. Collection and
cleanup spend that same budget. Timeout remains unconfirmed, retains the startup
marker, and does not authorize replay. Healthy closure returns immediately after
the actual children and receipt settle. Regression coverage includes a real child
process whose delayed failure receipt must survive before process exit.

Eight focused suites passed 179 tests; strict root TypeScript, production lint,
owned-file formatting and diff checks passed. A fresh host-native R3 source review
of `fc527f4b7fcbb7e29e34349765b3b5c530016a6d..561900153bb620b3037a05d44c541119c7a7510a`
completed General, concurrency/reliability Specialists and Strong with ACCEPT,
no findings and no reported limitations. Review certifies only its source scope.
The first full native CI reported 11,785 passing tests and two release-resource
failures: the previously reserved beta.5 package identity still had a beta.4
resource version. The resource declaration is aligned without changing namespace
or update channel; final CI and packaged/native/live evidence remain separate.

The owner's later beta.3 working lifetime also lost its local Go backend and
owned tunnel while the main window stayed open. Persisted connection readiness
was not evidence of cloud polling. Its actual menu Quit retained a fresh
`drained: false` receipt naming `go-core` and `connector` at
`2026-10-10T03:46:28.972Z`. The two owner-reported catalogue failures are transport
observations, not proof of a specific backend-exit cause. Old sessions and unknown
operations must remain quarantined rather than resumed or retried.

The owner selected the cloud task `Farol · Final Sync` for the development
handoff. The prior local Lead was not the active counterpart. Source repair,
local installation, normal connected Quit/reopen, and real cloud catalogue
verification must each be reported with their own evidence.

## Installed repair and live verification

The owner-authorized local repair installed `0.2.0-owner.beta.5`, build 19,
from clean source `ed4cb0c801e9613d5bdd8e389f098f00e9bcbb26`. `task package`
completed with schema-7 Go attestation, build ID
`e2d3f7fd464b9476d7cf432fa61249a619a8b8f7ec33ed4e0ef2d3d2b4c00296`
and app digest
`88da4cc03a45148e4639c606d8bdeba6db661838fdc8f701b787fc45e84fee45`.
The predecessor app and its receipt remain in a private retained application
directory. The failed beta.3 state remains closed under recovery operation
`c44ff949-2368-44c2-8aef-01aae869774a`; its unconfirmed Quit and unknown effects
were not rewritten as clean or resumed. The fresh state retains all five
workspace policies, host selections, tunnel selection and credential/browser
objects. Startup can refresh workspace verification generations; that refresh
does not change the preserved scope/access/root policies.

Installed, hidden native observations exercised the ordinary `app.quit()` path
with the actual selected tunnel, without an explicit connector Stop. Confirmed
connected Quit receipts at `2026-10-10T04:58:29.440Z` and
`2026-10-10T05:02:02.727Z` have `drained: true`, no unconfirmed components,
exit 0 without a signal, and no remaining run marker. A subsequent clean
restart started a fresh connector runtime generation automatically, passed its
actual health check without a manual Start, and recorded the same clean Quit
at `2026-10-10T05:02:43.115Z`. An earlier probe incorrectly compared refreshed
verification metadata as access policy and quit during resume; its failed
observations remain retained. After that confirmed closure, a distinct ordinary
Start/Quit and corrected policy/runtime-generation probe supplied the accepted
observations above. No outcome-unknown effect was replayed.

The repaired app was then opened normally and left running. Process observation
confirmed its own Go backend and tunnel-client. One live cloud
`farol_computer_workspace_catalogue` invocation returned `status: ok` and five
workspaces through the actual Secure MCP Tunnel, request
`39300866-d453-4662-98b3-4e7d70a6d5ff`, backend generation
`1e57e0d5d087a66cea64c87f9b2a5bdd`. The catalogue read no workspace file contents;
it proves this connection lifetime, not provider Send, mutations or an hour-long
soak. Browser and credential storage were preserved; no new sign-in or provider
conversation was performed for this repair.

Final evidence is deliberately separated from acceptance of the whole alpha:

- Root coverage passed 11,787 tests in 500 files; 12 existing skips and two todos
  remain. Renderer coverage passed 910 tests in 17 files. Type checks, lint,
  formatting, architecture and the exact-source Hunt report completed.
- The original `task ci:fast` reached Go race but failed the cancellation branch
  of `TestNativeConnectorSocketCloseOrCancelTerminatesExactStreams`. Its helper
  requires immediate EOF and can encounter a buffered original owner terminal
  response. That is a possible explanation, not captured-frame proof. The exact
  unchanged isolated test passed 100 race repetitions; the full `task test:core`
  recheck then passed root/nested race and vet, generated/import checks, 169
  protocol tests and strict bridge compilation. The failed aggregate receipt is
  retained rather than relabelled as a passed invocation.
- Sealed-package read-only MCP passed with a disposable workspace. The additional
  packaged guided-Setup behavior journey failed its optional Sign in expectation:
  actual `unknown / Current sign-in is unknown`, expected `needed / Not checked`.
  Its owned exits settled, with no cleanup uncertainty. It is not a passing
  Setup or external-attachment qualification.
- Output layout checks passed. The repair commit range and current working tree
  secret scans passed. The all-ref history scan failed with five generic-key
  matches in two other commits; only fully redacted metadata was retained and
  prepared for the Lead. It remains a separate history gate requiring disposition.
- Installed updater status still reports `UPDATE_RETAINED_PACKAGE_INVALID` with
  recovery required. No retained update was activated, discarded or retried.
  The unknown beta.3 backend exit and stale readiness also require independent
  failure diagnosis and regression coverage in the cloud development candidate.

The selected cloud `Farol · Final Sync` received the exact production patch and
the additional native/Setup findings under the owner's explicit handoff grant.
Local commits, package, installed repair and this one live transport success do
not constitute a release, remote push, or whole-alpha acceptance. Documentation
commits after the installed source SHA do not change the installed build identity.

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

Two current shutdown constraints also deserve a regression journey. Desktop
Quit has one 10-second budget, including updater preparation, child drain and
receipt persistence. The Go retirement preparation request alone permits
16 seconds before its acknowledgement and exact child cleanup. The updater
closer also waits for its in-flight initialization. When preparation/drain
exhausts the absolute budget, `createQuitDrain` starts recording but may quit
before the asynchronous private receipt/marker write finishes. Increasing a
timeout alone does not establish a correct shutdown or recover old effects.

The installed owner's Computer approval had expired before the original Quit.
Current `apps/desktop/go-computer-authority.ts` already publishes
`renewableOwnerConsent: true`; beta.3 does not. This is a version difference,
not proof that approval expiry caused the original unconfirmed shutdown.

## Owner-authorized working-session reset

The owner explicitly accepted losing local history in the working interface,
while retaining folder access, connection selections, credentials and browser
sign-in data. No retained operation was resumed or retried.

A task-local one-shot helper retained the complete old `farol-next-state`,
including the unconfirmed run, Quit receipt, Chat/Computer journals and fences.
It created a separate fresh state with the same five workspace policies,
physical-root identities, host selections and tunnel selection. It copied the
existing private connector launch configuration, cleared only runtime/challenge
and current attachment projections, and did not copy old Go/Chat lifetimes.
Starting a new connector creates a new verification challenge; historical
attachment evidence is not projected as current verification.

The helper checked exact state hashes, private file/directory identities,
exclusive promotion leases and installed-process absence. It wrote a durable
content-free intent before the macOS atomic directory swap, bound both swapped
directory/lease identities, and retained a completion receipt. Browser
`Partitions`, `farol-next-private` and the credential object retained their
original filesystem identities. Credentials and browser authentication contents
were never read, copied into evidence or reset. A fresh-context read-only
reliability inspection prompted process-attribution, stale-projection and
crash-interval corrections before applying the helper; fixture checks cover
those corrections, not general installed-recovery acceptance.

The original retained state is:

```text
~/Library/Application Support/Farol Next Preview/
  farol-next-state-retained-908e3a09-0785-42d2-a6bb-73ea9b9662ab
```

Later failed diagnostic lifetimes were retained separately under operation IDs
`be63cbf8-1264-42a8-94f2-76e53bd26ec8` and
`0ba849c1-a98c-4420-be67-90b48d879efb`. Each reset selected the newly observed
failed lifetime by its exact evidence; none reopened a retained unknown session.
The installed executable and package were not replaced.

## Installed verification and usable workaround

All three diagnostic lifetimes used the exact installed beta.3 executable and
hidden, unfocused windows. They made no provider Send, tool call or account read.
The private evidence directory is
`/private/tmp/farol-startup-diagnosis-20261010`.

| Journey                                                                                                                     | Observed result                                                                                                                           | Limit                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Fresh startup, then immediate normal Quit                                                                                   | Runtime/configuration ready; all five policies preserved. Exit 0, but `drained: false`, `unconfirmed: ["installed-updater"]`.             | Startup succeeded; the journey failed. Initialization had not settled.                            |
| Fresh startup, wait for updater initialization, Start and Check local connection once, normal Quit                          | Connector and health ready. Process exited; Go retirement was retained, but no `last-quit.json` was retained and the run marker remained. | Quit is unconfirmed. A Go retirement publication alone is not the complete desktop drain witness. |
| Separate fresh startup, wait for updater initialization, Start and Check once, explicitly Stop connection once, normal Quit | Connector ready, health ready, explicit Stop confirmed. Exit 0, no signal, `drained: true`, no unconfirmed closer, run marker absent.     | This proves the workaround, not ordinary connected Quit or provider use.                          |

The final successful Quit receipt is dated `2026-10-10T02:32:00.608Z`.
Normal owner launch subsequently reopened the same working profile without
another reset. Its window appeared; the UI reported five shared/verified folders
and the saved private connection key. One ordinary UI Start command produced
persisted connector state `ready`, settings revision 527, no pending edit and no
unknown setup outcome. The exact main process remained alive. Later computer-use
observations timed out, so final UI delivery and embedded sign-in verification
are not claimed. The browser sign-in objects were preserved; that is distinct
from observing a signed-in account through the provider UI.

For beta.3, let startup initialization settle and use Settings → Connection →
**Stop connection** before **Quit**. The confirmed Stop/normal-Quit journey
removes the startup marker without changing its safety policy. Stop is not a
retry of an unconfirmed previous operation.

The last diagnostic startup independently reported updater state
`failed / UPDATE_RETAINED_PACKAGE_INVALID / recoveryRequired: true`; the local
service and connector still started. No update installation/recovery command
was issued. This update condition is unresolved and is not established as the
cause of the original startup refusal.

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
6. Reproduce connected normal Quit and early Quit during updater initialization
   against current built bytes. Reconcile the 10-second desktop budget with
   16-second Go retirement and reserve durable terminal-record time. Prove
   connector stop, account withdrawal, Go retirement/ACK and exact child exit;
   retain unknown outcomes instead of reporting clean drain. The installed
   Stop-before-Quit workaround does not qualify a source shutdown fix.
7. Diagnose `UPDATE_RETAINED_PACKAGE_INVALID` separately using content-free
   retained-package identity evidence. Do not discard the update journal or
   activate the staged update as a startup-fence remedy.

This document is a prepared handoff; no message to another task is implied.
Source tests, installed launch, working connector and live provider use require
separate evidence.

## Earlier diagnostic-only verification

At the inspected source base plus this document's companion change, Node
`24.20.0` ran 72 passing tests across `desktop-startup-failure.test.ts`,
`quit-drain.test.ts` and `run-marker.test.ts`. The root strict TypeScript check,
production lint, owned-file Prettier check and `git diff --check` passed.
The source change has R0 scope: error-remedy text with regression coverage;
it changes no profile storage, admission, retirement, retry or execution policy.
Those checks do not establish full CI, a new package or installation. The
installed working-profile restart and Stop-before-Quit workaround had the
separate, bounded witnesses above. At that earlier stage, shutdown recurrence
prevention and current source native qualification were still open. The later
normal-Quit repair and its separate installed/live evidence are recorded first
in this document.
