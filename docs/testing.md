# Testing and evidence

Farol has deterministic source gates, real temporary-workspace/process tests, and
built/package Electron fixtures. They answer different questions. See
[current status](status.md) before treating a green test as shipping capability.

## Source gate

```sh
task ci:fast
git diff --check
```

Follow [development setup](standalone-build.md) and use a clean committed tree for
the build-bound Hunt gate. `task test:core` is included and can run separately for
Go generation, imports, race/vet, pipe contracts, and strict desktop compilation.

Run a focused existing test with `npm test -- <test-file>`. Tests co-locate cheap
policy coverage with behavior; native checks use disposable state and exact owned
processes. Preserve failures and their actual cleanup state.

## Evidence classes

| Evidence          | What it establishes                                                     | What it does not establish                                            |
| ----------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Policy/mock       | Rules under the declared ports and simulated outcomes                   | Native host, filesystem, account, or package behavior                 |
| Real local/native | Selected OS/helper/process operation on disposable owned resources      | The user's current connector/account or full detached-process cleanup |
| Built app fixture | Exact development bytes and assembled UI with synthetic provider/host   | Authenticated provider delivery or release readiness                  |
| Packaged fixture  | Exact sealed package, real runtime/views, and declared fixture behavior | Installed update, live host task, or account acceptance               |
| Live/installed    | The exact user-authorized account/host/install operation observed       | Unrelated workflows or later builds                                   |

`BLOCKED`, `NOT_QUALIFIED`, and `SELECTED` are not PASS. A test receipt stays bound to
its own build and declared cases. Later checks do not rewrite earlier failed attempts.

## Native lanes

Run these only with the appropriate native execution/display authority. Packaging
uses `task package` from clean bytes first.

| Command                                                               | Scope                                                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `task test:e2e:dev`                                                   | Exact built development app, full declared lane                                             |
| `task test:e2e`                                                       | Sealed package, full declared lane                                                          |
| `task test:e2e:guided-setup`                                          | Hidden normal Preview/Dev setup fixtures; `-- --behavior` adds the connection-check journey |
| `task test:e2e:guided-setup:package`                                  | Packaged equivalent                                                                         |
| `task test:e2e:setup-config-error`                                    | Hidden classified configuration-fault journey                                               |
| `task test:e2e:setup-config-error:package`                            | Packaged equivalent                                                                         |
| `npm run test:e2e:computer`                                           | Read-only, mutable, and shell Computer MCP on temporary workspaces                          |
| `npm run test:e2e:computer:package`                                   | Packaged Computer equivalent                                                                |
| `task test:e2e:update:package`                                        | Real package identity and update staging/ASAR cleanup boundaries                            |
| `task test:soak`                                                      | Hidden, seeded warm-up and fifty create/close lifecycle cycles                              |
| `task test:persistence-fault`                                         | Hidden live-task-store failure simulation                                                   |
| `task test:two-generation-state -- --predecessor-artifact=<manifest>` | Owner state across two exact sealed generations in one isolated profile                     |

Native process/Seatbelt tests need a host context that supports the operation.
An execution-sandbox refusal is a blocked native boundary, not a reason to remove
the product sandbox or substitute an unrestricted helper. Use the approved native
route upfront where required; do not retry a refused live operation.

## Display and focus policy

Use the least visible execution that preserves the evidence:

1. Policy/geometry: no Electron window.
2. DOM, screenshots, failure, and runtime-death cases: `show: false`, kept hidden.
3. The native-visible interaction run: position before first show on an eligible
   non-primary display and use `showInactive()`.

The selector prefers a non-primary built-in display, then another non-primary
one. It must fit the declared 1180×760 viewport without shrinking it. No eligible
display means a topology `BLOCKED` result before visible windows launch. Every
owned window follows the same contract, including secondary fixture apps.

Without a current grant for native focus:

```sh
task test:e2e -- --skip-native-focus
```

This still needs an eligible non-primary display. It executes the other evidence,
records mandatory focus rows as `blocked-owner-authorization`, and exits nonzero
with a BLOCKED report. It is not a complete native-focus pass.

Only an explicitly authorized built-in-display run may use
`--built-in-display-only --allow-primary-display`. Native activation needs its own
current grant. The harness activates only the isolated test-owned window for that
proof and closes it immediately. Ordinary Dev/product launches retain normal
foreground behavior; `task run -- --hidden` is a separate owner launch mode.

## Disabled routes and selected journeys

Model and Farol-backed Product Agent are disabled. Complete development/package
lanes check `AGENT_NOT_READY` for task start/rejoin without input, assignment, host
request, or child launch. Positive Product Agent rows remain
`productAgentQualification.status = NOT_QUALIFIED`. Setup's separate native lineage
check cannot qualify Product Agent.

`--only=<selector>[,<selector>…]` selects declared segments or case prefixes in
[the selection map](../tooling/e2e-selection.mjs). An unmatched selector refuses
before launch. The result is `SELECTED`, never PASS or combinable acceptance evidence.
Selection cannot be combined with soak, persistence-fault, or two-generation modes.
Some skipped segments still incur their owned launch/close cycle.

## Reports and completeness

Each lane writes immutable `attempts/<attemptId>/` beneath
`_output/evidence/<lane>/`: `started.json`, its own report/path and screenshots,
then `terminal.json` with outcome, first failure, cases, and byproduct hashes.
`latest.json` is a pointer. Interrupted attempts remain retained; a later attempt
never overwrites them.

Display/focus observations, owned PID exits, package/source identity, and scenario
classification belong in the report. Signal submission, pipe EOF, a helper launch
request, or cancellation notification alone does not prove terminal cleanup.

Add new lane cases to [evidence-cases.mjs](../tooling/evidence-cases.mjs) in the same
change as the runner case. Run
`npm test -- tests/integration/evidence-cases-contract.test.mjs`. A partial case list
must not become a completeness proof. Late harness failures retain the journeys
actually run and the original failure; unobserved Quit remains unconfirmed.

Browser-site, tunnel-control, model, and host fixtures remain labelled synthetic.
Current provider selectors, account identity, native shared task results, installed
upgrade/reconnect, and user acceptance need separately authorized exact-build checks.

---

[Documentation index](README.md) · [Project overview](../README.md)
