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
