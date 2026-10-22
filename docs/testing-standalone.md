# Standalone test entrypoints

This source inventory covers the 23 `tests/e2e/*.e2e.mjs` entrypoints at
`c3616b5a2371a9d78dbaa1c8adc435974328760c`. It records existing selectors and
prerequisites, not execution or acceptance. The later C09 TSX discovery correction
does not register these scripts in `test:unit`, `test:integration` or `test:fast`.
See [testing scopes](testing.md) for the commands that are implemented.

The external Go connector switch has additional tests outside this historical
E2E inventory. `tests/unit/go-computer-mcp.test.ts` uses the MCP SDK in memory;
connector client/host/launch/verification unit files use bounded offline fixtures.
`go test -race -p 1 -run '^TestNativeConnectorSocket' ./transport/desktop`
uses real disposable Darwin sockets and files and needs the exclusive native
lane. It does not launch Electron, a child backend or a provider. Existing E2E
scripts that construct `computer-launch.json` select the legacy adapter; they do
not prove the normal desktop `computer-go-launch.json` path. That path still
needs measured package, normal Dev and genuine external-client evidence.

`tests/integration/go-connector-launch.test.ts` covers the production protected
launch loader using real disposable files, path substitution and one bounded
`mkfifo` child. It requires the same native lane and does not establish normal
application startup. Authoring or compiling this suite is not native execution
evidence.

`go-computer-mcp.e2e.mjs` consumes an independently pinned schema-4 candidate:

```sh
node tests/e2e/go-computer-mcp.e2e.mjs --check \
  --candidate-root /absolute/preserved/app \
  --source-sha <40hex> --build-id <64hex>
```

Replace `--check` with `--run-native` only in the exclusive native lane. The
runner verifies the build/input/core manifests and every joined production
source against the candidate's sealed input ledger. It compiles a separate
recorded test controller; it does not rebuild the candidate. Its source-matched
DesktopGoCore constructor opens disposable authority and the real Go publisher,
then the candidate's actual MCP executable serves a bounded legacy stdio client.
The journey covers catalogue/bootstrap/list/read/search, a hash-bound create/edit,
duplicate suppression, retained result after reconnect, current authority
withdrawal, ordinary closure and refusal with the selected backend closed.
MCP children close through EOF without signal escalation. Go uses the production
host cleanup and clean-retirement checks; a failed or forced retirement does not
pass the journey. Failed or uncertain fixtures remain preserved. Reports record
candidate and controller identities and content-free request progress.
This is native adapter composition, not normal Electron startup, a tunnel,
ChatGPT-client, installed workflow or complete network-containment qualification.
The standalone entry is not registered in an aggregate by this documentation.

The shared identity import surface in `tooling/harness-identity.ts` and witness
configuration in `tooling/exact-package-witness-inputs.mjs` are declared
attested harness entries. The candidate builder compiles them and their transitive
imports through the same source/dependency input hook as packaged scripts. It
is not an exception to the witness's byte comparison. Exact test-owned controller
inputs are declared separately in `tooling/exact-package-witness-inputs.mjs`;
new helpers and dependencies must occur in the sealed ledger.

`node tooling/build.mjs --check-witness-inputs` compiles the actual candidate
script graph with writes disabled, then checks every transitive input of the
registered exact-package witnesses against that graph and the exact controller
exceptions. `task test:witness-inputs` runs this cheap check on Darwin, where the
reviewed packaging compiler is available; `task ci` and the hosted `native` job
include it, and the Linux `task ci:cloud` gate does not. It does not build Go/native resources, execute a
witness, allocate a profile, or replace an existing candidate. Candidate builds
repeat the same coverage check before sealing their input ledger.

The separate `connector-daily-lifecycle.e2e.mjs` packaged witness keeps a bounded
fixture journal of TERM delivery, exit-handler entry and completion of the
synchronous atomic exit-receipt write. It copies those observations into the
suite report unconditionally from cleanup's `finally` path, before deleting
owned roots, including when recovery times out or Quit fails before receipt
validation. Trace discovery is independent of terminal receipt parsing; each
available journal is retained even if another trace cannot be read. Read
failures are reported separately and fail cleanup without replacing the
original case failure.
The journal is diagnostic only: every owned tunnel still needs its original
`phase: "exited"`, `exitCode: 0` receipt and confirmed process/group absence.
A running receipt or a tunnel killed before its own exit receipt is never
converted into a clean exit.

