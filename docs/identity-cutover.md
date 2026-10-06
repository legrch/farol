# Final identity and current-alpha cutover

This is source preparation, not an executed migration. The additive Go policy is
not wired to startup and performs no I/O. Integration, shared-file leases,
packaging, installation and live acceptance belong to the integration owner.

## Current integration status

Source inspection at `5376fac6` confirms that the final values below are targets,
not the currently emitted package/runtime identity. Packaging still emits
`local.farol.next.preview`; production startup retains `Farol Next Preview`
user/session data. Dev declares `local.farol.dev` and uses the protected
`Farol Dev`/legacy-spelling profile selection, while ordinary `task dev` launches
the attested vendor Electron bundle rather than a separately branded Dev bundle.
Runtime and ChatGPT partitions remain distinct compatibility values in
`desktop-environment.ts`; merging them would also change their network boundary.

New release discovery already selects `legrch/farol`. The older
`farol-releases` destination remains only for exact retained recovery context.
The pinned inventory below predates that integrated feed change and must not
be used as a current replacement list.

The existing supervised transition uses the existing updater/helper and stops
at `verified_closed`; it does not activate final profile/session identity.
The Go migration plan's `VerifyLayout` result remains a stop before separately
qualified layout/state/operation reconciliation. Package verification, updater
admission and the native helper still pin the compatibility bundle/root.
Changing a display string or the package plist alone cannot complete this
boundary. No source inspection here proves a migration, recovery, installation
or a subsequent update.

## Accepted target identities

| Surface                      | Production                            | Development                                         |
| ---------------------------- | ------------------------------------- | --------------------------------------------------- |
| Visible name                 | `Farol`                               | `Farol Dev`                                         |
| Bundle ID                    | `io.github.legrch.farol`              | `io.github.legrch.farol.dev`                        |
| User/session data            | `~/Library/Application Support/Farol` | `~/Library/Application Support/Farol Dev`           |
| Persistent browser partition | `persist:farol`                       | `persist:farol-dev`                                 |
| Launch                       | Accepted installed application        | `task dev`; no separately installed bundle required |

V0 is retired. It is never started for fallback, migration, parity or recovery.
The model route remains `provider=farol`, `model=chatgpt`.

## Inventory boundary

The [pinned occurrence index](identity-inventory.md) records all 142 files and
863 core-query matching lines, with a reproducible query. Additional protocol
and dormant-hook families are covered below.

The inventory is pinned to accepted source base
`1eb30bd23df22c9581d277280f8e0699612786b5` (version
`0.1.8-owner.beta.1`, build `10`). It inspected tracked source, contracts, tooling,
resources and tests. It did not read owner profiles, browser storage, private
journals or provider state, or inspect published artifact contents.

The separately owned release range was also compared read-only through
`a47c9ccea1a00eb210f675f71a0690fc3be6c857`: version `0.1.9-owner.beta.1`,
build `11`; the production edition becomes empty; profile/bundle/partition values
remain the old values below. Its new native archive implementation accepts the
historical `Farol Next Preview.app` and branded `Farol.app` layouts in
`resources/native/go/internal/releasearchive/archive.go:28`. This is an archive
reader, not proof that a final-identity installed update is admissible. The
release range is not part of the Identity branch or its acceptance claim.

Classification describes behavior, not whether a string looks old:

- **W — current writer:** emits/selects a current identity, or enforces its live
  producer/consumer contract. All W families require coherent cutover.
- **M — migration reader:** accepts a bounded old input or reads recovery evidence.
  Explicit maintenance writes remain maintenance operations requiring their own
  authority. An M label does not authorize them.
- **H — historical fixture:** retained old-generation/example input. It may stay.
- **D — dead/dormant:** no active production entry, or a selector whose refusal is
  the only supported behavior. Refusal tests can remain necessary.

Mixed files are classified by branch; they cannot be removed by filename or grep.
Line references below are at the pinned base. The [pinned occurrence index](identity-inventory.md) lists all 142 files and 863 core-query matching lines, with a reproducible query. Additional protocol/hook families are covered below.

## Product, process, build and update identities

