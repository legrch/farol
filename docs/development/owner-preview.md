# On-demand Owner Preview

Status: unaccepted source preparation. The derivative assembler, verifier and
smoke harness are implemented; no packaged, native, installed, live-provider or
beta acceptance is established by the pure tests. The assembled source admits
only the fixed `owner-preview` runtime identity with private child homes and
explicit installed-updater exclusion. Actual packaged/native behavior remains
unqualified. Keep the Mac package/native/GUI lane with the integration Lead.

## Owner commands and caller migration

```sh
task preview             # build canonical package, derive, smoke, then run
task preview:build       # build and smoke, without opening the owner profile
task preview:run         # verify and smoke the current generation, then run
task preview:plan        # bounded read of current main; no build or app launch
```

No SHA argument is required. Each command derives HEAD, local `main` and tracking
`origin/main`. It rejects dirty, unmerged or divergent local source, verifies the
single existing `legrch/farol` origin URL, and makes exactly one bounded
`git ls-remote origin refs/heads/main` read. All four commits must agree. An
optional `--expected-main <full SHA>` adds an assertion. There is no checkout,
pull, reset, remote change, publication, dependency install or pin refresh.
A fresh remote read proves the observed main identity, not acceptance of an
unmerged checkpoint. Source and local refs are checked again before publication
of the local pointer and before owner launch.

`npm run preview:owner`, `preview:plan`, `preview:build` and `preview:run` route to
the same helper. Prefer Task's clean-environment, owner-guarded entrypoints. The
existing `npm run preview` deliberately retains its development-only meaning,
so its active callers and [testing guidance](../testing.md) stay valid. An
explicit `npm run preview:development` alias preserves that same command, and
`task preview:development` retains the already admitted `npm run preview` command
beneath the owner guard. Both still launch existing
development build bytes without rebuilding. Frozen historical examples remain
historical. `task run` retains its canonical candidate contract.

Build/run first require actual `desktopEnvironment("owner-preview")` admission,
the exported fixed identity, matching `desktopIdentity`, and private Codex,
config and process-home functions. A declaration or caller boolean cannot enable
Preview. The canonical builder still requires physical authenticated compiler
and dependency paths. A focused-test `node_modules` symlink does not qualify.

## Canonical base and derivative recipe

The only base producer is unchanged `task package`, with the original approved
offline `_output/go-build-inputs.json` passed through `--go-inputs`. Missing or
changed inputs fail; the helper neither invents approvals nor downloads inputs.
Canonical verification runs through unchanged `verify-package.mjs --artifact
<snapshot manifest> --app <snapshot Farol.app>`, using the supported frozen-input
semantics also used by the canonical launch snapshot. The original manifest,
including its strict canonical `artifactPath`, remains byte-for-byte unchanged.
The base application is never launched.

Each retained generation contains:

```text
_output/preview/generations/<64hex>/
  .canonical/                  # private 0700, never an owner launch target
    artifact.json              # original canonical manifest, 0600
    Farol.app/                 # unmodified, authenticated canonical snapshot
  derivative.json              # derivative manifest, 0600
  Farol Preview.app/           # only this app can become current
```

`farol-owner-preview/1` records original source commit/tree, SHA-256 of the exact
base manifest, base app digest, base build ID, fixed Preview identity, exact
`farol-owner-preview-recipe/1`, tree-digest version and full derivative app tree
digest. The generation directory is SHA-256 of the deterministic derivative
manifest serialization. It is never reused or overwritten. Partial assembly
stays under `_output/preview/failed/<64hex>`; completed but failed-smoke
generations stay in `generations`. All previous and failed outputs are retained.
No automatic pruning, installed-app closure or effect settlement is part of
these commands. The foreground canonical package command has no automatic timeout;
an unknown package subprocess outcome retains its writer lock for Lead
reconciliation. A source-equivalent single-instance reopen does not identify the
running immutable generation. The command reports that outcome as
`OWNER_PREVIEW_RUNNING_GENERATION_UNCONFIRMED` without naming the requested
generation as running; quit the existing Preview normally before launching the
intended generation.

The recipe permits precisely these differences from the canonical snapshot:

- Outer `Contents/Info.plist`: only the string values of `CFBundleDisplayName`,
  `CFBundleName`, `CFBundleIdentifier` and `CFBundleIconFile`.
- Existing `Contents/MacOS/Farol Next Preview`: a fixed launcher that rejects
  arguments, starts with `env -i`, and sets the exact `owner-preview` marker.
  Its executable basename and mode stay unchanged.
