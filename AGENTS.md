# Farol repository guide

This is the standalone Farol repository. Source, tooling, tests, and resources
live at the repository root. No sibling V0 checkout or private knowledge vault
is required to build, test, or package it.

The permanent model route is `provider = farol`, `model = chatgpt`.
The product name is Farol. The owner-approved 2026-10-22 identity cutover drops
the old beta naming from current bundles, storage, partitions, tools, environment
keys and schemas. Breaking updates from old betas are accepted; reinstall them.
Production uses bundle and data directory `io.github.legrch.farol`, runtime
partition `persist:farol-runtime`, and ChatGPT partition
`persist:farol-app-chatgpt`. Keep Dev and Owner Preview isolated. Explicit legacy
install readers and rejection fixtures may retain old literals; never target V0
identities. See [identity cutover](docs/identity-cutover.md).

- The accepted target is React + TypeScript for Farol-owned UI, plain TypeScript
  for Electron/preload/browser adapters, and Go for backend policy, application,
  state, orchestration, and native execution. New desktop source belongs under
  `apps/desktop/`; existing TypeScript remains under `src/` until its owned slice
  switches. Strict checks cover both trees. Do not move backend code into desktop
  adapters to evade the cutover.
- The Go modules are `modules/{computer,task,chat,release}`. Existing TypeScript
  `agent` behavior moves to `task` only where it represents coding-task delegation.
  `Turn` belongs to `chat`; Browser, Responses/SSE, IPC, and MCP are adapters.
- Canonical module specifications and indexes are under
  [docs/reference/modules/](docs/reference/modules/README.md); keep ordinary
  product, contract, design and technical documentation under `docs/`, without
  redirect README files in source packages. Follow the
  [documentation layout](docs/development/documentation.md) for asset-custody
  exceptions and frozen historical material. Run `npm run docs:check` after
  documentation or path changes; new module Markdown requires a documented
  machine requirement, not another canonical copy.
- Pure `domain` and `app` depend on values and consumer-owned ports, without host
  APIs, networking, filesystem, ambient clocks, or concrete infrastructure. Root
  `boot/` composes Go; `src/boot/` composes the remaining TypeScript slices.
- A neighbor is visible only through its published Go `contracts` or TypeScript
  `contract`, adapted by the consumer's `infra/peer`. Never import neighbor
  domain/app/infra. Go contracts delegate to their own app with independent DTOs
  and explicit mapping; TypeScript contracts retain their documented DTO surface.
- Kernel infrastructure requires at least two real consumers with identical
  semantics. No Go module imports kernel infrastructure; boot injects its ports.
  Shared implementations own no mutable cross-consumer singleton state.
- Run `task test:core` for generated bindings, Go import enforcement, root Go
  race/vet, transitional nested Go race/vet, protocol tests, and strict desktop
  bridge compilation. `task ci` includes this gate. Reviewed source foundation
  does not prove a packaged or installed Go route; cut over one capability at a
  time and remove its active TypeScript/Python duplicate after acceptance.
- Parse unknown boundary data at runtime. Use closed discriminated states and
  classified errors; never reinterpret an outcome-unknown operation as retryable.
- Co-locate cheap policy tests with the behavior they protect. Run E2E against built
  bytes. Fixtures must state their limits and must not be presented as live-provider,
  native-host, or native-filesystem evidence.
- The preview has its own bundle ID, user data, browser partition, state roots,
  loopback ports, process names, and local-only update channel. Never read or mutate
  the legacy Farol or installed `codex-chatgpt-web` identities.
- Use English for source, tests, UI, logs, errors, and implementation documentation.

- **Farol-specific checkpoint evidence:** include applicable generated-binding, type, static and import checks. Optional `task checkpoint` (`docs/checkpoints.md`) validates evidence consistency, not Lead acceptance.
- **Push is not a CI gate:** the repository intentionally has no `pre-push` hook. `task ci:fast` and `task ci:cloud` still run `scan:secrets` as explicit source-acceptance gates. Run the risk-required checks before PR merge; ordinary feature-branch push should not repeatedly execute the full-history secret scanner. This does not waive any native attestation, security review or release requirement. The active TestOps/CI pilot remains independent of this hook removal.
- **Stable integration candidate:** freeze the exact committed range, then run
  `task ci:fast` and applicable cross-module/aggregate checks once against those
  stable bytes. Fix failures with new commits and rerun affected checks. Preserve
  coverage only where it remains applicable to the new bytes; never mark failed
  or outcome-unknown evidence as passed. Accepted-main advancement requires the
  applicable aggregate and risk-based acceptance gates to be closed.