| Family / current values                                                                                                 | Classification                              | Source and consumer boundary                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Visible `Farol`, `Farol Dev`; environment `preview` / `dev`; edition `Developer Preview` / `Development`                | W                                           | `src/apps/desktop/desktop-environment.ts:11,246`; `desktop-entry.ts:10`; `main.ts:429,674`; `src/ui/shell.ts:277,412`                                                    |
| Production `local.farol.next.preview`; Dev `local.farol.dev`                                                            | W                                           | `desktop-environment.ts:248`; `main.ts:681,1245`; strict renderer bootstrap `src/ui/shell.ts:282,415`                                                                    |
| `Farol Next Preview` userData/sessionData                                                                               | W                                           | `desktop-environment.ts:240`; `main.ts:488`; `tooling/promotion-obligations.mjs:375`; `installed-update-runtime.ts:395`                                                  |
| `Farol Dev`; physical legacy spelling `Farol DEV`                                                                       | W + M                                       | `dev-profile-directory.ts:6,46,75`; `desktop-environment.ts:235`; legacy-only selection and same-inode aliases are supported; distinct entries refuse                    |
| `Farol Dev Acceptance/Farol Dev` beneath Application Support                                                            | W, explicit acceptance fixture profile      | `desktop-environment.ts:166`; `tooling/dev.mjs:459`; `scripts/assert-owner-untouched.py:39`                                                                              |
| Runtime `persist:farol-next-preview` / `persist:farol-dev-runtime`                                                      | W                                           | `desktop-environment.ts:252`; `main.ts:8249,8255,8378`; `resources.json:13`; `tooling/resource-contract.mjs:16`                                                          |
| ChatGPT `persist:farol-next-chatgpt` / `persist:farol-dev-chatgpt`                                                      | W                                           | `desktop-environment.ts:255`; `chatgpt-page-policy.ts:1`; `chatgpt-route.ts:1230,1679`; `main.ts:1388,1728`                                                              |
| `${partition}:${buildId}`, `chatgpt.next-partition/1` verification                                                      | W, generation-bound evidence                | `main.ts:1518,3435,6267`; `saved-chat-preview-admission.ts:22`; old verification must not become a witness for a new identity                                            |
| `farol-next-preview-runtime` / `farol-dev-runtime` handshake                                                            | W                                           | `desktop-environment.ts:23,258`; `main.ts:645,8163,8204`; `src/apps/runtime/main.ts:24`; `src/boot/runtime-server.ts:25`; Chat preview server                            |
| Main executable/title `Farol Next Preview`; utility `Farol Next Runtime`; Dev `Farol Dev` / `Farol Dev Runtime`         | W                                           | `main.ts:676,8176`; `desktop-environment.ts:259`; `resources.json:21`; `tooling/evidence-observe.mjs:321`; E2E process checks                                            |
| Build product `Farol Next Preview` + bundle `local.farol.next.preview`                                                  | W, hashed identity                          | `src/pkg/build-info/identity.ts:11`; `tooling/build-identity-contract.mjs:3,21`; `tooling/build.mjs:338`; `src/apps/desktop/build-identity.ts:20`                        |
| `farol.next.resource-manifest/1` and exact resource identity                                                            | W                                           | `resources.json:2`; duplicated deep equality in `tooling/resource-contract.mjs:5,72`                                                                                     |
| Package schema `6`, `Farol.app`, executable `Farol Next Preview`, old bundle                                            | W                                           | `tooling/package-layout.mjs:4,15`; `package.mjs:55,155,225`; `verify-package-content.mjs:268,293`; `run-preview.mjs:104`                                                 |
| npm `farol-next-preview`, embedded `farol-next-preview-app`                                                             | W                                           | `package.json:2`; `package-lock.json:2,8`; `tooling/package.mjs:179`; verifier `:268`                                                                                    |
| `legrch/farol-releases`, fixed release API, `farol-release.json`, `Farol-${version}-darwin-arm64.zip`, `Farol-Update/1` | W, already Farol-owned publication contract | `src/modules/release/domain/github-release-contract.ts:3`; `app/github-release.ts:143`; `infra/native/github-update-transport.ts:33`; no rename of accepted publications |
| Release product/bundle `Farol Next Preview` / `local.farol.next.preview`                                                | W                                           | `github-release-contract.ts:10,34`; `app/github-release.ts:146`; `tooling/verify-package-content.mjs:86`; `tooling/update-slot.mjs:19`                                   |
| `github-owner-beta`, fallback `local-preview-only`; feed `stable` / `owner-beta`                                        | W                                           | `package.json:5`; `resources.json:7`; `tooling/release-identity.mjs:10`; `build-identity-contract.mjs:64`; release policy                                                |
| `~/Applications/Farol.app`, `.receipt.json`, `.repair.json`                                                             | W + M recovery custody                      | `installed-update-helper.ts:13`; `tooling/promote-preview.mjs:235`; `promotion-apply.py:20`; `retire-preview-install.py:95`                                              |
| `farol-mark.*`, `farol-dev-mark.*`, `farol.icns`                                                                        | W, already canonical brand resources        | `main.ts:8994`; `src/ui/shell.ts:423`; `tooling/brand-contract.mjs:7`; package/verifier                                                                                  |
| Vendor `Electron`, `com.github.Electron`, framework/helper IDs                                                          | W, vendor attestation                       | `tooling/runtime-contract.mjs:22`; `verify-package-content.mjs:364,398`; these are not obsolete Farol identities                                                         |

