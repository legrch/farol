# Current status

This documentation pass describes the following snapshot, verified on
**3 October 2026**. Check the release notes when using another version.

| Layer                          | Verified state                                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Published binary               | [0.1.8-owner.beta.1](https://github.com/legrch/farol-releases/releases/tag/v0.1.8-owner.beta.1), published 2 October 2026; macOS `darwin/arm64`, build `10` |
| Released source                | `1eb30bd23df22c9581d277280f8e0699612786b5`, from the release's `farol-release.json`                                                                         |
| Source reviewed for these docs | `acb131d9e7d483296d4edac262cf881cddfb91bb`; additive Go Core and Computer foundation                                                                        |
| Distribution                   | Owner beta, unsigned, not notarized; no stable release or signed installer is claimed                                                                       |
| Running desktop                | TypeScript/Electron UI and utility backend, with native Python helpers                                                                                      |
| Accepted target                | React/TypeScript UI, TypeScript desktop/browser adapters, Go backend modules                                                                                |

The release manifest, checksums, and archive are published in
[the binary release repository](https://github.com/legrch/farol-releases/releases).
The source repository's Releases tab is not the update feed. Its package version
alone does not prove that newer source changes are included in a released binary.

## Capability boundaries

| Capability                                                                                 | State in this snapshot                                                                                                                                       | Read more                                                               |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Sidebar Setup, Browser, Computer, Activity, Settings                                       | Present in the published TypeScript/Electron beta                                                                                                            | [Getting started](getting-started.md)                                   |
| Computer reads, instructions, guidance, guarded edits, fixed verification, workspace shell | Implemented; each operation needs its current approval and task scope. Full live workflow acceptance remains incomplete                                      | [Computer](computer-parity.md)                                          |
| GitHub owner-beta updater                                                                  | Implemented for the fixed installed slot and an accepted installation receipt. A released archive is not evidence that every upgrade/rollback journey passed | [Installation](installation.md), [updater](installed-update-runtime.md) |
| Native Codex create/status/result and selected-thread observation                          | Separate explicit task-route admission; local/built/package fixtures exist. Live shared-host task acceptance remains open                                    | [Persistent tasks](persistent-chat-handoff-parity.md)                   |
| Codex steer, continuation, title control, broader metadata discovery                       | Separately gated; ordinary production construction does not grant these controls                                                                             | [Persistent tasks](persistent-chat-handoff-parity.md)                   |
| Automated saved ChatGPT conversation                                                       | Default-off experimental opt-in; fixture evidence does not qualify account selection or a real Send                                                          | [Persistent chats](persistent-chat-handoff-parity.md)                   |
| Claude task handoff                                                                        | Fixture-only; desktop issues no production Claude grant                                                                                                      | [Claude](claude-handoff-candidate.md)                                   |
| Farol model-provider route and Product Agent                                               | Disabled by explicit source gates. Naming, schemas, or saved settings do not enable them                                                                     | [Model routing](model-routing.md)                                       |
| Go Desktop/Core and Computer read route                                                    | Source foundation and disposable process/native-read tests; production `farol serve` leaves Computer unavailable and the desktop has not switched executors  | [Desktop/Core](desktop-core.md)                                         |
| React UI and Go Task/Chat/Release modules                                                  | Accepted migration target; not shipping because of that decision                                                                                             | [Architecture](architecture.md)                                         |

## What verification means

Pure policy tests prove their policy. Native tests on temporary folders prove the
selected filesystem or process boundary. Built and packaged app fixtures prove the
bytes and composition they actually ran. Live account, host, installed update, and
user-workflow acceptance require their own evidence.

Keep failed, blocked, unknown, and not-qualified results visible. An unknown operation
is a recovery obligation, never permission to send or execute it again. See
[testing](testing.md) for lane contracts and [architecture](architecture.md) for the
migration boundary.

## Source anchors

- [Feature gates](../src/apps/desktop/foundation-feature-gates.ts) explicitly disable
  Model and Product Agent.
- [Go boot](../boot/application.go) composes the production server without Computer
  method implementations.
- [Desktop environment](../src/apps/desktop/desktop-environment.ts) owns Preview/Dev
  separation.
- [Resource manifest](../resources.json) retains the compatibility identities and
  records the current connector/update ownership.
- [Release manifest](https://github.com/legrch/farol-releases/releases/download/v0.1.8-owner.beta.1/farol-release.json)
  binds the published version to its source, build, platform, and signing state.

These anchors describe this snapshot. Update this page when an accepted source
range or published release changes the capability boundary.

---

[Documentation index](README.md) · [Project overview](../README.md)
