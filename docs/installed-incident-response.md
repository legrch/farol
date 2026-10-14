# Installed application incident response

An owner report that Farol will not launch, reconnect, or install an update is an
incident. Restoring a usable installed application takes priority over feature
work and broad acceptance or repeated formal review cycles.

## Restore first

1. Establish the exact installed path, version, observed failure, and owned
   process state. Preserve the existing application, profile, workspaces,
   connection settings, journals, and recovery evidence using recoverable moves.
2. Select a known working package or a bounded hotfix. Run relevant regression,
   type, and static checks, inspect the owned diff, and commit coherent source.
   Build with `task package` from clean committed bytes; retain compiler,
   dependency, source, resource, and package attestation.
3. Verify the packaged application's actual startup, normal quit, and reopen
   with disposable state. These checks establish packaged lifecycle behavior;
   they do not establish the installed profile or live connection.
4. Restore the owner's authorized installation promptly. If OTA cannot recover,
   use the explicit replacement path. Prefer `/Applications/Farol.app` when the
   owner has authorized that destination. Keep the previous application and
   recovery evidence until the replacement has been read back and launched.
5. Verify the installed application's startup and connection, then perform
   bounded real Computer checks: files, Bash/Git, process cancellation, and
   reconnect. Record source, packaged, installed, and live results separately.
6. Resume aggregate acceptance and risk-based formal review after restoring
   usability. Report open findings and limitations explicitly. An emergency
   installation does not by itself authorize public release or accepted-main
   advancement.

The Lead should use existing owner grants for diagnostics and installation rather
than repeatedly asking for them. A machine restart interrupts other applications
and requires an explicit owner decision when it is necessary.

## Select the exact installation

Resolve an installed incident by the canonical bundle path, not the display
name. Historical build bundles can also be named Farol, and macOS may select
one of them when asked to open an application by name. For the owner's global
installation, launch only `/Applications/Farol.app` through its outer launcher.
Never launch a historical bundle or its embedded vendor executable as a fallback.

Before interaction or replacement, compare the installed version and source/build
receipt with the actual process paths and the running UI's accepted resource
identity. A visible window or a matching display name alone does not identify
the installed build. Binding to an already running native window is distinct
from executing an embedded vendor runtime directly.

When the owner retires an old installation, stop only its positively identified
processes and remove that exact bundle from the active installation path using
recoverable custody. Unregister the retired bundle's path. Preserve its source,
profile and uncertain-operation evidence. Keep one canonical installed path;
retain replacement custody outside ordinary application launch locations.
Do not alter unrelated Dock entries or choose between identically named icons
without confirming their target identity.

## Preserve uncertain work

Recovery must not replay an operation with an unknown outcome, invent process
cleanup evidence, discard journals, reset credentials, or replace a working
profile with an empty one. When prior write descendants cannot be excluded, use
the explicit preserved-state recovery contract and genuine native evidence.
A failed notice acknowledgement or uncertain idle observation must not alone
prevent a separately authorized manual update; integrity and process ownership
checks remain effective.

## Evidence and follow-up

Retain the incident's failing observation, selected source and package identity,
representative checks, exact installation result, and first successful live
operation. Each incident should add regression coverage for its actual cause.
Track broader acceptance and deferred findings after restoration instead of
holding the user's working installation behind another complete review ladder.

## Explicit global replacement maintenance

The existing replacement owner accepts the frozen version 1 selection for the
user Applications installation. Version 2 additionally requires an explicit
`installLocation` of `shared` or `legacy`; `shared` selects only
`/Applications/Farol.app`. Both Node preflight and the inherited-descriptor native
owner use the ordinary promotion library's shared-parent checks. No arbitrary
destination or legacy bundle identity is admitted.

Replacement retains the previous bundle, promotion receipt and updater tree,
including accepted private execution images, without claiming old operations
settled. A fresh updater with no update/download history can have no ready or
last-update records. A missing half or historical work without its records
remains unconfirmed and refuses replacement.

If that untouched updater has never created its mutex, the separately selected
`prepareCleanReplacementLock` maintenance action may create only its empty lock
after confirmed closed-app admission under the promotion lease. Its attested
native child uses held private directory descriptors, exclusive creation, file
and directory sync, and independent named-file readback. It writes no update
result, journal, old ACK or cleanup receipt. An unknown child/publication retains
the original owner and lease. Select a fresh replacement snapshot only after
this preparation completes; a visible lock file alone cannot settle an unknown
preparation. Ordinary plan-only replacement does not initialize that lock.