## State and protocol identities

| Family / current values                                                                         | Classification                           | Source and preservation obligation                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `farol-next-state`                                                                              | W + M                                    | `main.ts:1652,3063,3305,9011,9035,9260`; settings, grants/authority, run/quit, tasks, Chat journals, Computer lifecycle, workspace effects, handoffs and continuity remain opaque state |
| `farol-next-private`                                                                            | W                                        | `desktop-environment.ts:260,308`; `main.ts:501,3107,3253,3297`; private child homes, connector store and model/proof state; do not export contents                                      |
| `farol-next-state/promotion.lease`, `farol.next.promotion-lease/1`                              | W + M                                    | `src/apps/desktop/promotion-lease.ts:46,96`; `tooling/promotion-lease.mjs:40,67`; moving the path must not create a second admission/maintenance lock domain                            |
| `running.json`, `last-quit.json`                                                                | W + M                                    | `main.ts:9011,9256`; `run-marker.ts:9`; `tooling/promotion-obligations.mjs:215,264`; stale run/unknown drain is not clean Quit                                                          |
| `config.json`; legacy `product-settings.json`                                                   | W + M                                    | `product-configuration.ts:30,567`; `tooling/promotion-obligations.mjs:202`; old filename blocks with `CONFIG_RENAME_REQUIRED`, never fresh-profile defaults                             |
| `installed-updates` beneath old profile; native old state anchor                                | W + M                                    | `installed-update-runtime.ts:398,402`; `resources/native/update_helper.py:23,267`; Release owns journal and helper rebind/reconciliation                                                |
| Connector profile `farol-next`                                                                  | W, persisted and passed to tunnel client | `secure-mcp-connector-runtime.ts:14,367`; `product-configuration.ts:443`; `src/pkg/product-settings/contract.ts:148,170`; source rename must not mutate the live connector              |
| `farol-next-computer`, `farol-next-computer-launch`, Codex clientInfo `farol-next`              | W                                        | Computer MCP `create-readonly-computer-mcp.ts:769`, `launch-contract.ts:515`; `codex-app-server-process.ts:248`                                                                         |
| `farol_next_connector_verify`, `farol_next_caller_tools`, `farol_next_ping`, `farol_next_call_` | W                                        | Computer MCP `:1707,1731`; `codex-host-smoke.ts:50`; settings contract `:44`; `codex-chatgpt-provider.ts:73`; Route B `:119`                                                            |
| `FAROL_NEXT_PROVIDER_TOKEN` environment key                                                     | W, name only; no value inspected         | `codex-app-server-process.ts:189,233`; provider route stays canonical; do not rewrite authentication material                                                                           |
| Profile-hashed `farol-next-relay-*`, `caller-relay.sock`                                        | W                                        | `main.ts:1683`; new path means a new relay identity; old socket cannot authenticate the new backend                                                                                     |
| `farol-next/mind`, `farol-next/drive`, `farol-next-checkpoint-v1:`                              | W, context protocol                      | `codex-chatgpt-provider.ts:1597`; `codex-context-runtime.ts:35`; `host-compaction-codec.ts:69`; retain old readers while new writers switch coherently                                  |
| `farol-next-fence-recovery-unreconciled`, `farol-next-desktop`                                  | W + M                                    | `summary-fence-recovery.ts:24`; durable safety evidence cannot be cosmetically erased                                                                                                   |
| `farol-next:*`, `window.farolNext`, `farol-next-caller-relay/v1`, `farol-next-saved-chat/v1`    | W                                        | IPC channels, preload, caller-relay and saved-chat protocols; both ends require one leased generation change or bounded readers                                                         |
| `farol.next.setup-check-history.v1`, `farol.next.navigation-shortcuts.v1`                       | W                                        | `src/ui/activity-log.ts:107`; `src/ui/shell.ts:453`; local/session storage custody follows browser-session layout                                                                       |
| Resource/tree/promotion/repair/instance/evidence schemas `farol.next.*`                         | W + M                                    | `resources.json:2`; `tooling/artifact-digest.mjs:13`; promotion/repair/evidence tooling; `single-instance.ts:32`; old signed/digested receipts remain unchanged                         |
| `FAROL_NEXT_ENVIRONMENT`, `_ACCEPTANCE_PROFILE`, `_RUNTIME_IDENTITY`, `_OWNER_LAUNCH`, E2E keys | W                                        | `tooling/dev.mjs:20,459`; desktop entry/main; `Taskfile.yml:53`; E2E proof machinery; these remain active selectors until the shared contract changes                                   |
| `FAROL_NEXT_PROFILE_MODE`                                                                       | D selector + active refusal              | `desktop-environment.ts:43`; `dev-launch-environment.test.mjs:75`; retirement must preserve rejection of shared-profile selection                                                       |

