# Guest VM testing contract

This page is the testing contract for the guest macOS VM work: what the `task test` aggregate includes, why the live guest journeys moved to `qa:*`, how the VM is planned to become an executor option for ordinary E2E suites, and the runner's input-lease and reconciliation contracts. The operating reference for running those journeys is [Guest VM smoke](vm-smoke.md); source test scopes are the [GUI test policy](../testing.md).

## The `task test` aggregate

`task test` is the complete automatic closed-contour aggregate. It runs every automatic test leaf exactly once, in a fixed order, and nothing that needs a live provider account, a human eye or a packaged candidate.

```sh
task test
```

Its leaves are `test:core`, `test:tooling`, `test:unit`, `test:integration`, `vm:test`, `test:witness-inputs`, `test:e2e`, `test:e2e:guided-setup`, `test:e2e:setup-config-error`, `test:e2e:chatgpt-startup-readiness`, `test:persistence-fault` and `test:soak`. Each leaf appears exactly once; the aggregate does not nest other aggregates, so no leaf is silently skipped or double-executed. A failing leaf stops the aggregate, and the leaves behind it are NOT RUN rather than silently skipped.

Deliberately outside `task test`, and why:

- `qa:*` journeys use real Dev services, real accounts, the tunnel and visual judgment; they are QA, not closed tests.
- Package-candidate E2E variants (`test:e2e:guided-setup:package`, `test:e2e:setup-config-error:package`, `test:e2e:update:package`) require an exact packaged candidate and are package-acceptance work, not automatic closed-contour leaves.
- Parameterized witnesses (`test:e2e:owner-preview-isolation` with `--generation`, `test:two-generation-state` with `--predecessor-artifact`) need caller-supplied inputs that no aggregate can invent, so they stay explicit entrypoints.
- Dev-byte journeys (`e2e:setup`, `test:e2e:dev`) exercise development bytes instead of packaged candidates; their evidence class differs from the packaged lanes in the aggregate.
- Static gates and subsets (`test:fast`, `test:cloud`, `test:affected`, `test:inventory`, `output:check`, `scan:secrets`, coverage, format and lint) are separate: the first two are subsets of the leaves above, and the rest belong to `task ci`.

There is no `test:all` and no `test:vm`, and neither may be added. A VM lane is either offline and closed — `vm:test`, already a leaf of `task test` — or it is QA under `qa:*`. A third hierarchy would blur exactly the line this contract draws.

## QA and tests are different namespaces

Real Dev services, real accounts, the real tunnel and visual judgment are QA, not tests. The guest journeys therefore live under `qa:*`:

- `qa:smoke` is a bounded exact-release UI smoke in the dedicated guest. Its lifecycle rows close, but its UI rows are `NEEDS_REVIEW` by design: an agent or human inspects the screenshots afterwards, and no automated assertion upgrades that review into a pass.
- `qa:release-dev` and `qa:status` (endpoint handoff and the local guest identity proof) are BLOCKED today: both use the legacy Terminal bootstrap, which refuses with `TERMINAL_SHELL_READINESS_UNPROVEN` because no helper advertises `terminal-shell-readiness/1`. Each would touch the real endpoint, so neither is a closed test. `qa:connect-dev` is BLOCKED: it refuses with `DEV_IMPORT_UNQUALIFIED` before any VM, staging or key access because no guest Dev credential importer is qualified, and nothing exports a credential.

`qa:*` never appears inside `task test`, `task ci` or any aggregate. "Smoke" means a short, bounded scenario — not a reduced test suite. Automated clicks driving the same guest do not turn live QA into a closed test: the accounts, tunnel and judgment calls remain live, so the honest classification stays QA. Conversely, `vm:test` stays fully offline and closed and never touches a real account, tunnel or VM.

## VM as an executor option on ordinary E2E

The plan is that the VM becomes an executor/configuration option on the ordinary E2E suites — the same journeys, run in the dedicated guest instead of a hidden window on the host. The exact option syntax is deliberately undecided until that executor is qualified; do not document or script a spelling before then.

The qualified executor must respect boundaries that differ from host E2E:

