# Cloud source integration

Use `task ci:cloud` for the owner-authorized Linux source integration boundary.
It runs toolchain, types, lint, formatting, architecture, runtime inventory,
documentation, selected source tests, renderer tests, Hunt source properties/mutations, full Go Core and
secret checks under the existing owner guard. After independent review and
these checks pass, the Lead merges the existing source PR and verifies main.

This does not replace `task ci:fast`, its full native coverage thresholds, a
package build or installed acceptance. Darwin/Seatbelt, Apple tools, APFS,
reviewed compiler/runtime resources, clean-Mac setup, live providers and
OTA/rollback remain separate gates. Missing Mac hardware does not prevent
portable implementation or reviewed source integration.

## Manual Linux workflow

`.github/workflows/cloud-source-ci.yml` provides a manually dispatched
Ubuntu 24.04 source lane. It has no push or pull-request trigger and does not
package, install, release, configure credentials or dispatch another workflow.
The existing macOS workflow and all native qualification guards remain unchanged.

The lane selects Node 24.20.0, npm 11.19.0 and Go 1.26.2, then installs Task
3.45.5 and Gitleaks 8.30.1 from their versioned Go modules. Task 3.45.5 supports
the selected Go compiler; newer Task releases may require a newer compiler.
`GOTOOLCHAIN=local` prevents an implicit compiler upgrade. Action revisions are
pinned to full commit IDs. Dependency installation follows the existing
standalone workflow: lockfile install without scripts, followed only by the
esbuild and Electron installers. No dependency cache is restored.

The unchanged `task ci:cloud` remains the source gate, including root and nested
Go race/vet, tooling tests and secret scanning. An unsuccessful gate fails the
job; receipt collection does not turn it into a pass. A small artifact records
the exact checked-out commit, gate outcome and acceptance exclusions. Test
stdout remains in the job logs; the artifact does not collect profiles, arbitrary
workspace contents or raw test output. Detailed scope evidence remains under
`_output/evidence/test-scopes/` during the run.

This lane is a portability foundation, not a Linux desktop release or a Windows
build. Cross-compilation and a rendered window cannot qualify profile custody,
filesystem mutation, process confinement, installation or updater recovery.
Native Linux and Windows acceptance require separately implemented and reviewed
platform adapters, followed by tests on those operating systems. Keep this
workflow's first proposed revision unaccepted until its actual hosted source
gate and independent review pass; a syntax check is not a gate run.

## Selection and evidence

The existing scope runner accepts `--scope=cloud`. It includes new ordinary
test files by default and records exact deferred files and mixed-case selectors
from `tooling/cloud-test-prerequisites.mjs`. Stale declarations fail planning.
Run `task test:cloud -- --list` to inspect the complete plan. Results are under
`_output/evidence/test-scopes/`, including selected files, source-selection hash,
commands, original-child observations, assertion counts and the NOT RUN list.
Root and nested Go race/vet and protocol checks run separately in `test:core`.
The build-bound `hunt:report` requires an exact authenticated build and remains
in full CI, NOT RUN in Cloud source. Its three source property/mutation suites
are included here. Ordinary Cloud groups use two Vitest workers, matching the
existing full runner; other scopes and their deadlines are unchanged.

Some deferred integration files mix portable policy with physical host
requirements. Their portable cases are also NOT RUN in this profile unless a
mixed-file selector explicitly includes them. The selected build-provenance,
Computer drain, saved bridge, Task lifecycle and response-schema cases remain
in Cloud. Do not describe this partial selection as full native coverage or as
proof that every deferred failure is native. Existing full CI still runs those
files without these selectors.

Required resources differ: Darwin APIs, strict physical ancestor ownership,
the fixed `/private/tmp` connector route, the release producer's fixed trusted
Node paths, and the legacy helper's supported Python3.9 are distinct conditions.
Shell activation does not authenticate those resources. In particular, Python3.13
emits a deprecation warning for the legacy helper's `sre_parse` import, while
the production adapter deliberately refuses unexpected stderr. Do not suppress
stderr, relax interpreter attestation or widen supported product dependencies
to make a fixture pass. Go-aware normal file/search operations do not select
that legacy helper.

## Independent Shell qualification

`tests/fixtures/shell-qualified-process.go.txt` is an immutable, non-executed
copy of the process source natively qualified by platform record
`macos-26A434-arm64-root-volume-git-python-metadata-v11`. Its SHA-256 is
`2d9688918cd9216cef357ead45b99f7db2412af580d5fa85f9cacaf7e379e786`,
the independent platform pin. It changes only with a reviewed native
requalification. Producer/consumer contract tests use
that fixture, so negative tests reach their intended changed/missing/link
conditions instead of failing early on unrelated live-source drift.

A separate test compares actual current process bytes to the independent pin:
an unqualified source must refuse with `SHELL_SUPPORT_INPUT_CHANGED`. A passing
refusal test does not qualify current Shell source, enable its declaration or
make packaging available. Native qualification and reviewed pin updates remain
required before current-source Shell/package acceptance. Never replace a pin
with an observed hash solely to pass a check.

## Review and delivery

Use fresh, read-only independent native reviewers with the configured role and
model/effort ladder. A host driver integration failure is distinct from actual
agent availability. When its formal lifecycle API is unavailable, retain actual
native review outcomes and explicit limits; do not manufacture formal-driver,
close or usage receipts. The Lead inspects findings, closes relevant checks and
owns source acceptance and merge.

Keep source, packaged, installed, live and owner-accepted states separate in the
private re-entry handover. Preserve failed aggregates and unknown outcomes;
never replay effects or weaken hooks/confinement to claim completion.
