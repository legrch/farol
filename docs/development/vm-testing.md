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
- `qa:release-dev`, `qa:status` and `qa:connect-dev` are endpoint handoff, the local guest identity proof, and the one-time offline Dev import. Each touches real credentials or the real endpoint, so none is a closed test.

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

A failed or interrupted run can leave staging residue (a `run-*` directory in the machine's artifact inbox) or the effect fence in place. Admission refuses such a machine with `UNRECONCILED_STAGING_RESIDUE` before any guest action: refusal names directory names only, reads no contents and deletes nothing.

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
window on the host. The application itself runs visibly *inside* the VM.

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

The native `terminal-mac mcp` session keeps **one actual input lease** for its
whole stdio lifetime, boots the selected accepted app once, and admits GUI
input only after root/primary identity, foreground and AX window evidence.
Its public stdout is **JSON-RPC only**; build and provisioning diagnostics go
to stderr. It reserves 120 seconds of its 600-second native app session for
graceful Quit/close on clean EOF. A missing helper, permissions, retained lease
or unknown effect must block; never replay a clone/start/native effect simply
because a controller lost the ACK.

The VM runtime is preserved after controller failure or UNKNOWN, as are
staging and original operation evidence. The source/intent/clone receipts are
under the private `Farol Testing/vm-dev-sessions/<clone>/` infrastructure
directory. Only a **new, fully qualified run** should be attempted after the
original custody has been independently reconciled. Existing qa-3/qa-7
unknown outcomes and old input fences are never touched.

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
includes unrelated VM and network-probe tests and should not be invoked as a
live QA substitute. For a real session, separately record the approved
toolchain, source/build/receipt hashes, clone/base receipt, helper version,
runtime-read-only grant, guest permissions, bound native readiness, visual
evidence and original Quit/close outcome. Do not call its whole pipeline PASS
until those exact native/live receipts exist.

The build defaults to `_output/go-build-inputs.json`, the same approved offline declaration used by the existing build lanes. It never silently emits a backend-less application. `--go-inputs` selects build inputs only and cannot accompany an existing artifact. A successful `start` launcher may exit before its detached VM; readiness is attested by a new read-only status naming the runtime PID, separately from the launcher PID.

The controller checks active runtimes in its managed store before cloning and refuses `VM_DEV_CAPACITY_BUSY` when two are occupied. It never stops another session automatically. Clean MCP EOF closes the accepted app, not the VM runtime: release a finished VM with `terminal-mac stop <instance>` and observe its guest shutdown confirmation when needed. Preserve all disks and UNKNOWN evidence. Concurrent starts or VMs in another store can still exhaust capacity after the preflight; retain that original failed start rather than replay it.

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
this entry does not silently seed credentials or browser sign-in. Dev-only
tunnel connection requires its separately selected QA step. A prior guest-only
Dev binding answered connection status, while a catalogue read crossing a
workspace-authority transition timed out and remains UNKNOWN. Source
`f8bf18d2` corrects the independently confirmed catalogue socket budget mismatch
(18 seconds for its 15-second Go lease); 659 bridge tests, typecheck and lint
pass. This does not retrospectively qualify that live catalogue or shell/file
operations. Full CI and exact-head independent acceptance remain separate.