- Added `Contents/Resources/farol-preview.icns`, and added
  `Contents/Resources/app/farol-preview-mark.svg` and `farol-preview-mark.png`,
  all mode 0644. Root selects the last filename for the Preview dock icon.

Every other file, directory, link target and mode must match. This includes
vendor Electron, Go resources, original production/Dev branding, embedded source
and build identity, original resource manifests and build entries. There is no
global Next/ID rename and no rewrite to impersonate a canonical package.

The verifier independently re-verifies the hidden base, renders expected Preview
assets from the SHA-pinned SVG using fixed local `rsvg-convert` and `iconutil`
build tools, reconstructs the allowed plist/launcher changes, and compares the
complete tree inventory. It then recomputes both tree digests and rechecks source.
Self-reported asset or output hashes alone cannot admit changed bytes. Native
raster/icon determinism and actual macOS tool availability are still NOT RUN;
asset reconstruction fails closed on unavailable or nonmatching output. The
fixed SVG extends the existing Farol mark with a clear PREVIEW badge. It does
not regenerate production or Dev assets or alter `BRAND_RESOURCES`.

After successful verification and smoke, `_output/preview/Farol Preview.app` is
atomically replaced as a relative symlink with the sole permitted target shape
`generations/<64hex>/Farol Preview.app`. A regular app, broken link, external link
or hidden-base target is refused. Run resolves and pins that exact generation,
re-verifies it immediately before execution, and launches its persistent bytes.
No OS temporary application snapshot is used.

## Packaged smoke and runtime integration seam

The build/run gate invokes
[`owner-preview-smoke.e2e.mjs`](../../tests/e2e/owner-preview-smoke.e2e.mjs).
It independently verifies the generation, creates a **new** disposable private
profile using the existing production E2E root marker/proof, and drives the
unchanged packaged Electron with the derivative's exact `Resources/app`. This
permits the existing private E2E proof without weakening the owner launcher's
clean environment or admitting arbitrary owner flags. It does not launch the
hidden canonical app. The fixed wrapper is verified byte-for-byte; execution
through that wrapper on the persistent owner profile remains on-demand.

The harness observes packaged source/build identity, display/app identity,
userData/sessionData/home, distinct Preview session storage, hidden/unfocused
windows, no configured connector/tunnel/credentials/tasks, and an unavailable
installed updater. It uses a loopback offline page and aborts/rejects other
browser requests. It stores the actual renderer appearance preference, requests
ordinary `app.quit()`, requires exit 0 and a fresh drained quit receipt, then
reopens the same disposable profile and verifies the saved preference is loaded
and presented. It checks only exact observed owned PIDs and the app's quit drain;
it never scans or kills unrelated processes. This is representative startup and
persistence evidence, not live-provider or general descendant qualification.

Startup admits only physical, owner-controlled app-data ancestors and a
physically separate Preview profile with owner-only access. It creates a missing
fixed profile leaf with mode 0700 before Electron selects storage; an existing
aliased, shared-readable or unsafe profile is refused without repair or migration.
Fixed private-home, credential, state and Chromium partition ancestors are checked
before any descendant creation or credential access. New derivative assets receive
their exact recipe modes independently of the operator's umask.

Receipts under `_output/preview/smoke/<generation>/<attempt UUID>.json` bind exact
source, base/build, derivative and actual observations. They begin as UNKNOWN,
become PASS only after both clean cycles, re-verification and exact owned-process
absence, and have no caller PASS flag. All disposable profiles and receipts remain
retained, including successful attempts; no cleanup-to-checkpoint crash window can
erase unresolved profile evidence. Failures/UNKNOWN prevent further smoke of that
generation and require Lead
reconciliation. A known owned app may receive one normal Quit cleanup request;
a refused/unknown Quit is never retried or escalated by the harness. The pinned
Playwright Electron launcher can force-terminate its own disposable process group
if initialization fails before returning a handle. That dependency behavior is
not proof of a drained Quit: the attempt remains UNKNOWN with its profile and
receipt retained. No failed smoke publishes the current pointer or opens the
persistent owner profile.

V1 commands must be invoked serially. The receipt scan does not serialize two
simultaneous manual smoke/run commands; an overlapping attempt may become UNKNOWN
after its sibling passes the scan. Each attempt still owns a distinct disposable
profile. Concurrent command admission is outside this on-demand qualification.

