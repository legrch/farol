# Acceptance history and technical reading map

This preserves the previous documentation index from source `75b15c789b7c5c0dd83bf4bd38eb6d2c8520a3eb`. Its dated beta observations establish only their named journeys and builds. Use [current status](status.md) for the public/source distinction and [Start](../start/README.md) for user guidance. Relative links have been rebased; the evidence narratives remain intact.

## Previous documentation index

[Farol overview](../../README.md) · [Development](../../README.md#develop-from-source) ·
[Declared Go build inputs](../../README.md#declared-go-backend-inputs)

This index describes the current source integration tree.
The prior pre-Go accepted baseline was
`8c09f4c7fd9fc82f23a30ad42e701d041189aeea`; local `main` contains later integration.
Source checkpoints, accepted ranges, packages, installation and live qualification
are distinct.
Some technical pages retain earlier checkpoint descriptions; their historical
integration notes must not be read as current product acceptance.

## Use Farol

- [User guide](../owner-preview.md) — setup, access controls, lifecycle and diagnostics.
- [Connection guide](../setup-connection.md) — the current five-section Setup flow,
  saved credentials, workspace access, and external Computer verification.
- [Setup links](../setup-links.md) — external tunnel and ChatGPT connector pages used
  by the in-app instructions.
- [Workspace context](../computer-workspace-context.md) — selected-folder catalogue,
  instruction bootstrap and guidance within current task authority.
- [Computer capabilities and limits](../computer-parity.md) — existing reads, edits,
  shell/Git grants, attachments and evidence boundaries.

Computer-only use does not require embedded login or Model/Agent. Review broader
file and Git permissions explicitly. Installed beta.14 has a fresh external
catalogue witness after OTA; beta.13 also has bootstrap, create and read witnesses.
Shell/Git, persistent Chat continuation after restart, Models,
Agent and workflows remain unqualified. Source and packaged fixtures do not prove
those installed/live routes.

## Installation and updates

On 12 October, the installed beta.13 instance completed a real OTA to
[beta.14](https://github.com/legrch/farol/releases/tag/v0.2.0-owner.beta.14),
build `28`, source `6d5b5a9cedf3d63661f63eac4b02b7cedfb9cfb9`.
Farol automatically downloaded the public archive. One ordinary restart action
completed with the original process exiting normally, a completed update journal,
and matching installed-target and retained-predecessor digests. Both saved
workspaces, the connection credential and update preferences were preserved.
The new runtime became ready and a fresh external catalogue returned both roots.
This qualifies one installed upgrade and subsequent catalogue call. Hardware
sleep, external Shell/Git and post-upgrade GUI interaction remain unqualified;
native UI selection timed out before any action.

Beta.14 shows the installed version, available update and last completed check.
Check for Updates becomes available again after a known completed check; pending
or unconfirmed checks retain their safeguards. Optional rollback is separate under
Settings > Diagnostics > Update recovery. Ordinary Updates no longer offers an
idle View update action or optional rollback. Renderer state tests and visual
fixtures cover this presentation; they do not imply owner visual acceptance.

On 12 October, one installed unsigned macOS ARM64 beta.12 instance completed a
real OTA to [beta.13](https://github.com/legrch/farol/releases/tag/v0.2.0-owner.beta.13),
build `27`, source `4e0a6e19ed8fae383990bb50f28431d558cbc487`. The published
update was discovered and downloaded automatically. One ordinary
Restart and Update action completed the transition; the installed target was
ready, its retained predecessor and existing grants, credentials and update
preferences were preserved, and the connector automatically became ready. A
fresh external catalogue request succeeded. Read-only native inspection confirmed
the running app had an on-screen window. A later external check created two fixture files in a disposable local Git
repository with durable mutation receipts; an external read and independent local
hash check matched. This qualifies those File Computer operations on beta.13,
not execution of the fixture tests or a Git commit through Farol. Hardware sleep,
broad connection reliability and full visual acceptance remain unqualified.

Beta.13 implements a compact update flow with a bottom-rail update affordance,
Install and Relaunch confirmation, secondary settings disclosure, measured
download progress and a separate verification stage. These implementation and
package checks are distinct from the installed OTA observation above.

On 11 October, the installed beta.10 instance completed a real OTA to
[beta.11](https://github.com/legrch/farol/releases/tag/v0.2.0-owner.beta.11),
build `25`, source `3d71feccc3b13912c0f1e464e348801bf37c21cf`.
Farol discovered and downloaded the published archive automatically. One restart
completed with the original process exiting normally, the installed application
and retained predecessor matching their expected digests, and Computer becoming
ready. Existing workspace grants, connection credentials and update preferences
were preserved. External catalogue, instruction bootstrap, create, edit and read
then succeeded; independent local readback matched the returned file hash.

The historical beta.11 package supports connecting with no workspace access and
fixes workspace changes after a normal Quit and reopen. Package checks also
covered empty catalogue, denied file access without a workspace, known
tunnel-termination recovery and beta.10 reading the retained settings. Actual
hardware sleep, live clipboard, external Shell/Git and broader Chat/model/Agent
activation remain unqualified.
Injected sleep events are not hardware-sleep evidence.

On 11 October, one installed unsigned macOS ARM64 beta.8 instance completed a
real OTA to [beta.9](https://github.com/legrch/farol/releases/tag/v0.2.0-owner.beta.9),
version `0.2.0-owner.beta.9`, build `23`, source
`299f823e56bbfbecb1b70d2e7ee97b6a63403a8f`. After installation, external
Computer catalogue and read calls succeeded. One installed tunnel TERM
recovery then preserved the grants and credential reference; fresh catalogue,
read and durable edit calls succeeded after recovery. This is one observed OTA and recovery
cycle, not general installed reliability, hardware-sleep, or long-duration
qualification. The release is published in `legrch/farol`.

Earlier beta3 and beta4 release records remain useful in their historical
context; beta4 download readiness did not establish installation.
The earlier
[0.1.11-owner.beta.1](https://github.com/legrch/farol-releases/releases/tag/v0.1.11-owner.beta.1)
and [historical feed records](../github-release-contract.md) remain valid only in
their retained recovery context. Publication and updater discovery select
`legrch/farol`; existing assets are immutable.

**First installation by an external recipient from the published ZIP remains
unqualified as a supported end-to-end workflow.** A manual app copy is not an
accepted updater baseline. The first-install/adoption mechanism is product work,
not a documentation-only gap. The documented alternative is source build from
accepted clean bytes, explicit owner promotion and onboarding:

- [Build and package](../../README.md#develop-from-source) — `task package` produces
  a candidate; `task run` opens its temporary snapshot without installing it.
- [Owner promotion](../owner-preview.md#optional-local-promotion--owner-action-only)
  — inspect `task promote`, then explicitly select the documented non-overwriting
  apply action only when the destination and receipt are absent. The current alpha
  baseline uses `$HOME/Applications/Farol.app` and a verified receipt.
- [Onboarding](../owner-preview.md#setup-inside-the-app) — selected folders, tunnel,
  exact ChatGPT app selection and explicit connection check.
- [Closed product cutover](../product-cutover.md) — preserve an occupied app slot and
  its configuration during the documented alpha transition.
- [Installed updater lifecycle](../installed-update-runtime.md) — staging, restart,
  reconciliation and rollback; its source contracts do not prove an installed run.
- [First-install/adoption boundary](../../modules/release/adoption.md) — proposed
  backend semantics and destination decisions; no available installer is implied.

## Development and checks

- [Standalone build](../standalone-build.md) — toolchains, dependencies, output,
  packaging and attestation. Read with current [repository instructions](../../AGENTS.md).
- [GUI test policy](../testing.md) — hidden/native evidence, display selection,
  explicit focus authority and packaged acceptance.
- [Dependencies](../dependencies.md) — existing TypeScript/Electron inventory. The
  historical DOM decision does not supersede the React target.
- [Ordinary Git fixture](../ordinary-git-environment-fixture.md) — disposable
  worktree/config/hook inputs, not installed-connector evidence.

`task dev` builds clean committed React/Go source using separately approved local
Go inputs at `_output/go-build-inputs.json`, or an explicit `--go-inputs` file.
Missing or invalid inputs refuse the build before launching; there is no implicit
desktop-only fallback. See [ordinary Dev setup](../../README.md#develop-from-source).
`task test:core` checks generated wire, import boundaries, Go race/vet and the
TypeScript bridge. Full `task ci:fast`
includes Hunt and requires **clean committed source**; targeted WIP checks do not
replace it. Current `AGENTS.md` permits a coherent checkpoint after targeted
verification, self-review and diff checking; a frozen integration candidate needs
the applicable aggregate and independent review gates.

`task test:unit`, `task test:integration` and `task test:fast` now select explicit
source scopes across TypeScript, React and Go, with exact execution reports.
Their npm aliases use the same runner. These are not assembled-product or full
containment claims. `task test` and `task qualify:live` remain target contracts;
existing `task test:e2e` retains its packaged Electron meaning. See the
[scope and evidence rules](../testing.md#source-test-scopes),
[Taskfile](../../Taskfile.yml) and [npm scripts](../../package.json).

[The declared Go inputs](../../README.md#declared-go-backend-inputs)
uses `task package -- --go-inputs=...` with approved local SDK/module inputs. It is
source-supported, not production-qualified. A 0.2 candidate requires core-enabled
package schema `7`; legacy schema `6` is not an eligible 0.2 candidate. No recipe or source PASS
qualifies normal Electron execution, installation or a live provider.

## Architecture and Go modules

- [Runtime architecture](../architecture.md) — TypeScript modular boundaries and
  native browser composition. Its older capability summary needs the current
  feature gates and module-specific limits below.
- [Desktop/Core foundation](../desktop-core.md) — framing, generated wire, K0/K1 and
  disposable read evidence. Its earlier unavailable-production statement predates
  this checkpoint's optional normal Go host wiring.
- [Desktop design](../design.md) — existing Watch Rail and browser-overlay decisions;
  the separate React presentation replacement is outside this checkpoint.

The current source connects [the Electron Go host](../../apps/desktop/go-core-host.ts)
to [native Go composition](../../boot/nativeruntime.go). Trusted authority publication
and Chat admission precede Computer catalogue/bootstrap/read. The native Chat
owner now composes its browser exchange, bounded in-memory result retention and
typed conversation API. Controlled-peer tests through the normal Go CLI prove
useful output before completion, the first Home-to-conversation binding,
same-conversation follow-up and no second Send
after a lost acknowledgement. These tests do not execute Electron or a real DOM.
The [normal desktop controlled Chat witness](../desktop-core.md#controlled-normal-desktop-chat)
at `5724af7` adds actual Electron DOM and React/Go two-turn delivery evidence.
The paired app was built and verified; the witness launched its attested Dev
candidate through normal main. Production profiles, ordinary provider-used Quit,
crash/reopen recovery, installed and live-provider qualification remain open.

- Computer: [migration map](../../modules/computer/migration.md),
  [durable access](../../modules/computer/access.md),
  [admission](../../modules/computer/admission.md),
  [execution leases](../../modules/computer/leases.md),
  [workspace discovery](../../modules/computer/discovery.md),
  [context](../../modules/computer/context.md),
  [write/edit preparation](../../modules/computer/mutation.md), and
  [process lifecycle](../../modules/computer/infra/process/README.md).
- Chat: [module overview](../../modules/chat/README.md),
  [admission](../../modules/chat/ADMISSION.md),
  [lifecycle owner](../../modules/chat/LIFECYCLE.md), and
  [conversation contract](../../modules/chat/contracts/conversation/CONFORMANCE.md).
- Task: [coding-task lifecycle](../../modules/task/README.md),
  [observation contract](../../modules/task/contracts/observation/README.md), and
  [selected Codex client](../../modules/task/infra/clients/codex/README.md).
- Release: [module overview](../../modules/release/README.md),
  [native boundary](../../modules/release/native.md),
  [journal](../../modules/release/journal.md),
  [migration admission](../../modules/release/migration.md), and
  [relocation](../../modules/release/relocation.md).

Module pages describe source contracts and remaining cutover work. They do not
claim that all prepared verbs are registered or that the existing TypeScript and
Python executors have been retired. Domain/app use consumer-owned ports; neighbor
calls cross published contracts through peer adapters. Composition owns concrete
infrastructure. [The wire schema](../../api/desktop/v1/schema.json) remains canonical.

## Routing, release and identity reference

- [Provider/model identity](../model-routing.md) — permanent `farol` / `chatgpt`
  identity and model-selection limits.
- [Configuration/model discovery](../config-model-discovery.md) — policy and runtime
  catalogue; advertised models do not prove entitlement or successful inference.
- [Persistent handoff](../persistent-chat-handoff-parity.md) and
  [Claude candidate](../claude-handoff-candidate.md) — task/conversation contracts
  with separate host, browser and live-account qualification.
- [GitHub release contract](../github-release-contract.md),
  [package verification](../update-package-verifier.md), and
  [installed helper](../installed-update-helper.md) — exact publication, package and
  recovery boundaries.
- [Identity inventory](../identity-inventory.md), [cutover policy](../identity-cutover.md),
  and [physical relocation](../identity-physical.md) — proposed migration and measured
  object rules, not an executed profile or installed-identity move.
- [Owner guard](../owner-guard-startup-recovery.md) — protected-path fingerprints and
  platform limitations; the guard is not a filesystem sandbox.

Repository output belongs under ignored `_output/`. Preserve source, package and
operation identities when interpreting evidence; an offline source gate and an
installed or live-provider result establish different claims.