## Historical inputs and runtime-hook retirement

| Input/hook                                                             | Classification                                       | Exit or retained boundary                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema `5`, `Farol Next Preview.app` and original display/product      | M + H                                                | `tooling/package-layout.mjs:5,9`; native archive `update_archive.py:22`; brand/predecessor fixtures; current schema-6 installed admission is distinct                                                                                     |
| Closed-preview repair, old receipts and custody directories            | M, callable maintenance                              | `tooling/closed-preview-repair.{mjs,py}`; `retire-preview-install.{mjs,py}`; `.farol-preview-retirement-*`, `.farol-closed-repair.json`, `.farol-repair-*`, `installed-updates-retired-*`; preserve uncertain linkage and rollback chains |
| V0 `.farol`, old launchers and `local.farol.hub.plist`                 | M, active guard presence/fingerprint reads           | `scripts/assert-owner-untouched.py:74`; no V0 invocation; retire/re-scope this hook under the verification owner after final-profile protection exists                                                                                    |
| V0 browser/profile guard and manifest exclusions                       | M, active validation metadata                        | Guard `:90`; `resources.json:61`; resource contract `:64`; keep the no-V0-access boundary while retiring runtime hooks                                                                                                                    |
| Owner-guard invocation chain                                           | W validation machinery                               | `Taskfile.yml` wraps CI, Dev, package and native checks; protect final Farol, Dev, acceptance and bounded migration inputs before retiring old exemptions                                                                                 |
| App-owned Model endpoint / managed config region                       | D production route, tested rollback machinery        | `foundation-feature-gates.ts:5` is false; `farol-model-lifecycle.ts:17`; `farol-model-config-block.ts:35`; no LaunchAgent/daemon; identity work does not enable it                                                                        |
| Standalone `farol-model-token-helper.mjs`                              | D in tracked build/startup                           | No tracked build copy consumer; not a working GUI Codex credential callback; its original contract remains explicit                                                                                                                       |
| `design-lab/prototype.html`, gallery and old design examples           | H                                                    | Synthetic visual identities can remain; they do not select owner data                                                                                                                                                                     |
| Old `Next`/`Preview`/`NEW` prose, fixture roots and temporary prefixes | H when isolated; W if selected by a current launcher | Classify call sites rather than deleting every old string; current operational docs and test selectors change with their owning implementation                                                                                            |

