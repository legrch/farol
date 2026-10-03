# Farol documentation

Start with the [project overview](../README.md), then choose a guide below.
[Current status](status.md) separates the published owner beta, the accepted source
snapshot, and migration work. A source or fixture test does not certify a live
ChatGPT account, native task host, or installed update.

## Using Farol

- [Getting started](getting-started.md) — first connection, approved folders,
  everyday controls, and operation states.
- [Installation and updates](installation.md) — beta downloads, checksums,
  requirements, installation baseline, and update controls.
- [Candidate launch and troubleshooting](owner-preview.md) — `task run`, hidden
  launches, Dev isolation, and common remedies.
- [Setup links](setup-links.md) — external tunnel and ChatGPT setup pages.

## Development

- [Build and verification](standalone-build.md) — toolchain, dependencies, Dev,
  deterministic gates, packaging, and output layout.
- [Testing](testing.md) — evidence classes, native test commands, display/focus
  policy, selected journeys, and retained reports.
- [Dependencies](dependencies.md) — current dependency owners and migration limits.
- [Ordinary Git fixture](ordinary-git-environment-fixture.md) — isolated reference
  configuration and Computer shell acceptance.

## Architecture and decisions

- [Architecture](architecture.md) — running TypeScript/Electron system, accepted
  Go/React target, module ownership, and enforced dependencies.
- [Desktop/Core protocol](desktop-core.md) — Go backend checkpoint, generated wire,
  process lifetime, and disposable Computer reads.
- [Browser adapter](browser-adapter.md) — public DOM parsing, readiness ordering,
  submission, and continuity evidence.
- [Desktop design](design.md) — Watch Rail, native browser overlays, keyboard
  behavior, and visual evidence.
- [Provider and model identity](model-routing.md) — `farol` / `chatgpt`, alias
  semantics, continuity, and disabled integration boundaries.

## Computer and task reference

- [Computer capabilities](computer-parity.md) — file operations, command modes,
  Git approval, effect receipts, and process-cleanup limits.
- [Workspace context](computer-workspace-context.md) — workspace IDs, `AGENTS.md`
  bootstrap, published guidance, and search coverage.
- [Configuration and model discovery](config-model-discovery.md) — `config.json`,
  task model policy, exact runtime selection, and continuation binding.
- [Persistent chats and native tasks](persistent-chat-handoff-parity.md) — route
  status, saved projects, create/status/result, observation, and gated control.
- [Claude handoff](claude-handoff-candidate.md) — fixture-only route and its
  qualification requirements.

## Updates and maintenance reference

These pages explain implementation contracts and controlled recovery. Use the
[installation guide](installation.md) for the ordinary user path.

- [GitHub release contract](github-release-contract.md) — assets, channels, strict
  manifests, bounded discovery, and transport.
- [Package verifier](update-package-verifier.md) — archive and extracted-package
  verification.
- [Installed updater](installed-update-runtime.md) — drain, staging, durable
  admission, restart, recovery, and rollback.
- [Installed update helper](installed-update-helper.md) — readiness acknowledgment,
  atomic replacement, and exact-operation reconciliation.
- [Historical preview cutover](product-cutover.md) — closed migration from the older
  preview layout; separate from an ordinary update.
- [Owner guard](owner-guard-startup-recovery.md) — protected-path fingerprints,
  cancellation, and verification limits.

## Reading conventions

**Released** means named published bytes. **Current source** means an implementation
in the reviewed source snapshot. **Accepted target** describes a decided architecture
that may still need migration. **Fixture-only** means a test composition, not an
ordinary enabled product route. Keep those meanings when extending these pages.

Existing reference filenames remain stable so source and review links keep working.
