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

The flag runs a strictly read-only report: no runner is constructed, no VM is started or contacted, no lock is taken and nothing is written or deleted. It reports the residue directories, the fence metadata and the required action. Clearing stays manual: confirm the unresolved guest outcome, remove the listed directories and clear the fence by hand. The runner never deletes residue or clears a fence on its own, and the report is the honest `UNKNOWN` record of an interrupted run, not a cleanup tool.

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
(`OWNER_BASE_NOT_READY`), never starts the instance, and never copies service credentials —
the base contains none. A private provision config
(`~/Library/Application Support/Farol Testing/vm-provision.json`) selects the tool binary so
the clone can run from a development build before the next installed release.

KNOWN PREREQUISITE (NEEDS_OWNER, once per base): the base does not have automatic login
enabled, so a fresh clone boots to the login screen where the guest helper cannot run.
Log in once in the BASE, enable System Settings → Users & Groups → Automatic login for
`tester` (FileVault is off), shut the base down, and every later clone boots straight to a
logged-in desktop with the helper answering. Clones made before this step inherit the same
one-time login requirement.

## The closed-contour run shape (machinery in place, first full run pending)

The executor machinery is committed: `--closed` requires an offline machine and a local
artifact (never a download), stages the vm-e2e driver payload with double digest
verification, runs the `e2e` phase in the guest (the serve loop re-verifies the staged
digests before executing), and records the driver's durable `result.json` as the run's e2e
receipt plus the instance provenance. Driver entries committed so far: the egress probe
(documentation-reserved endpoints only) and the guest-local fixture probe (loopback fixture,
fail-closed missing route). The first real closed run still needs a built release artifact
and the autologin prerequisite above; nothing has claimed a closed-contour PASS.

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