Connector mutations have separate lower-layer evidence:

- `TestConnectorV3*` in Computer domain and repository tests checks exact retained
  bytes, full uint64 connector generation, immutable origin and shared-key
  conflicts. Repository effects are injected memory storage.
- `TestConnectorMutation*` and `TestConnectorObservation*` in the mutation service
  use injected authority, journal and native ports to check one-effect execution,
  expiry, current read guards and retained uncertainty.
- `TestConnectorContract*` checks explicit DTO mapping and original result copies.
- `TestConnectorMutationRead*` in `boot/` joins the real connector/execution read
  policy with injected storage and endpoint, including final withdrawal.
- `TestConnectorMutationRoot*` joins the same mutation owner, Settings operation
  ledger and retirement gate. It checks concurrent duplicates, current-authorized
  observation after reconnect, and uncertainty surviving connector close. Native
  storage, effects and endpoint drain remain explicit doubles.
- `TestConnectorMutationWire*` invokes the actual registered Go handlers with
  those owners. It covers strict request identity and bounds, write/edit receipt
  mapping, duplicates, closed slots, current read authority and original retained
  provenance after reconnect.
- `desktop-connector-client.test.ts` uses injected streams to check required
  effect IDs, same-stream duplicate suppression, exact outcome correlation and
  unknown transport outcomes. It does not execute a native socket or mutation.
- `desktop-connector-mutation.test.ts`, `connector-mutation-wire.test.ts` and the
  mutation cases in `go-computer-mcp.test.ts` check the generated field limits,
  current/original identities, content-free outcomes, handshake advertisement
  and existing MCP fence/drain with injected clients and in-memory SDK transport.

These selectors neither run native effects nor qualify the external mutation
route, clean retirement, installed recovery or a live ChatGPT connector.

`go test -race -p 1 -run '^TestNativeConnectorMutation' ./boot -ingress-native`
uses the normal Go runtime with an actual private Darwin socket, mutation journal
and disposable workspace. It covers create, collision, exact-hash edit, stale
preimage refusal, reconnect observation, duplicate suppression and current
authority withdrawal. Workspace approval and the inherited host open call remain
fixtures. No Electron, child backend, MCP process, provider or real host retirement
is exercised. It requires the exclusive native lane. The adjacent
`TestNativeSettingsMutation*` suites protect the shared owner's Settings and
retirement behavior, with explicit fixture terminal/host facts.

The complete `task test` union remains open. A missing binary, artifact,
predecessor, containment mechanism or authorized display leaves its required
scenario blocked. A check-only, build-only, selected reproduction or blocked-focus
result is not a complete-suite pass. Do not invoke these scripts as one batch
without reconciling their prerequisites and original operation outcomes.

## Existing scripts and scopes

All names below are relative to `tests/e2e/`. "Default" means no scenario flag.
Development and package artifacts are distinct evidence inputs. Adapter tests
exercise production collaborators but do not establish the normal application
journey. Native-client compatibility below uses synthetic upstreams and does not
prove a live authenticated provider or whole-process containment.

After the Setup redesign, explicit retirement is coverage evidence of `NOT_RUN`, not a passing native journey. Source behavior remains covered by `npm run test:renderer` and the focused help-routing, Setup-helper and retirement unit tests. Those checks do not replace built-app, native-host, installed or live-provider evidence.

`sign-in-continuity.e2e.mjs` adds a separate current journey to the historical
inventory below. It requires a clean exact schema-4 build, explicit absolute
`FAROL_RENDERER_TEST_ELECTRON_ROOT` validated by the runtime contract, and no
selector.
Hidden Electron/Go uses disposable state and a synthetic loopback browser/popup
to verify one shell, explicit Sign in return, retained document identity through
popup cancellation/navigation/search, wide and compact native bounds, zero Send
and clean drain. Separate shell/browser captures are not a composited native
screenshot. It does not qualify Google, live sign-in, a tunnel, an installed
workflow or foreground OS focus.