Published schema-5/schema-6 bytes, product/bundle claims, digests, original receipts
and updater expectations are immutable. Release must define a new exact admission
generation; accepting arbitrary names or modifying prior manifests is not a fix.

## Test inventory and evidence map

| Family                                       | Classification                                    | Current suites / cutover obligation                                                                                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build/resource/package/runtime identity      | W tests + H schema-5 branch                       | `build-identity-contract`, `runtime-build-identity`, `resource-manifest`, `brand-contract`, `candidate-contract`, `package-release-channel`, Hunt report evidence                                                                                    |
| Desktop/Dev/profile selection and protection | W tests + M physical Dev spelling                 | `desktop-environment`, `dev-naming`, `dev-profile-directory`, `dev-entrypoint`, `dev-launch-environment`, `owner-protection`, `desktop-startup-failure`                                                                                              |
| Chat/session/pre-submit/verification         | W tests                                           | `chatgpt-route`, `chatgpt-page-policy`, `chatgpt-pre-submit-remedy`, `saved-chat-browser`, `saved-chat-preview-admission`, `guided-app-reverification`, `runtime-sse`                                                                                |
| Config/admission/quit/recovery               | W tests + M legacy input                          | `config-filename`, `config-promotion-filename`, `product-configuration*`, `promotion-lease*`, `promotion-obligations`, `promotion-schema-parity`, `run-marker`, `quit-receipt-store`, `closed-computer-recovery*`                                    |
| Promotion/install/update/retirement          | W tests + M/H predecessors                        | `promote-preview-cli`, `promotion-{apply,destination,flow,gate}`, `installed-update-{helper,helper-readiness,runtime}`, `update-archive`, `update-package-resource-types`, `closed-preview-repair`, `preview-retirement`, `predecessor-package-path` |
| Connector/native task/support/evidence       | W tests, synthetic/disposable scope               | `secure-mcp-{connector-runtime,launch-contract}`, `dev-mcp-proof`, `single-instance-contract`, `launch-snapshot`, `evidence-observe`, `support-export`, `soak-retention`, Computer and task fixtures                                                 |
| E2E process/profile/package launch           | W tests + M/H predecessor branches                | `tests/e2e/preview.e2e.mjs`, guided setup/config error, Dev onboarding, workspace/Computer/task MCP, update-package identity; run against built bytes only after coherent cutover                                                                    |
| NEW/Preview fixture/temp names               | H data, W proof validator if accepted by launcher | E2E marker/root names are an isolation contract; changing only a prefix can remove profile isolation                                                                                                                                                 |

This inventory does not execute these suites or confer live-provider/native/profile
acceptance. The new pure suite lives beside the policy in
`modules/release/domain/migration/plan_test.go`.

## Pure relocation policy

`identity.go` contains only the accepted explicit descriptor values and fixed
migration-source names. `plan.go` operates on classified observations and a
Release-owned record supplied by an adapter. It never opens an owner profile,
generates an operation ID, copies a file, mutates a grant, clears a journal or
launches a process. These are internal domain types, not a second Desktop wire
schema or an independently persisted journal.

| Observed state                                                                                                                                    | Decision                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Dev                                                                                                                                               | Skip production migration before inspecting its observations                  |
| Both roots absent, no record                                                                                                                      | Fresh-profile observation; no filesystem action                               |
| Proven final destination, no source/record                                                                                                        | Existing-final observation; no fabricated migration receipt                   |
| Exact accepted current alpha, absent destination, closed owners + exclusive lock                                                                  | Prepare durable intent bound to operation, alpha build and physical directory |
| Exact `prepared` binding remains at source                                                                                                        | Persist `dispatched`, then one same-volume no-replace whole-root rename       |
| `dispatched`, source still present                                                                                                                | Observe only; never redispatch the rename                                     |
| `dispatched`, source absent and exact physical object/provenance at destination                                                                   | Record relocation observation; do not repeat an effect                        |
| `relocated`, exact destination                                                                                                                    | Stop at `verify-layout`, owned by the agreed Core/Release/Desktop adapter     |
| `completed` plus proven final layout and exact retained binding                                                                                   | Already migrated; no new move or write                                        |
| Active/unknown owner, no exclusive lock, malformed/unreadable/unsafe evidence, unsupported source, mismatched record, collision or refused record | Classified refusal with an empty decision                                     |