- Guest-local fixtures: fixture and disposable state live inside the guest and are created there before the application starts.
- Default-deny egress before app startup: the guest reaches no host or internet service until the suite explicitly admits a connection, and the default posture is deny.
- Host localhost is not guest localhost: a service listening on the host loopback is unreachable from the guest's NAT network unless explicitly exposed, so suites must not assume a shared loopback.

Until that qualification exists, `qa:smoke` remains the only packaged-release guest lane, and no aggregate claims VM-executed E2E coverage.

## Guest input lease

The smoke runner consumes terminal-mac's exclusive input lease so guest input cannot be driven by two writers at once. The settled contract: the runner holds `flock` on the machine's `input-lease.lock` under the owner `farol-smoke:<run>` for the duration of its guest work; it publishes the exchange `.input-lease.json` flag so terminal-mac can see the lease holder, and passes `--owner` through to terminal-mac actions; a competing guest action is refused with `GUEST_INPUT_LEASE_HELD`; and `terminal-mac lease NAME status` reports a machine's lease holder without touching it.

Beyond these settled points, the lease wire format and terminal-mac's mailbox reply/artifact slots, typed outcome provenance (`noEffect`/`confirmedNoCopy`/`mutationUnknown`) and explicit `action --vm NAME ACTION` targets are terminal-mac contracts; this repository documents only what its runner consumes.

## Read-only staging reconciliation