| Entry                                 | Scope and selectors                                                                                               | Required inputs and limits                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readonly-computer-mcp.e2e.mjs`       | Adapter: default; `--packaged`                                                                                    | Built or packaged `computer-mcp.cjs`, Electron, MCP client, system Git/xcrun, disposable files. No assembled UI or live connector proof.                                                                                                                                                                                     |
| `mutable-computer-mcp.e2e.mjs`        | Adapter: default; `--packaged`                                                                                    | Same MCP inputs; disposable workspace mutations.                                                                                                                                                                                                                                                                             |
| `workspace-shell-mcp.e2e.mjs`         | Adapter: default; `--packaged`                                                                                    | Same MCP inputs, shell/Git and synthetic hooks/linked worktrees. Owned process cleanup is separate from host containment.                                                                                                                                                                                                    |
| `computer-task-grant-renewal.e2e.mjs` | Adapter: default                                                                                                  | Built MCP entry and Git. Expired synthetic template; no real elapsed-time or desktop-restart claim.                                                                                                                                                                                                                          |
| `codex-task-mcp.e2e.mjs`              | Adapter: default; `--packaged`                                                                                    | Absolute `FAROL_CODEX_PROXY_BINARY`, MCP artifact, Git, owned HTTP/socket/WebSocket fixtures. Binary availability must be checked.                                                                                                                                                                                           |
| `codex-task-mcp-fault.e2e.mjs`        | Adapter: default; `--packaged`                                                                                    | Runs the preceding entry with `--callback-failure`. Requires its expected exit 1/assertion and awaited fixture cleanup; raw fault mode is not a passing suite. No native-descendant claim.                                                                                                                                   |
| `claude-task-mcp.e2e.mjs`             | Adapter: default; `--packaged`                                                                                    | MCP artifact, Git and generated synthetic Claude executable/home. Does not qualify the real Claude CLI.                                                                                                                                                                                                                      |
| `claude-task-mcp-fault.e2e.mjs`       | Adapter: default; `--packaged`                                                                                    | Runs the preceding entry with `--reconnect-failure`; checks original MCP child terminals and root removal.                                                                                                                                                                                                                   |
| `chatgpt-public-source.e2e.mjs`       | Adapter: `--run-native`; `--run-native --composer-only`                                                           | Declared Node, esbuild, Playwright, pinned Electron and controlled source. Hidden production DOM adapters. `--build-only` with optional `--composer-only` is preparation, not execution.                                                                                                                                     |
| `go-chat-normal.e2e.mjs`              | Adapter composition: `--run-native --candidate-root <absolute> --source-sha <40hex> --build-id <64hex>`           | Clean schema-4 candidate with Go core, pinned tools/dependencies, macOS arm64. Includes two turns, Computer read/revocation and lost-Send-ACK cases. Uses production constructors, not normal main/UI. `--contract`, `--check`, `--build-only` are lower boundaries.                                                         |
| `update-package-identity.e2e.mjs`     | Adapter: default                                                                                                  | Canonical sealed package/manifest, source and bundled verifiers, packaged Electron, esbuild. No installed-update or GitHub acceptance.                                                                                                                                                                                       |
| `update-stage-cleanup.e2e.mjs`        | Adapter: default; `--child-dispatch-fault`; `--probe-timeout-fault`                                               | Three distinct cases. Package/runtime, vendor ASAR and packaged extractor; synthetic extraction/verification replies. Does not prove real extraction or live upgrade.                                                                                                                                                        |
| `preview.e2e.mjs`                     | Partial assembled application: default or `--only=<selector>`; special Setup-dependent modes are retired          | Removed Setup/Settings dependencies emit named `NOT_RUN`, `qualifying: false` records. Remaining selectable segments are `ordinary-startup`, `legacy-start-order`, `fence-unheld`, and `fence-reconciled`. Their partial report is `SELECTED`, never full-lane `PASS`. Native requirements still apply to runnable segments. |
| `dev-onboarding-startup.e2e.mjs`      | Partial assembled application: default; `--installed-tunnel-client`                                               | Current startup/navigation, saved-workspace readbacks and lifecycle checks remain runnable. The removed partial-profile overview continuation is recorded in `retirements`; its presence makes the final status `NOT_RUN`. Cleanup failures remain failures. No full native Setup or live-provider qualification.            |
| `onboarding-visual.e2e.mjs`           | Retired pre-React visual journey                                                                                  | Emits a named non-qualifying `NOT_RUN` record before files, fixtures or Electron launch. Retained source describes the removed wizard and Settings categories; command exit zero is not native coverage.                                                                                                                     |
| `react-shell.e2e.mjs`                 | Assembled application: no declared selector                                                                       | Clean schema-3 build, absolute `FAROL_RENDERER_TEST_ELECTRON_ROOT`, reviewed runtime digest, Playwright. Hidden normal main/UI with synthetic document.                                                                                                                                                                      |
| `guided-setup-selection.e2e.mjs`      | Retired legacy composite for all declared selector combinations                                                   | Validates its ordered selectors, then emits `NOT_RUN`, `qualifying: false` before harness effects. Its removed overview, advanced-policy and challenge-card prerequisites prevent current native coverage; exit zero is not acceptance.                                                                                      |
| `setup-config-error.e2e.mjs`          | Assembled application: default Dev + Preview; `--dev-only`; `--packaged`                                          | Main artifact, Electron/Playwright, disposable malformed/unsafe configuration. Owner-preview idle admission applies.                                                                                                                                                                                                         |
| `go-core-startup.e2e.mjs`             | Assembled application: exact artifact invocation and cases below                                                  | Schema-4 normal main plus Go core; packaged case also binds schema-7 artifact metadata. Hidden disposable profile and exclusive native lane.                                                                                                                                                                                 |
| `dev-route-b-host.e2e.mjs`            | Native-client compatibility: default; `--visible-output`; optional `--report=<path>`                              | esbuild, supported real Codex App Server, disposable HOME/CODEX_HOME and synthetic upstream. Host absence is exit 3, not pass.                                                                                                                                                                                               |
| `farol-model-codex-exec.e2e.mjs`      | Native-client compatibility: default; optional `--report=<file>`                                                  | Node/esbuild and real Codex, optionally `FAROL_MODEL_E2E_CODEX_BIN`, synthetic SSE. Includes selection/rotation/revocation/restart/rollback/no-retry phases. Inherited environment and process-presence observation are not complete isolation. Host absence is exit 3.                                                      |
| `codex-agent-inventory.e2e.mjs`       | Native-client compatibility: default; `--lineage`                                                                 | esbuild, real App Server and synthetic Responses. Lineage adds native synthetic spawn/wait. Skills are not invoked; this does not qualify Product Agent.                                                                                                                                                                     |
| `codex-responses-contract.e2e.mjs`    | Native-client compatibility: `--binary=<path> --sha256=<digest> --version=<exact-output> --source-commit=<40hex>` | macOS, independently selected binary digest/version, disposable home/workspace and synthetic Responses server. Real create/resume observation; no Farol/Go business-delivery ACK or live-provider claim. Source commit is caller-selected metadata.                                                                          |

## Scenarios that must remain separate

`preview.e2e.mjs` retains ordinary Dev and package runs, plus:

- Dev soak: `--development --lifecycle-soak`; package soak: `--lifecycle-soak`.
  Both retain 50 cycles. Optional seed is `--soak-seed=<integer>` in
  `0..2147483647`; idle delay is `--soak-idle-ms=<integer>` in `0..120000`.
- Dev persistence fault: `--development --persistence-fault`. The parser also
  supports packaged `--persistence-fault`.
- Predecessor/state compatibility:
  `--two-generation-state --predecessor-artifact=<absolute manifest>`.
  This requires two distinct sealed generations and the predecessor's own
  verifier/tooling; development mode is refused.

Special modes are mutually exclusive and exclude `--only=<selector[,selector…]>`.
Selected reproduction reports `SELECTED`. `--skip-native-focus` leaves focus
evidence blocked. `--built-in-display-only` and `--allow-primary-display` do not
create permission to use an unavailable or unapproved display.

`go-core-startup.e2e.mjs` consumes exact selected bytes:

```text
Dev:
--run-native --candidate-root <absolute build/app>
--source-sha <40hex> --build-id <64hex>