Whole-root relocation preserves opaque configuration, grants, browser state,
unknown operations, attachments and unrecognized future files. The in-memory
rename test proves this policy/model property only. The two old browser sessions
cannot be merged blindly: the runtime session installs a localhost-only network
fence; the ChatGPT session owns remote browsing. Core/Desktop must agree the final
persistent browser session and separate local-runtime session before layout
verification. No adapter may apply the localhost fence to the ChatGPT partition.

The final `completed` record is supplied only after native layout and generation
verification. Neither `verify-layout` nor `already-migrated` is launch/effect
permission. Relocating journals never makes `outcome-unknown` retryable. Absolute
profile paths or partition/build witnesses inside retained records require exact
owner reconciliation; they are not mass-rewritten or implicitly acknowledged.

## Adapter prerequisites and integration leases

The dedicated files are Identity-owned preparation. The effectful adapter and
identity switch require explicit integration ownership of these families:

| Owner                 | Coherent leased patch                                                                                                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core/Identity/Desktop | Profile binding before Electron userData/sessionData, instance lock, browser session, run marker, backend and connector start; explicit domain-to-wire mapping                                                                   |
| Desktop               | Runtime/browser session layout, bootstrap validation, UI storage/readers, final process/session names; no persistent session merge                                                                                               |
| Release               | Shared operation record binding/serializer; atomic no-replace same-volume rename, protected ancestors, owner/mode/object checks, durability/readback, root locks, exact helper and unresolved-operation reconciliation, recovery |
| Package/Distribution  | Manifest/build hash, executable and bundle resources, npm metadata/lock, validators, update-slot admission, DMG/installer identity; immutable prior publications                                                                 |
| Computer/Tasks        | Persisted connector/tool/client identity and retained grants/tasks; any external connector reconfiguration remains separate from source preparation                                                                              |
| Verification/tooling  | Final-profile owner guard, launch/environment selectors, E2E proofs/process expectations, maintenance readers and pinned helper digests                                                                                          |

Before any profile effect, the adapter must prove all source/destination writers,
Chromium sessions and profile-owning descendants/helpers are stopped. A missing
PID, expired timestamp, closed window or raw presence check is insufficient. Hold
one verified exclusion domain covering both roots through intent/dispatch/readback;
recheck physical identities immediately at the no-replace effect. Do not create
new empty `Farol` state while migration evidence is unresolved. Never overwrite,
merge, follow a link, use a cross-volume copy, copy an active browser store, launch
V0 or reroute a refused/unknown operation. A source-name match is not accepted-alpha
proof; admission binds the selected accepted alpha build and physical source.

Forward and backward native recovery, partition/state rebinding, durability fault
injection, old-generation helper cleanup, double-writer native contention,
unchanged published artifacts, packaged bytes and installed-alpha preservation
remain **NOT_RUN** in this preparation slice. The pure policy must not be used as
an effectful adapter without those contracts and tests.

## Local preparation checks

Until Core integrates the root module, run the dependency-free package without
creating another `go.mod`:

```sh
GO111MODULE=off go test -race -count=1 -cover ./modules/release/domain/migration
GO111MODULE=off go vet ./modules/release/domain/migration
task ci:fast
git diff --check
```

`task ci:fast` is the existing TypeScript/build/coverage/Hunt/secret gate. The Go
checks are additional; this base's gate does not discover the new Go package.
After Core integration, include it in the root Go suite and retain the separately
owned nested native suite until Release moves that implementation.

The preparation review scope is R3: pure interruption/binding/no-replay policy,
with no active effects or changed public wire contract. Effectful relocation,
state conversion and installed-data acceptance require a fresh assessment of the
integrated risk surface and the required review route before cutover. No source
review alone accepts an installed migration.
