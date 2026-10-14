# Current capability and distribution status

Audit date: **14 October 2026**. Source baseline: `75b15c789b7c5c0dd83bf4bd38eb6d2c8520a3eb`. Documentation has its own branch; later Lead work is outside this snapshot.

## Keep four states separate

| State                                | What is known                                                                                                                                                                                                                                                                                                     | What it does not establish                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public release                       | GitHub's latest published release checked was [v0.2.3](https://github.com/legrch/farol/releases/tag/v0.2.3), published 12 October 2026. Assets: `Farol-0.2.3-darwin-arm64.zip`, `farol-release.json`, `SHA256SUMS`. Its notes identify unsigned/non-notarized Apple Silicon packaging and Shell/Git native tests. | Fresh-recipient installation, trusted baseline adoption, or live external Shell/Git acceptance.                                                             |
| Installed owner capability           | The owner reports an installed app newer than the public release. Retained repository evidence records exact older OTA/File journeys, including beta.13 File operations and beta.14 post-OTA catalogue.                                                                                                           | The present installed version, process identity or capability set was not inspected in this documentation task. Older witnesses do not qualify newer bytes. |
| Audited source candidate             | `package.json` declares `0.2.4`, build `33`, `github-stable` at the source baseline. Source includes current Setup, guarded File operations, a build-selected Shell route and update/recovery controls.                                                                                                           | A packaged, installed or released version of those exact bytes; a source version is not a release.                                                          |
| Planned or separately qualified work | First-recipient installer/adoption, proposed `/Applications/Farol.app` composition, broader Shell/Git acceptance, Tasks/Agent workflows, Git SSH and PDF/binary transfer require their respective gates.                                                                                                          | A usable procedure merely because source, a proposal or a feature branch exists.                                                                            |

## User-facing capability claims

| Capability                                      | Evidence boundary for these guides                                                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace catalogue/bootstrap, list/search/read | Existing File route and bounded external/installed beta evidence. Current-build and folder checks still apply.                          |
| Guarded file create/edit                        | Specific installed beta witnesses and retained mutation observation; no blanket guarantee for every file verb or later build.           |
| Empty-workspace connection                      | Current source allows verification with no file grants. Current checks still need the matching connection receipt.                      |
| Updates                                         | Existing accepted-baseline updater and specific historical installed transitions. Manual ZIP copying does not establish eligibility.    |
| Shell and ordinary local Git                    | Public v0.2.3 notes and current source/native fixtures exist. External installed Shell/Git acceptance is not established by this audit. |
| Git SSH / remote push                           | Not advertised as shipped. Local Git and folder grants do not establish network or SSH authority.                                       |
| Tasks, Product Agent and Agent workflows        | Not advertised as shipped. Contracts, disabled surfaces and fixtures are technical references.                                          |
| PDF/binary preview or transfer                  | Not advertised as shipped. A separate source candidate is not integrated/installed acceptance.                                          |
| Hardware sleep / broad network recovery         | Still requires dedicated real-device and current-build evidence. Injected events do not qualify hardware behavior.                      |

## Support and installation limits

The current package targets macOS ARM64. Its plist declares `LSMinimumSystemVersion` `12.0`; that metadata alone is not a validated minimum for the bundled runtime or native dependencies. A supported OS/prerequisite matrix must be accepted before a general first-install claim. Intel, Windows and Linux packages are not qualified here.

First installation/adoption remains product work under [the checklist](install-readiness.md). Existing alpha update authority is bound to its fixed path and durable evidence; the proposed production path must not be silently substituted. A GitHub stable-channel label does not change the app's unsigned, non-notarized beta status.

The user guides use labels from this source baseline. An older public build may show older wording. [Verification](documentation-verification.md) lists the source owners and unperformed installed journeys. [Acceptance history](acceptance-history.md) retains the exact historical evidence rather than turning it into current-product claims.

[Technical references](README.md) · [Documentation](../README.md)