Package:
--run-native --packaged <absolute Farol.app>
--artifact-metadata <absolute artifact.json> --artifact-sha <64hex>
--source-sha <40hex> --build-id <64hex>
```

An optional `--dependency-root <absolute path>` selects already-installed
dependencies. Preserve fresh startup, packaged `--reopen`, packaged
`--reopen --read-discard`, its `--read-account` and/or `--edit-snapshot`
extensions, and separate packaged `--reopen --settings-edit-mutation`.
Mutation excludes the read cases. Read-account is synthetic account evidence;
edit-snapshot covers Prepare/Cancel, while mutation covers Apply/Observe/delivery.
Dev `--chat-two-turn` excludes those cases; `--chat-history-reopen` requires
`--chat-two-turn`. Its Dev-only `--chat-typed` variant starts through the ordinary
first-message form without workspace selection or Computer admission; it can use
the same history-reopen witness. `--contract`, `--self-test` and `--check` do not execute native
startup.

## Coverage union and prerequisites

Twelve entries have no Task/npm alias at the inventoried source: both MCP fault
wrappers, Claude MCP, grant renewal, public-source DOM, Go Chat composition,
Go core startup, React shell, onboarding visual, Farol-model exec, Codex agent
inventory and Responses compatibility. Existing aliases also do not enumerate
every scenario flag. A future aggregate must account for both, without treating
alias presence as coverage.

The older preview/React/Dev-onboarding harnesses require schema-3 build manifests;
Go witnesses require schema 4, and packaged startup requires artifact schema 7.
This is a source-level compatibility constraint. Artifact availability and
equivalent scenario coverage must be reconciled before adapting or retiring a
harness. Merely relaxing schema checks does not qualify its startup protocol.

Parent-owned `.e2e.entry.ts` files, `legacy-app.fixture.cjs`,
`inactive-reopen-focus.fixture.cjs` and `tunnel-client.fixture.cjs` are source or
runtime inputs, not independent suites to run twice. The inactive-focus fixture
explicitly acquires native focus and retains that separate authority requirement.
The tunnel fixture remains synthetic. The bundled package-verifier invocation is
already owned by the update-identity scenario.

Keep `task test:core` until its generated-wire, architecture, root/nested Go
race/vet, protocol and strict desktop/root TypeScript checks are mapped. The
source test scopes do not replace those gates. Full release qualification also
retains applicable installed workflows and explicit live-provider checks, outside
the deterministic engineering union.

## Disposable owner-beta update pair

`tests/e2e/owner-beta-update-pair.e2e.mjs` is a separate root-operated witness
for two actual sealed owner-beta packages. It is not registered in an aggregate.
Select both candidate repository roots and all six expected identity pins:

```sh
node tests/e2e/owner-beta-update-pair.e2e.mjs --check \
  --source-root /absolute/source-repository \
  --source-sha <40hex> --source-build-id <64hex> \
  --source-artifact-sha <64hex> \
  --target-root /absolute/target-repository \
  --target-sha <40hex> --target-build-id <64hex> \
  --target-artifact-sha <64hex>