The assembled runtime preserves the existing E2E proof and admits the
fixed environment/partitions in startup and renderer contracts, selects private
child homes/config and `farol-preview-mark.png`, and returns before installed
updater construction. Synthetic/acceptance/recovery seams remain Dev-only. The source runtime gate checks the parser/identity/home functions; actual
packaged behavior must still pass the smoke. The helper does not edit those
contracts, Go Recovery, the installed profile, a tunnel or an updater helper.

## Isolation witness (R07)

[`owner-preview-isolation.e2e.mjs`](../../tests/e2e/owner-preview-isolation.e2e.mjs)
is a separate explicit entrypoint, run only through the owner-untouched guard
(`task test:e2e:owner-preview-isolation -- --generation <64hex>`); the build and
run commands do not invoke it, and there is no npm script for it. The witness
refuses to start (`UNGUARDED`) unless its direct parent's command line is the
guard script followed by `--` and exactly this invocation, so a direct `node`,
npm or shell run stops before anything is read or launched; this prevents an
unguarded run by mistake, not a deliberate imitation. It runs one
disposable normal instance and one Preview at the same time, hidden, each in its
own disposable root, and reads what the operating system reports for their exact
pids: open files, listening sockets, the Go backend and Node runtime children,
their arguments and environments (`KERN_PROCARGS2`, same user). It asserts that
roots, Chromium storage, bundle bytes, runtime identity and loopback ports differ,
that no string observed for an owned process names another instance's root or an
owner location (`~/Library/Application Support/Farol*`, `~/.farol`, `~/.codex`,
`/Applications/Farol.app`, and the guard's own list), and that both instances exit
drained.

The string rule, in one classifier: every string observed for an owned process
goes through it, with no exceptions by field. That is each argv element and the
executable path, **each environment value** (all of them, not only `HOME` and
`CODEX_HOME`), each open-file path and each unix socket path. Argv and
environment values are text, so path-like substrings are extracted first, from
the whole value, from each whitespace-separated token and from each quoted piece:
surrounding quotes are stripped; for `--flag=/path`, `-f=/path` or `NAME=/path` the
part after the first `=` is taken; the result is split on `:` (PATH-like lists);
a `file://` prefix is dropped; what is an absolute path is kept. Files and sockets
already are paths. Each path is compared in its literal and canonical form with
boundary-aware containment, and the string takes the strongest class of its
paths: **`other_instance`** (inside the other instance's roots or bundle),
**`owner`** (an owner location: the guard's list plus the `Farol*` prefix rule),
**`own`** (inside this instance's roots or bundle) or **`neutral`**. An
`other_instance` or `owner` string fails the run with
`STRING_OTHER_INSTANCE` or `STRING_OWNER`, naming the field kind, role and pid
(and the key for an environment value) but never an environment value. `HOME` and
`CODEX_HOME` keep their extra requirement on top: inside this instance's own root.
The receipt records the number of strings per instance, kind and class
(`observations[kind].classification.counts`), never the strings themselves.

**Receipt guard.** No receipt or log line carries a raw environment value, and
this is enforced mechanically: every write of the receipt goes through a guard
that scans each string in it. A string is a finding if it equals an environment
value observed in this run (when that value is path-like or at least 12
characters; short enumerations such as `normal` are not secrets) unless it is a
path inside this run's disposable roots or the checkout, which are recorded by
design; or if it holds a path that is an owner location, or that lies under the
owner's home without being inside the disposable roots or the checkout. A finding
is redacted (a whole value, or only the offending path inside a failure message,
so the failure code survives), reported by JSON pointer and code only, the
scrubbed receipt is written, and the run fails closed
(`RECEIPT_UNSAFE`). The observed values are kept in memory only for that scan.
The failure line the command prints passes the same guard, so an owner path in
an early failure (an unsafe `TMPDIR` refused before any receipt exists) is
printed as `[REDACTED_PATH]` behind its code.

Receipt status: `PASS` is reserved for a run with no blocked dimension.
Because override-free resolution is never observed, a run that passes every
exercised check with a verified teardown ends as **`PASS_WITH_BLOCKED`**, with
`blockedDimensions[]` and a `statusNote` saying that only the exercised subset
passed and naming what was not observed. The command exits 0 for both, so the
guarded task stays usable; `UNKNOWN` keeps its meaning (a failure or an
unverified teardown, whatever is blocked).

Override-free resolution is **not witnessed**, and the receipt keeps the row
(`blocked[]`, `status: not_observed`, reference
`NATIVE_APPDATA_IGNORES_HOME (documented)`) so it is not silently dropped. It is
a documented fact, not a runtime measurement, and the measurement is quoted here
so the claim can be read without any receipt.

_Measured 2026-10-21 on macOS (Darwin 27.0.0), Electron 44.4.2 (the version pinned
in `package.json` and shipped in the package)._ The packaged Electron runtime was
started on a throwaway app, from a shell with a disposable `HOME`, and the app
printed three values once ready:

```text
command shape  env HOME=<TMPDIR>/farol-next-e2e-probe-<random>/home \
                 <package>/Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron <throwaway-app-dir>
               (main.js called app.setPath("userData", <disposable dir>) before
               ready, opened no window, then printed and quit)
process.env.HOME            <TMPDIR>/farol-next-e2e-probe-<random>/home   (the disposable value)
app.getPath("appData")      <account-home>/Library/Application Support    (the account's real one)
app.getPath("home")         <account-home>                                (the account's real one)
```

`<account-home>` is the macOS account's real home directory, redacted. So a disposable `HOME` is visible to the process, yet Electron's native `appData`
and `home` still point at the account's real directories. A launch without
`FAROL_NEXT_E2E_APP_DATA` would therefore select the owner's real `Farol Preview`
profile. In-tree corroboration: the product already pins `app.getPath("home")` to
the proven E2E home because, in its own words, "on macOS Electron's native home
may ignore the child's HOME environment"
([`src/apps/desktop/main.ts`](../../src/apps/desktop/main.ts), line 580).

_Mechanism (a reading, not a measurement):_ Electron resolves `appData` on macOS
through the platform's per-account directory lookup rather than from `$HOME`.
Electron documents the macOS default only as `~/Library/Application Support`
([`app.getPath(name)`](https://www.electronjs.org/docs/latest/api/app#appgetpathname));
the independence from `$HOME` is inferred from the measurement above.

Private reference, not in the repository: receipt
`344594de-13f1-4ef2-816b-488aa9a4bbb9` in the author's untracked `_output`
(generation `5201873407968a0db209fd6a2e8e23f920cd48ea860556d8f3255ae595bb1786`).

The witness does not launch without the override and does not measure it again:
any process whose defaults point at the owner's real home could create files
there. A Codex child needs a live provider and is asserted absent, not witnessed.

Environment rule per owned process: `HOME` must be set and inside that
instance's own disposable root (`OWNED_PROCESS_HOME_MISSING`,
`HOME_OUTSIDE_INSTANCE_ROOT`). `CODEX_HOME` is not required to be absent: if it
is present it must lie inside that instance's own profile, never `~/.codex`, an
owner location or the other instance's root (`CODEX_HOME_OUTSIDE_INSTANCE_ROOT`).
The receipt records per process only verdicts about them, never their values:
whether each is present (`homePresent`, `codexHomePresent`), the class the one
classifier gave it (`homeClass`, `codexHomeClass`), and whether it lies where it
must (`homeInsideOwnRoot`, `homeInsideOtherRoot`, `codexHomeInsideProfile`,
`runtimeIdentityMatches`). The raw values exist only while a process is checked.
The one observed
exception is the Node runtime child, spawned with an explicit minimal
environment that has no `HOME`. The receipt reports it under `findings` as
`RUNTIME_CHILD_HOME_UNSET` with `severity: info` rather than failing the run,
and it is not an open defect: the runtime's host scope is limited to the three
builtins `node:crypto`, `node:events` and `node:http`, enforced at build by
`assertPreviewRuntimeHostScope` in `tooling/preview-runtime-scope.mjs`, so the
runtime has no filesystem, `os` or child-process access with which to reach a
home directory. Path containment is decided on canonical paths resolved the way
the kernel does (each existing prefix is realpathed before the next component,
including `..`); a `..` after a missing component cannot be resolved and fails
closed. Each launch is recorded and checkpointed in the receipt as soon as it
exists, so a later failure still names every launched pid. Every inventory fails closed, through one runner that every external command
uses (`pgrep`, `lsof`, `ps` and the `KERN_PROCARGS2` probe). Success is exit 0
with empty stderr. The only accepted non-zero outcome is the command's own
documented no-match, with no output: `pgrep` exit 1 (no children); `lsof` and
`ps` exit 1, only for a pid the kernel confirms gone. Any other exit, a signal,
a timeout, stderr output, or partial output beside a failure is an inventory
error naming the command, exit code and stderr, and a failed command's stdout is
never parsed. One `lsof` stderr is tolerated: its verbatim warning that it could
not `stat()` an NFS mount (OrbStack's volume stalls intermittently on this Mac),
only when every stderr line belongs to that warning and each named mount is
clear, in both directions, of the owner's home, the owner locations and the
run's disposable roots, judged without `stat()`ing the mount. Each accepted
mount is recorded in the receipt as `lsofPartialMounts`; any other type, text
or mount is still an inventory error. Each owned process (parent, Go backend, Node runtime child) must
yield a readable, non-empty environment and a clean per-pid `lsof` listing; only
a pid the kernel confirms gone is reported, explicitly, as exited.

Parsing is fail-closed too: every inventory parser (the uid process listing, the
process-tree listing, `pgrep`, `lsof` records, the process command line, the
scanner's and the `KERN_PROCARGS2` reader's JSON) declares its exact row grammar;
blank lines and a documented header (row 0 only) are the only lines it may skip,
any other row that does not match is an inventory error naming the command and
the row index but never the row, and a listing that is empty where it cannot be,
or that lacks an entry that must be there (this test's own pid in the uid
listing, a known live instance process in its tree), is an error, not an empty
answer. Every `lsof` file must declare its type, and an IPv4/IPv6 file its
protocol, so no socket reaches the listener checks unclassified. The
`KERN_PROCARGS2` reader maps the environment one-to-one: a duplicate key or an
entry without `=` makes the environment unreadable instead of dropping a value
before classification.

Sockets: a qualifying listener is **TCP LISTEN on 127.0.0.1 only**. Every
network socket on an owned pid is classified and none is ignored. A TCP record
must carry a recognised state (`MISSING_TCP_STATE`, `UNKNOWN_TCP_STATE`;
checked before the address, so a wildcard with no state still fails). Any other
listener fails with a named code (`UDP_SOCKET`, `IPV6_LISTENER` including `::1`,
`WILDCARD_LISTENER`, `HOSTNAME_LISTENER`, `NON_LOOPBACK_ADDRESS`,
`UNPARSABLE_LISTENER`). A recognised non-listening state (`ESTABLISHED`,
`CLOSE_WAIT`, `TIME_WAIT`, `SYN_SENT`, ...) is a connection, not a listener; its
peer must be `127.0.0.1` (`NON_LOOPBACK_PEER`) and never the other instance's
listener. Unix sockets are not network sockets, and the two instances' port sets
and socket paths must be disjoint.

Process tree: a tree is a moving snapshot. It is rescanned until two consecutive
snapshots agree on the pid set (bounded; `TREE_UNSTABLE` otherwise), every
per-pid check runs on the union of all pids ever seen, and after the quits every
such pid must be gone (`PID_REMAINS`) and a rescan from the original parent must
find no descendant (`NEW_DESCENDANT`). Every Electron the test starts is a tree
of its own and a teardown target: it is never signalled.

Owner locations come from one source of truth: the roots the owner guard itself
fingerprints, read at the start of the run from
`python3 -I scripts/assert-owner-untouched.py --print-protected-roots` (a
read-only flag that prints JSON and starts nothing). If that cannot be read the
witness fails closed (`GUARD_ROOTS_INVALID`, or the inventory error), so the two
lists cannot diverge. The witness adds only what the guard does not enumerate:
all of `~/.farol` and `~/.codex`, `/Applications/Farol.app`, and any directory
under `~/Library/Application Support` whose name starts with `Farol`, so profiles
added later (the Dev Acceptance profile and its nested profiles included) are
covered. Matching is boundary-aware and uses both sides canonically: every owner location
is held in its literal and its canonical form, built once when the guard's roots
are read, and a candidate path is compared in its literal form and as resolved
component by component, so a protected location that is itself a symlink is
matched under its target as well as under its name, and `~/.codex-backup` is not
`~/.codex`. Containment means equal, or the root followed by the path separator
(a `Farol*` profile is a prefix rule); in command text a root counts only when a
non-name character ends it. The temporary-parent refusal and the exemption use
the same rule.

A path inside one of this run's own disposable roots, after following
symlinks, is never an owner location, and that exemption can never cover an owner
location: before anything is created, the temporary parent is resolved
component by component and the run is refused (`TEMP_PARENT_UNSAFE`, nothing
created) if it equals the owner's home, lies inside a guard root, `~/.farol`,
`~/.codex`, `/Applications/Farol.app` or a `Farol*` Application Support profile,
or contains any of them; a disposable root that is itself an owner location is a
hard failure (`DISPOSABLE_ROOT_UNSAFE`) at creation and again at exemption time.

Orphan rule, decided on argv and environment together. A reparented helper is no
longer a descendant, and a disposable root normally reaches a process through
`HOME`, not its arguments. At teardown every process of the current uid that did
not exist when the run started (the uid's pid set is snapshotted at run start and
excluded) is listed through the fail-closed runner (`ps -U <uid> -o pid=,ppid=`).
**Ancestry is decided first, from that pid/ppid table alone**: a new process whose
parent chain reaches a pre-existing process other than launchd (pid 1) and this
test process belongs to someone else, is only counted (`excluded.otherParent`),
and its arguments and environment are never read. **Only the remaining
candidates** (this test's own tree, and new processes whose chain ends at launchd
or at a vanished parent) go to the `KERN_PROCARGS2` reader, and each falls in
exactly one class:

- **survivor** (`ORPHAN_REMAINS`): its argv or environment contains a disposable
  root of this run (every instance home and every launched-but-failed home);
- **unverifiable**, which keeps `teardown.verified` false: its arguments cannot be
  read (`UNREADABLE`, with the errno), or its environment is withheld
  (`ENV_WITHHELD`) and **both** hold: (a) its executable is not under a system or
  application prefix (`/System`, `/usr`, `/bin`, `/sbin`, `/Library`,
  `/Applications`, `/opt`, `/private/var/db`, `/private/var/protected`), so argv
  names no non-test owner; and (b) its parent chain reaches no pre-existing
  process other than launchd (pid 1) and this test process, so a reparented
  orphan (ppid 1) or one whose parent has vanished qualifies;
- **excluded**, counted and never detailed: descended from a pre-existing
  process that is not this test (`excluded.otherParent`, decided before any read),
  or environment withheld but owned by a system or application binary
  (`excluded.systemOwned`);
- **clear** (environment visible, no root) or **gone** (exited; the OS answers
  `EINVAL` as well as `ESRCH` for a just-exited pid, so an unreadable pid the
  kernel no longer knows counts as exited).

Matching happens inside the scanner, which takes the roots on stdin: only
matching pids, this run's own root strings and, for an unverifiable process, its
pid and executable path come back; no other process's arguments or environment
are read into the test, logged or recorded. The receipt keeps only the counts
`{startSnapshot, scanned, clear, gone, excluded, ...}` plus the survivors and
unverifiable entries. Known limit: the OS withholds the environment of hardened
and system binaries, so a root carried only in such a process's environment is
not seen; rule (a) and (b) decide when that is unverifiable rather than ignored.

That teardown proof runs once, in a `finally`, on every exit path (success,
failure, or a launch that failed half way; a launch with no handle still gets the
orphan check on its disposable root). The receipt records
`teardown: { verified, survivors[], instances[] }`. A failed run keeps its
original error and stays UNKNOWN; an unverified teardown also keeps a successful
run UNKNOWN (`TEARDOWN_UNVERIFIED`). The teardown itself never throws out of its `finally`: an inventory failure becomes `teardown.verified: false` with a named `error` (`TEARDOWN_ERROR`), and the server is closed and the receipt written in every case. A survivor is reported with its pid and
reason and is never signalled: the only signals are the existing exact-pid quit
requests.
Receipts are under `_output/preview/isolation/<generation>/`.

## Verification and remaining gates

Allowed source-only checks for this packet:

```sh
node --test tests/tooling/owner-preview.test.mjs tests/tooling/owner-preview-artifact.test.mjs
node --check tooling/owner-preview.mjs
node --check tooling/owner-preview-contract.mjs
node --check tooling/verify-owner-preview.mjs
node --check tooling/owner-preview-assets.mjs
node --check tests/e2e/owner-preview-smoke.e2e.mjs
npm run docs:check
git diff --check
```

The tree fixtures use synthetic app bytes and synthetic PNG/ICNS headers. They
prove allowlist/tamper detection only. They do not prove canonical authentication,
native rendering, packaged startup, profile isolation, provider access or a
usable Preview. Root owns native asset generation, integrated type/static checks,
full CI, canonical package, exact-artifact smoke, independent review, integration
and final acceptance. The first persistent owner run remains manual/on-demand.
Installation, activation, signing, release, beta readiness and production/profile
or tunnel access remain separate boundaries.