A run that fails before any guest effect removes its own `run-*` staging and reports it as `removedStaging`. A failed or interrupted run after an effect keeps its staging (a `run-*` directory in the machine's artifact inbox) and the effect fence as evidence, listed as `retainedStaging`. Admission refuses a machine whose inbox holds recognized staging residue (`blob-*`, `app-payload.json` or legacy credential names) with `UNRECONCILED_STAGING_RESIDUE` before any guest action: refusal names directory names only, reads no contents and deletes nothing. An effect fence refuses the machine regardless.

```sh
task qa:smoke -- --reconcile-staging
```

The flag runs a strictly read-only report: no runner is constructed, no VM is started or contacted, no lock is taken and nothing is written or deleted. It reports the residue directories, the fence metadata and the required action. An unresolved effect needs explicit reconciliation of its original operation. Never remove its staging or fence merely to permit another attempt. The sole automatic refusal cleanup is an exact first native `open` acknowledgement carrying typed `noEffect`, before any prior effect: under the same owned lease, the runner retains its payload outside the active artifact inbox and writes a durable retention receipt before clearing its own unstarted fence. This does not recover an interrupted or outcome-unknown operation. The report itself stays read-only and never performs cleanup.

## Renaming the pilot machine to farol (PERFORMED 2026-11-08)

The rename was executed and verified on 2026-11-08: the guest shut down through the normal
macOS Shut Down dialog (the ACPI `vm.requestStop()` path stalled; see the terminal-mac
VALIDATION receipt), `terminal-mac rename pilot farol` moved the machine directory with
identical identity digests, the `rename.json` receipt records the mapping, and the source
spec, example config, provisioner default and private infrastructure config now target
`farol`. Historical evidence directories keep their original references.

## Clean run instances from the prepared base (PERFORMED 2026-11-09)

The base machine `farol-base-1` was installed from the cached local IPSW (no download), its
Setup Assistant, helper installation and both privacy grants were completed by the owner, and
its base receipt (`~/Library/Application Support/Farol Testing/base-receipts/farol-base-1.json`)
records `helper: READY` with the granted permissions. Two run instances were provisioned by
real clones with distinct VM identities and provenance receipts:

```bash
node tooling/vm-machine.mjs --provision-instance farol-qa-1 --base farol-base-1
node tooling/vm-machine.mjs --provision-instance farol-qa-2 --base farol-base-1
```

For a new closed-run instance, add `--offline` to `--provision-instance`. The base remains
unchanged and the clone's stored configuration is checked before its receipt is written. This
does not attest the running guest's isolation; that remains a separate qualification step.

Readiness receipts must now bind the exact `base`, physical `vmHome`,
`storeIdentity` and `machineIdentity` (`[st_dev, st_ino]` for the store and base
directories), `machineSha256`, and the qualified immutable hardware file's
single-component `hardwareFile` and `hardwareSha256`. The hardware file is selected
by the base's independent qualification; the controller never guesses one or upgrades
an old receipt. Missing or changed bindings refuse before cloning and require
requalification of the selected clean base. Provenance retains the digest
of the exact receipt bytes admitted by the planner, even if its pathname later changes.

**Base receipts are written by the operator procedure, not by this repository.**
No in-repo tool writes or requalifies `base-receipts/<base>.json`; the operator
who prepares or requalifies a base records it by hand after observing the guest.
The planner reads `schema`, `base`, `helper` (`READY`), `account` (`tester-ready`)
and the binding fields above. When the receipt also records `helperVersion` and
`helperBuild` (receipts written since build 17 do), `vm:dev` requires the live guest
helper of the fresh clone to report exactly that version and build before the MCP
session, refusing `VM_DEV_HELPER_BUILD_MISMATCH` otherwise (a rebuilt helper voids
its privacy grants). Older receipts without them are recorded as
`unbound-base-receipt`. No receipt records a guest disk identity today (`diskSha256`
is `null`), so the guest disk is not bound: a macOS update or other change applied
inside a booted base is not detected by the receipt and needs requalification.

`vm:setup` retains create-only provisioning intents under
`vm-machine-operations/<machine>/` in the testing settings directory. Every
dispatch gets a unique operation ID; the complete owned directory chain is
revalidated and synced on every entry, including existing ancestors. Intent
files and parent entries are synced before `create`, `clone` or `start`. A
per-machine cooperative lock serializes dispatch and explicit reconciliation.

Successful dispatches retain their original intent plus a durable zero-exit
terminal receipt. A separate read-only `terminal-mac status <machine>` must
confirm the selected name and state (`stopped` for create/clone, `running` or
`stopped` for a completed start). The durable resolution binds both receipt
digests, the operation ID, physical store and machine directory identities,
and machine configuration bytes. Admission validates this historical chain;
only unresolved or changed records block. A later setup checks fresh `stopped`
status before admitting a new start, so confirmed normal shutdown permits
another session without deleting history. `vm:dev` independently allocates a
new clone and evidence directory each run.

For an interrupted confirmation after a recorded zero exit:

1. Run `node tooling/vm-machine.mjs --reconcile-operations <machine>` to inventory
   retained evidence without contacting the VM. `RESOLVED`, `UNRESOLVED` and
   `ABSENT` describe provisioning history, not current VM readiness.
2. Run `node tooling/vm-machine.mjs --resolve-operations <machine>` explicitly.
   It requires the original zero-exit terminal receipt and a fresh read-only
   status bound to the original operation and machine. It writes a create-only,
   synced resolution; it never repeats create, clone or start.
3. Inventory again. Keep every original intent, terminal receipt and resolution.
   Continue setup only after `RESOLVED` and independently confirmed shutdown.

Timeouts, nonzero exits and missing terminal receipts stay `UNRESOLVED`; current
runtime state alone cannot establish their original outcome. Legacy intents
also stay blocking. This controller cannot reconstruct missing terminal proof:
preserve that evidence for separate explicit reconciliation, and never delete
fences or invent a receipt to make admission pass.

Provisioning refuses to run until the base receipt records the owner setup
(`OWNER_BASE_NOT_READY`) and never starts the instance. A clone copies the base disk,
including any accounts and credentials already present; use a separately verified clean base
for closed tests. Provisioning does not import credentials from the host. The private
infrastructure config (`~/Library/Application Support/Farol Testing/vm-smoke.json`, or the
file selected by `FAROL_VM_CONFIG`) selects the tool binary and VM data root.

The base needs automatic login and a helper that starts in the `tester` session. Configure
those once in the base, shut it down, then qualify a new clone's boot and helper permissions.
Existing clones retain the state of the base when they were made. A helper timeout alone does
not establish whether the guest is at login, whether automatic login is configured, or whether
helper permissions are intact; inspect the guest before assigning a cause.

## The closed-contour run shape (machinery in place, first full run pending)

The executor machinery is committed: `--closed` requires a stopped machine with offline
configuration and a local artifact (never a download), stages the vm-e2e driver payload with double digest
verification, runs the `e2e` phase in the guest (the serve loop re-verifies the staged
digests before executing), and records the driver's durable `result.json` as the run's e2e
receipt plus the instance provenance. Driver entries committed so far: the egress probe
(documentation-reserved endpoints only) and the guest-local fixture probe (loopback fixture,
fail-closed missing route). The first real closed run also requires a qualified guest executor. The legacy Terminal route now refuses before typing unless the helper issues the versioned shell-readiness capability; frontmost Terminal or a screenshot is insufficient. Current native AppService supports a finite installed lifecycle, not arbitrary driver or shell execution. Nothing has claimed a closed-contour PASS. A closed run
refuses to adopt an already-running VM and rechecks its configuration after startup. These
checks do not attest the live VZ network attachment; runtime isolation needs separate evidence.
The run's `networkPolicy` therefore says `machine.json-offline-configured` with
`runtimeEgress: not-verified`, never "verified". The egress probe cannot prove isolation:
its reserved targets are unreachable from an online guest too. It can only contradict the
configuration: any connectable endpoint (`externalConnectable: true`) fails the run with
`CLOSED_CONTOUR_EGRESS_OBSERVED` and records `runtimeEgress: observed`. A meaningful
positive control (a target reachable only when the guest is networked, such as a host
listener on the NAT gateway recorded by terminal-mac) is not implemented. `vm:test` never
runs the probe against the network; it uses in-memory DNS/TCP doubles and loopback only.

The driver bundle (`tooling/vm-e2e/bundle-driver.mjs`) may only statically import `node:`
builtins outside a denylist of loaders. Refused: dynamic `import()` in any form,
`createRequire`, `node:module`/`vm`/`worker_threads`/`child_process`/`test`/`sea` and
similar, `process.dlopen`/`binding`/`getBuiltinModule`/`execve`, `import.meta.resolve`,
`eval` in any form (direct, `globalThis.eval`, aliased, indirect) and the `Function`
constructor (by name, through `Reflect.construct` or `.constructor`). The policy is
syntactic and is not a sandbox: computed access through a variable (`process[name]`)
cannot be decided statically. The runner re-applies it to the exact bundle bytes before
staging and binds the manifest's entry by `entrySha256` to the entry file in the runner's
own working tree (not the committed blob; an uncommitted edit there is accepted) rather
than by name. Remaining gap: modules the entry imports are not bound, and the bundle
bytes are not re-derived from committed source (no reproducible rebuild comparison, no
source commit or clean-tree record).

## Native installed lifecycle and Dev artifacts

`qa:smoke -- --native-app-service --native-relaunch --artifact <archive> --expected-app-sha256 <accepted-tree>` selects the compiled guest AppService. The expected application tree must come from independently accepted release evidence, never from the archive currently being admitted. It requires a compatible helper and live VZ evidence that artifacts are shared read-only. Host scripts are not run in the guest.

The producer binds archive, complete payload tree and finite signature policy through a separate accepted-application commitment. The helper verifies bytes before atomically publishing a new guest `/Applications` app; it never overwrites a pre-existing application. The official unsigned outer bundle is handled explicitly, while the fixed launcher and signed executable checks retain the documented installer policy. Launch, activation, normal Quit and relaunch each need bound receipts and observations. A closed native lifecycle is not provider, tunnel, visual or update acceptance.

The build-only `tooling/vm-dev-artifact.mjs` creates a **local Dev derivative** from a clean exact source build with authenticated resources and vendor runtime. Its new physical, empty output directory must be directly under `_output/vm-dev/`. It creates `Farol Dev.app` with `local.farol.dev`; the fixed launcher selects Dev before any storage opens and accepts no arbitrary arguments. It does not launch a host app, read any host profile, configure a tunnel, or update the host Dev cache. Its derivative receipt retains the original build identity separately from the guest Dev presentation. It is not an official release or a completed interactive VM session.

A usable agent session additionally requires qualified installed process identity, a single input owner, guest screenshots/input, and explicit clean-stop versus UNKNOWN handling. Until live qualification closes those predicates, source builds and offline tests must not be described as `READY_FOR_AGENT`.

## Honest status vocabulary

Reports use a closed vocabulary; a status is claimed only when its evidence exists:

- `PASS` — the declared checks ran and succeeded on the exact bytes.
- `FAIL` — a declared check ran and failed; the failure is preserved.
- `BLOCKED` — a declared prerequisite is unavailable; nothing ran behind it.
- `UNKNOWN` — an operation started and its outcome is not established; never reinterpret it as success or as retryable.
- `NOT RUN` — a declared check this attempt did not execute; distinct from `BLOCKED` when the reason is scoping rather than an unmet prerequisite.
- `NEEDS_OWNER` — the next step requires an owner decision or credential and cannot proceed automatically.
- `NEEDS_REVIEW` — visual judgment is owed; the guest smoke's UI rows end here by design, and automation does not upgrade them.

No receipt is fabricated: a missing report leaves the count or outcome explicitly unavailable, failed cleanup keeps its `FAILED` disposition, and a result is never upgraded from a failed or unknown state into a pass.

[Guest VM smoke](vm-smoke.md) · [Testing policy](../testing.md) · [Development](README.md)

## Interactive Farol Dev VM entry

### `task vm:dev` (live, manual QA; not part of `task test`)

From the Farol source checkout, after the source and dependencies have been
committed and verified, run:

```sh
task vm:dev
# Or select the independently approved offline compiler inputs:
task vm:dev -- --go-inputs=/absolute/path/go-inputs.json
```

The entry runs the exact-source build-only `tooling/build.mjs`, assembles the
self-contained local **Farol Dev.app** derivative, selects its receipt digest,
creates a local-only ZIP, then uses `vm-machine.py`'s configured
`farol-base-1` prepared-base admission to create a **new** guest clone. It
stages the accepted payload through the finite compiled native app service and
replaces its controller with the configured `terminal-mac mcp` process. VM
viewer windows are hidden by default; pass `-- --visible` to show the guest
window on the host. The application itself runs visibly _inside_ the VM.

For a separately approved, already-built Dev derivative (no rebuilding),
provide all three expected inputs; no stable-release ZIP is accepted:

```sh
task vm:dev -- \
  --artifact /ABSOLUTE/Farol-Dev.zip \
  --receipt /ABSOLUTE/vm-dev-artifact.json \
  --expected-receipt-sha256 <64-lowercase-hex>
```

Both files must be inside one private `_output/vm-dev/<run>/` directory from
this checkout. `--config /absolute/private/vm-smoke.json` selects the same
approved `terminal_mac` binary and `vm_home` as `vm:setup`; the default
`FAROL_VM_CONFIG` resolver is also respected. Neither selector authorizes a
host Farol path, profile, credential, tunnel or guest shell command.

The same private config may name the prepared base in `prepared_base`
(default `farol-base-1`). Each run instance is still cloned only from a base
whose own receipt under `base-receipts/` says helper READY and tester-ready.

Preparing a base after a helper rebuild: the ad-hoc rebuild changes the helper's
code identity, so in the guest remove TerminalMacGuest with "−" and add it again
with "+" under **Privacy & Security → Device Control and Data Access** (macOS 27's
name for the Accessibility list) and **Screen & System Audio Recording**. Turn off
automatic macOS updates in the base (needs the guest account password). Stopping a
guest shows macOS's own shutdown confirmation; `terminal-mac stop
--confirm-guest-dialog` presses it once when the helper has Accessibility.

The native `terminal-mac mcp` session keeps **one actual input lease** for its
whole stdio lifetime, boots the selected accepted app once, and admits GUI
input only after root/primary identity, foreground and AX window evidence.
Its public stdout is **JSON-RPC only**; build and provisioning diagnostics go
to stderr. It reserves 120 seconds of its 600-second native app session for
graceful Quit/close on clean EOF. A missing helper, permissions, retained lease
or unknown effect must block; never replay a clone/start/native effect simply
because a controller lost the ACK.

**The controller removes what it creates.** The MCP child inherits the agent's
stdin/stdout; the controller waits for it and then tears down:

- **Clean close** — MCP exit 0 _and_ terminal-mac's own immutable
  `mcp-app-sessions/<run>/terminal.json` says `CLOSED` for this run with both
  original exits observed and a verified tree. The controller copies that
  session directory into its evidence, stops the guest it started once
  (`terminal-mac stop <clone> --confirm-guest-dialog`, never `--force`), confirms
  `stopped` with a fresh status, and deletes the clone it created.
- **Known refusal after a confirmed start** (writable artifact share, helper
  contract, custody or permissions, helper unavailable, MCP spawn refused) and
  **failure before the guest ran** (staging, stage directory) — the same stop
  (when started) and delete.
- **Unknown outcome** (clone, start or runtime readiness unknown, unconfirmed
  instance receipt, MCP non-zero or signal exit, a clean exit without the CLOSED
  record, cancellation or an unclassified error) — nothing is stopped or deleted.
- **Teardown that cannot be confirmed** (stop not confirmed, deletion guard
  refused, a signal during teardown) — the clone and runtime are kept.

There is no terminal-mac delete command: deletion removes the clone's directory
under the machines root, and only after positive identification — the
`farol-qa-<16 hex>` grammar (never a `farol-base-*`), this run's own instance
receipt with the digest recorded when it was written, terminal-mac's clone record
naming the selected base, a physical owned directory directly inside the machines
root, and a fresh `stopped` status. Each stop and delete has a create-only intent
and receipt.

Retention rule: whenever anything is kept, `vm-dev-sessions/<clone>/result.json`
records the status (`CLOSED_AND_REMOVED`, `REFUSED_AND_REMOVED` or `RETAINED`),
the classified reason, what was removed and what was retained, and the controller
prints `VM_DEV_RETAINED <path>` lines on stderr. The private evidence directory
itself is always kept. Exit status is 0 (closed and removed), 1 (refused, nothing
retained beyond evidence) or 2 (retained). `vm-dev.mjs` deletes the
`_output/vm-dev/run-*` directory it built when the session exits 0 or 1, removes
it as well when assembly or archiving refuses, and otherwise keeps it and prints
`VM_DEV_OUTPUT_RETAINED <path>`. An explicit `--artifact` directory is never
removed. Only a **new, fully qualified run** should be attempted after retained
custody has been independently reconciled. Existing qa-3/qa-7 unknown outcomes
and old input fences are never touched.

`task vm:dev` is a **live operator action**, not a closed-contour test and not
proof of installed product readiness merely because startup succeeded. The
finite native MCP itself must publish READY_FOR_AGENT after independent
observation. No host production app/profile, automatic dependency install or
Dev tunnel import is part of this entry. Live Dev connectivity is separate.

### Offline source qualification

The closed-contour `vm:test` inventory includes two new independent leaves:

```sh
node --test tooling/vm-smoke/vm-dev-controller.test.mjs
/usr/bin/python3 -B -m unittest discover -s tooling/vm-smoke -p 'test_vm_dev_session.py'
```

These use synthetic receipts and injected process/module stubs, not VM boot or
installed helper execution. The existing `vm:test` aggregate additionally
includes unrelated VM and offline network-probe tests and should not be invoked as a
live QA substitute. For a real session, separately record the approved
toolchain, source/build/receipt hashes, clone/base receipt, helper version,
runtime-read-only grant, guest permissions, bound native readiness, visual
evidence and original Quit/close outcome. Do not call its whole pipeline PASS
until those exact native/live receipts exist.

The build defaults to `_output/go-build-inputs.json`, the same approved offline declaration used by the existing build lanes. It never silently emits a backend-less application. `--go-inputs` selects build inputs only and cannot accompany an existing artifact. A successful `start` launcher may exit before its detached VM; readiness is attested by a new read-only status naming the runtime PID, separately from the launcher PID.

The controller checks active runtimes in its managed store before cloning and refuses `VM_DEV_CAPACITY_BUSY` when two are occupied. It never stops another session automatically. A machine whose status is unreadable or outside the known states (for example `error`, or a partial clone left by an unknown outcome) refuses with `VM_DEV_CAPACITY_UNKNOWN machine=<name> state=<state>` and the manual resolution; it is never deleted automatically. Clean MCP EOF closes the accepted app; the controller then stops and removes its own clone as described above. Disks are kept only for UNKNOWN outcomes or unconfirmed teardown. Concurrent starts or VMs in another store can still exhaust capacity after the preflight; retain that original failed start rather than replay it.

### Agent configuration and qualified scope

An agent attaches this entry as an MCP stdio server, rather than expecting a
shell REPL from its stdout. For example, substitute the actual source checkout:

```json
{
  "mcpServers": {
    "farol-vm": {
      "command": "task",
      "args": ["--dir", "/ABSOLUTE/farol", "vm:dev"]
    }
  }
}
```

The client initializes MCP and uses `status`, `screenshot`, `click`, `type`,
`key` and `scroll`. Input belongs to this guest, even while its viewer is hidden.
The same command with `-- --visible` shows the guest; it does not switch the
application to the host. Cold AX readiness can precede the first rendered page;
inspect a subsequent screenshot before selecting UI coordinates. Clean stdin
EOF requests normal application Quit and close. Confirm the immutable native
terminal receipt says CLOSED and both root/UI-primary exit observations exist;
a stopped VM alone proves none of those application outcomes.

On November 12, the clean Farol source checkpoint `07e653b0` with installed
terminal-mac build14 completed this default command without special flags:
source build, local Dev derivative, fresh prepared-base clone, inherited helper
grants, MCP READY, Setup/Home/menu rendering, guest keyboard/text input and
normal Quit/close. The live clone was hidden throughout. Build14 uses a live
monotonic app-session timebase, so guest wall-clock synchronization cannot
consume or extend the service lifetime. Persisted sessions remain non-adoptable.

The separate official 0.5.22 native smoke completed two launch/normal-Quit
lifetimes and close with a distinct primary PID and one observed window on
relaunch. Its initial screenshot was still black; its relaunch screenshot
rendered Setup. Visual findings remain separate from lifecycle receipts.
Neither result qualifies real Dev credentials, ChatGPT sign-in or the tunnel.
The interactive accepted-app session also does not admit a changed application
generation after an updater replaces its accepted bytes. End the bound session
cleanly before a separately selected generic guest-computer QA journey; record
real updater journal/successor evidence independently. Never treat two archive
installs or a VM restart as a product-update pass.

### Helper16 functional qualification (November 12, 2026)

Clean source `54b407a9` completed the exact default `task vm:dev` with installed
terminal-mac build16: source build, accepted Dev derivative, fresh hidden clone
`farol-qa-1280f3a0bd8f43ce`, inherited login/helper grants, READY_FOR_AGENT,
rendered Setup/Home, menu bar and guest keyboard/text input. Clean EOF returned
zero; immutable session `run-9f01ffc24bcd46bfba10d1119a90c5b5` is CLOSED with
both original exits observed and installed bytes verified at close. The input
lease was independently free, and the guest then shut down normally. The first
frame was render-pending; the later UI screenshots supply the visual evidence.

Fresh `farol-qa-15` independently completed the official 0.5.22 native
install/launch/Quit/relaunch/Quit/close sequence, with distinct primary PIDs and
one observed relaunch window. After that accepted session closed, a separate
generic guest MCP journey used the real updater to download and install
0.5.23. Home and a subsequent Quit/reopen showed 0.5.23 with one sensible Setup
window. The guest updater record reports `phase=completed`,
`archiveReleased=true` and target running build
`9586e3cf827b269ad35dbb75102bb10583c1ed1a394d7a1d621e2238bb9a0729`.
This is actual product-update evidence, separate from accepted-app lifecycle.

Earlier helper14/helper15 UNKNOWN records remain unchanged. Helper16 adds only
bounded full torn-read sampling before termination; post-terminate identity,
drain and close checks remain strict. No VM/profile deletion, host Farol launch
or host security-setting changes were used.

This qualifies the local VM operator tool, not a full product release or a
real-account scenario. Each default clone starts with a fresh guest Dev profile;
this entry does not silently seed credentials or browser sign-in. No automated
Dev-only tunnel connection exists: `qa:connect-dev` refuses, so a guest Dev
connection can only be entered by hand in the guest UI. A prior guest-only
Dev binding answered connection status, while a catalogue read crossing a
workspace-authority transition timed out and remains UNKNOWN. Source
`f8bf18d2` corrects the independently confirmed catalogue socket budget mismatch
(18 seconds for its 15-second Go lease); 659 bridge tests, typecheck and lint
pass. This does not retrospectively qualify that live catalogue or shell/file
operations. Full CI and exact-head independent acceptance remain separate.