```

`--check` performs read-only preflight and prints a content-free summary. It
creates no report, profile, operation or other file, starts no fixture server,
and launches no native/helper/Electron child. The only subprocess exception is
the existing canonical `sourceIdentity()` owner's fixed read-only `/usr/bin/git`
provenance reads, using `GIT_OPTIONAL_LOCKS=0`, disabled global/system Git config
and its non-secret environment allowlist. Both sources must be clean and match
the exact pinned commits/tree identities. Preflight checks canonical schema-7
artifact paths, self-consistent build identities, owner-beta channels, sealed
schema-4 build entries/input declarations, Go binary declarations/digests and
complete app trees. Both bundles must contain the native E2E app-data seam and
the selected sources/binaries must support the direct live helper protocol.
These static capability checks do not prove native execution.

Replace only `--check` with `--run-native` when the root owns the native lane.
This worker packet does not execute that mode. It requires Darwin, matching
native Go architecture and a physical OS temporary parent whose ancestors pass
the unchanged Go helper ownership/mode guards. A sticky writable ancestor such
as `/private/tmp` is refused before allocation; there is no fallback or permission
repair. The runner mints its own `farol-e2e-home-*` root and UUID proof, with
private physical `home/Library/Application Support` directories. No home, slot,
operation, report destination, launcher or retry option can be supplied.

The actual source app is copied into the new home's `Applications/Farol.app`;
the actual target is copied into one fresh operation's `staged.app`. Internal
symlinks and modes are preserved and complete tree digests are reverified.
Hidden, unfocused source Electron starts directly with the proven E2E home and
signed-out loopback fixture. Native home/userData/sessionData/app paths, actual
PID/process start, boot identity, build and the real `running.json` must agree
before updating. Empty task state is checked before declaring the test drain
reconciled. No account setup, provider call, profile copying, settings changes,
user-agent/security workaround or global home-identity patch is part of this
witness.

The packaged target Go binary publishes the actual slot binding through
`publish-installed-slot-binding --build-id <compiled-build-id>`, with fd3 bytes
and the pinned operation-directory descriptor on fd4. It then runs
`run-live-release-helper` with the exact live request on fd3 and one bounded,
strictly correlated ACK on fd4. Only `waiting_for_exit` permits one actual
`app.quit()` request. The original child must close with code 0, a fresh parsed
`last-quit.json` must say drained with no unconfirmed children, the running marker
must disappear, and hidden-lifetime evidence must settle. Only then can the
helper's original terminal plus the installed full-tree digest authorize the
next lifetime.

The sequence is source startup → direct-Go apply → target startup/clean quit →
target reopen → direct-Go manual rollback using that actual running target and
the same operation → source startup/clean quit. Apply and rollback always use
`relaunch:false`. Neither LaunchServices nor `/usr/bin/open` is invoked. Recovery
is explicitly **NOT RUN**, because the current live recovery contract requires
`relaunch:true`; there is no forged closed lease, crash/recovery fixture or Go
policy override. The normal Desktop updater, production installation, live
authentication and full CP2 acceptance are also **NOT RUN**. A successful native
report establishes only this two-artifact direct-Go apply/rollback journey.

Atomic reports go only into the runner repository's ignored
`_output/evidence/owner-beta-update-pair/`. They retain pins, attempts, ACKs,
terminal code/signal, native paths, installed digests, quit receipts and failure
quarantine classifications, without raw logs or authentication/transcripts.
Disposable profiles remain outside Git. Any refusal, malformed output, timeout,
nonzero exit or uncertain terminal stops controller progression, with no retry,
replacement launch, follow-up signal or recovery. The pinned Playwright 1.63.0
Electron launcher owns a detached process group and may force-kill that group
when initialization rejects or times out, before returning a public app handle.
This witness does not claim a signal-free launch-failure path. Such rejection
remains an unconfirmed original launch, never proof of no spawn or clean exit;
the fresh home and partial state are quarantined without another attempt.
App launch occurs only before a helper is started or after the previous helper's
terminal, drain and installed-tree verification have settled. Vendor abort
cleanup cannot authorize the next helper, Quit, recovery or replacement launch.
The root retains known original handles, unconfirmed launches and all partially
modified state for reconciliation. A report-write failure is itself a failed
run, never acceptance.

`tests/unit/owner-beta-update-pair.test.mjs` uses inert Mach-O-header files,
in-memory child streams and injected effect counters. It covers preflight
refusal before native allocation/launch, the read-only Git exception, strict
framing, bounded/malformed/refused/late ACKs, terminal uncertainty, fresh drain
receipts and exact path/copy isolation. These fixtures never count as native
acceptance. Source checks:

```sh
node node_modules/vitest/vitest.mjs run \
  tests/unit/desktop-environment.test.ts \
  tests/unit/owner-beta-update-pair.test.mjs
node --check tests/e2e/owner-beta-update-pair.e2e.mjs
node --check tests/e2e/lib/owner-beta-update-pair.mjs
npm run typecheck
npm run lint
npm run docs:check
```