## Cold backend startup deadline

The desktop uses a bounded 15-second budget for the original Go startup,
including Shell metadata delivery and the first handshake. Runtime attestation
and retained journal initialization can exceed the ordinary two-second RPC
budget on a cold launch. Ordinary operation deadlines remain unchanged. A late
or missing startup response stays outcome-unknown; increasing the budget never
retries a failed startup or settles its retained run marker.

## Withdrawal during execution resource recheck

The original asynchronous resource recheck remains part of the admitted startup.
After it returns, connector Configure and local runtime spawn must recheck
Quit/update/stop and the original transport observation epoch before dispatch.
Stop or Quit while that filesystem check is pending must produce no later
native launch. Resource validity does not establish current admission. The
source-level host fixtures exercise this pending phase separately from real
resource attestation and installed process evidence.

## Public source changes while a private runtime is running

Execution resource validation and updater source validation are separate ports.
An accepted private image remains executable when the public application slot is
replaced. Before a new update can capture execution and reach Quit, its origin
also checks the current `/Applications/Farol.app` against the accepted source
build/digest. A changed public source refuses that update before helper or Quit;
it does not invalidate the still-running private resources. Hint-based, settled
private and ordinary shared origins supply this check. The native helper retains
its final source check because another administrator is not excluded by the
application's private lease.

## Local runtime shutdown ownership

The Node IPC runtime retains its original child lifetime until `close` confirms
exit 0 without a signal, or the original exit and IPC disconnection are both
observed with no parent-owned stdio streams remaining. Node can omit `close`
when the parent disconnects IPC. Quit includes that lifetime in the same
bounded drain as other owned services. A shutdown message, its send callback,
IPC disconnection, or an `exit` event alone does not confirm closure. Failed or
forced termination remains an unconfirmed Quit obligation. The child installs
shutdown, disconnect and SIGTERM handlers before its asynchronous initialization;
a late startup result is closed rather than published after parent loss. This
root-process observation does not qualify arbitrary descendant cleanup.

## Shared replacement completion observation

After hashing the held candidate descriptor, replacement rechecks the named
application, new receipt and retained custody against their captured identities.
The same checks run before intent retirement and after the original retirement
readback. A displacement during verification retains the original pending fence;
a failed post-retirement observation publishes the existing uncertainty fence.
Completion is a bounded observation, not permanent exclusion of later changes
by another administrator. No displaced operation is repeated or rolled back.

## Retained private launch processes

Closed-app replacement checks the entire selected profile's `installed-updates`
namespace, including operation-owned `launch-Farol.app` images and authenticated
`installed-execution` snapshots. A process using either location blocks custody
before publication of the replacement intent. The canonical slot and native Go
and connector state roots keep their separate process checks.

## Resource manifest wire compatibility

Schema 1 retains the historical `electron-utility-process` discriminator because
installed package verifiers compare the complete resource contract. The active
implementation uses Node IPC as documented above. Renaming that wire value would
make existing installed verifiers reject the next package; a future discriminator
change needs a separately qualified versioned consumer transition.

## Connector internal preparation withdrawal

Configure, Doctor and Start carry the caller's original synchronous admission
check. Configure checks it after resource validation and directory preparation,
then immediately before init. The production anchor starter checks it after
executable/resource validation and immediately before spawn. Quit, update or
withdrawal of the original recovery observation therefore refuses a late native
dispatch even when the accepted image remains intact. A pre-dispatch withdrawal
is classified as not started, never an unknown spawn or profile-write result.

## Shared custody preparation and copied roots

Replacement prepares and opens its custody directory beneath the pinned private
profile before publishing that same inode into Applications with exclusive
rename. Intent writes use the held private descriptor; an unrelated directory
substituted at the shared name is never adopted as custody. Failed preparation
stays retained and is not reused or retried. Named identity checks remain bounded
observations, not permanent exclusion of another administrator.

Execution capture rejects a copied root symlink before changing permissions and
uses a no-follow directory descriptor for the mode change. The connection guide
loads its document from the same authenticated private origin as the renderer,
so delayed guide loads do not consult a replaceable public bundle.
