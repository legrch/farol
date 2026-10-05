# Farol documentation

[Farol overview](../README.md) · [Development](../README.md#develop-from-source) ·
[Optional Go build](../README.md#optional-declared-go-backend-build)

This index describes the current source integration tree.
Accepted `main` remains `acb131d9e7d483296d4edac262cf881cddfb91bb`. Source integration,
a packaged candidate, installation and live-provider qualification are distinct.
Some technical pages retain earlier checkpoint descriptions; their historical
integration notes must not be read as current product acceptance.

## Use Farol

- [User guide](owner-preview.md) — setup, access controls, lifecycle and diagnostics.
- [Setup links](setup-links.md) — external tunnel and ChatGPT connector pages used
  by the in-app instructions.
- [Workspace context](computer-workspace-context.md) — selected-folder catalogue,
  instruction bootstrap and guidance within current task authority.
- [Computer capabilities and limits](computer-parity.md) — existing reads, edits,
  shell/Git grants, attachments and evidence boundaries.

Computer-only use does not require embedded login or Model/Agent. Review broader
file and Git permissions explicitly. Model and Product Agent remain disabled;
source fixtures are not proof of a live task route.

## Installation and updates

The previously checked [0.1.8 owner beta](https://github.com/legrch/farol-releases/releases/tag/v0.1.8-owner.beta.1)
is unsigned macOS ARM64 build `10`, source
`1eb30bd23df22c9581d277280f8e0699612786b5` (release metadata checked 3 October 2026).
This checkpoint's `0.1.9-owner.beta.1` / build `11` metadata does not prove another
release or identify the currently installed app.

**First installation by an external recipient from the published ZIP remains
unqualified as a supported end-to-end workflow.** A manual app copy is not an
accepted updater baseline. The first-install/adoption mechanism is product work,
not a documentation-only gap. The documented alternative is source build from
accepted clean bytes, explicit owner promotion and onboarding:

- [Build and package](../README.md#develop-from-source) — `task package` produces
  a candidate; `task run` opens its temporary snapshot without installing it.
- [Owner promotion](owner-preview.md#optional-local-promotion--owner-action-only)
  — inspect `task promote`, then explicitly select the documented non-overwriting
  apply action only when the destination and receipt are absent. The current alpha
  baseline uses `$HOME/Applications/Farol.app` and a verified receipt.
- [Onboarding](owner-preview.md#setup-inside-the-app) — selected folders, tunnel,
  exact ChatGPT app selection and explicit connection check.
- [Closed product cutover](product-cutover.md) — preserve an occupied app slot and
  its configuration during the documented alpha transition.
- [Installed updater lifecycle](installed-update-runtime.md) — staging, restart,
  reconciliation and rollback; its source contracts do not prove an installed run.
- [First-install/adoption boundary](../modules/release/adoption.md) — proposed
  backend semantics and destination decisions; no available installer is implied.

## Development and checks

- [Standalone build](standalone-build.md) — toolchains, dependencies, output,
  packaging and attestation. Read with current [repository instructions](../AGENTS.md).
- [GUI test policy](testing.md) — hidden/native evidence, display selection,
  explicit focus authority and packaged acceptance.
- [Dependencies](dependencies.md) — existing TypeScript/Electron inventory. The
  historical DOM decision does not supersede the React target.
- [Ordinary Git fixture](ordinary-git-environment-fixture.md) — disposable
  worktree/config/hook inputs, not installed-connector evidence.

`task dev` builds current development files. `task test:core` checks generated
wire, import boundaries, Go race/vet and the TypeScript bridge. Full `task ci:fast`
includes Hunt and requires **clean committed source**; targeted WIP checks do not
replace it. Current `AGENTS.md` still requires the full gate before commit. The
ordering conflict remains for the repository maintainer to resolve; these pages
and `standalone-build.md` grant no checkpoint-commit exception.

The proposed test-command registry is unadopted. `npm run test:unit` currently
runs both `tests/unit` and `tests/integration`; no unit-only meaning is implied.
Use the existing [Taskfile](../Taskfile.yml) and [npm scripts](../package.json).

[The optional declared Go recipe](../README.md#optional-declared-go-backend-build)
uses `task package -- --go-inputs=...` with approved local SDK/module inputs. It is
source-supported, not production-qualified. Core-enabled package schema `7` and
default schema `6` require separate artifact evidence. No recipe or source PASS
qualifies normal Electron execution, installation or a live provider.

## Architecture and Go modules

- [Runtime architecture](architecture.md) — TypeScript modular boundaries and
  native browser composition. Its older capability summary needs the current
  feature gates and module-specific limits below.
- [Desktop/Core foundation](desktop-core.md) — framing, generated wire, K0/K1 and
  disposable read evidence. Its earlier unavailable-production statement predates
  this checkpoint's optional normal Go host wiring.
- [Desktop design](design.md) — existing Watch Rail and browser-overlay decisions;
  the separate React presentation replacement is outside this checkpoint.

The current source connects [the Electron Go host](../apps/desktop/go-core-host.ts)
to [native Go composition](../boot/nativeruntime.go). Trusted authority publication
and Chat admission precede Computer catalogue/bootstrap/read. The native Chat
owner now composes its browser exchange, bounded in-memory result retention and
typed conversation API. Controlled-peer tests through the normal Go CLI prove
useful output before completion, the first Home-to-conversation binding,
same-conversation follow-up and no second Send
after a lost acknowledgement. These tests do not execute Electron or a real DOM.
The [normal desktop controlled Chat witness](desktop-core.md#controlled-normal-desktop-chat)
at `5724af7` adds actual Electron DOM and React/Go two-turn delivery evidence.
The paired app was built and verified; the witness launched its attested Dev
candidate through normal main. Production profiles, ordinary provider-used Quit,
crash/reopen recovery, installed and live-provider qualification remain open.

- Computer: [migration map](../modules/computer/migration.md),
  [durable access](../modules/computer/access.md),
  [admission](../modules/computer/admission.md),
  [execution leases](../modules/computer/leases.md),
  [workspace discovery](../modules/computer/discovery.md),
  [context](../modules/computer/context.md),
  [write/edit preparation](../modules/computer/mutation.md), and
  [process lifecycle](../modules/computer/infra/process/README.md).
- Chat: [module overview](../modules/chat/README.md),
  [admission](../modules/chat/ADMISSION.md),
  [lifecycle owner](../modules/chat/LIFECYCLE.md), and
  [conversation contract](../modules/chat/contracts/conversation/CONFORMANCE.md).
- Task: [coding-task lifecycle](../modules/task/README.md),
  [observation contract](../modules/task/contracts/observation/README.md), and
  [selected Codex client](../modules/task/infra/clients/codex/README.md).
- Release: [module overview](../modules/release/README.md),
  [native boundary](../modules/release/native.md),
  [journal](../modules/release/journal.md),
  [migration admission](../modules/release/migration.md), and
  [relocation](../modules/release/relocation.md).

Module pages describe source contracts and remaining cutover work. They do not
claim that all prepared verbs are registered or that the existing TypeScript and
Python executors have been retired. Domain/app use consumer-owned ports; neighbor
calls cross published contracts through peer adapters. Composition owns concrete
infrastructure. [The wire schema](../api/desktop/v1/schema.json) remains canonical.

## Routing, release and identity reference

- [Provider/model identity](model-routing.md) — permanent `farol` / `chatgpt`
  identity and model-selection limits.
- [Configuration/model discovery](config-model-discovery.md) — policy and runtime
  catalogue; advertised models do not prove entitlement or successful inference.
- [Persistent handoff](persistent-chat-handoff-parity.md) and
  [Claude candidate](claude-handoff-candidate.md) — task/conversation contracts
  with separate host, browser and live-account qualification.
- [GitHub release contract](github-release-contract.md),
  [package verification](update-package-verifier.md), and
  [installed helper](installed-update-helper.md) — exact publication, package and
  recovery boundaries.
- [Identity inventory](identity-inventory.md), [cutover policy](identity-cutover.md),
  and [physical relocation](identity-physical.md) — proposed migration and measured
  object rules, not an executed profile or installed-identity move.
- [Owner guard](owner-guard-startup-recovery.md) — protected-path fingerprints and
  platform limitations; the guard is not a filesystem sandbox.

Repository output belongs under ignored `_output/`. Preserve source, package and
operation identities when interpreting evidence; an offline source gate and an
installed or live-provider result establish different claims.