- **Owner-authorized Cloud source merge:** on Linux, use `task ci:cloud` plus
  independent review of the exact source range. This source gate records deferred
  native/resource files and mixed-case coverage as NOT RUN; it does not satisfy
  full `ci:fast`, native coverage, packaging or installed acceptance. Missing Mac
  hardware alone does not block reviewed portable source from reaching main.
  Keep full native CI and all attestation, hook, confinement and unknown-effect
  predicates unchanged. Fix actual portable failures before source integration.
  If the formal Critic host driver lacks lifecycle primitives, use fresh actual
  native reviewers with the configured cumulative role/model/effort ladder and
  retain their exact source coverage/findings; do not invent driver/close receipts
  or label that evidence as a qualified formal-driver run. Lead owns acceptance.
- **Final/package/release candidate:** run the applicable full CI, native, package,
  installation/live and release gates against exact committed bytes. Preserve
  separate evidence for source acceptance, packaging, installation and live use.
- **Farol reviewer assignments:** General/Specialists use Luna High; Strong/R3 uses GPT-6.1 Sol High; Frontier/R4 uses GPT-6 Astra Max after accepted Strong. Claude review is optional for a specific unresolved question, not a required R3/R4 gate.
- Owner-reported installed launch, connection, or update failures are incidents.
  Prioritize restoring a usable installation under the current owner grant; follow
  `docs/installed-incident-response.md` before resuming broad acceptance reviews.
- Build candidates only with `task package` from clean committed bytes. Compiler,
  dependency, source, resource, and package attestation must remain fail closed.
- Native tests use disposable state and exact owned process cleanup. **Farol Dev is
  development-owned:** the active Lead may start, quit, restart, rebuild, and when
  required by the test plan recreate Dev-only runtime/profile state without per-run
  owner approval. The owner explicitly permits the Lead to stop an already-running
  Farol Dev, including by terminating its positively identified Dev-owned process
  when necessary, and launch the needed Dev build without waiting for the owner.
  Prefer a normal Quit and preserve Dev history and unknown-effect evidence.
  Preserve explicitly quarantined unknown-effect evidence and never
  mutate the installed production Farol profile under this rule. When two displays
  are active, place visible Farol Dev work on the display the owner is not working
  on: the MacBook built-in display when an external monitor is primary, or the iPad
  (Sidecar) when the built-in display is primary (`task dev -- --display=secondary`);
  never on the primary display the owner works on. When only one display is active, visible
  launch, focus, and interaction on that display are allowed as needed. Do not stop
  to ask merely for Farol Dev lifecycle or focus permission. This exception does not
  authorize production installation/replacement/publication or replay of an
  outcome-unknown effect.
- The owner guard is a fingerprint, not a sandbox; a changed protected path fails
  a gate. It must not import or invoke a V0 implementation.
- **Disk hygiene:** whoever creates output removes it in teardown, including on
  failure and cancellation. Do not keep local copies of packages, installed apps
  or retired images: rollback comes from the GitHub Release asset and its digest.
  Do not hand-create Docker volumes; use `testops.py volumes`. Run
  `task disk:status` before finishing a task. See
  [output retention](docs/development/output-retention.md).
- Never commit credentials, tokens, authentication state, browser profiles,
  private prompts/transcripts, caches, or vendor runtime state.
- **Public-source delivery:** the owner approved publishing source/history to `legrch/farol` on 11 October 2026. Before public publication, inspect the outgoing range and scan source/history for credentials, authentication state, private prompts/transcripts, browser profiles, caches, vendor runtime state and unrelated personal data. Preserve local evidence and recovery bundles privately. New or changed remotes, GitHub rename/create, visibility changes, installation, activation, release, signing and licensing require a separate explicit owner decision.
- Live calls are one-shot. Never retry outcome-unknown or platform-refused work.
