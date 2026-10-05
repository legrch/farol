# Farol repository guide

This is the standalone Farol repository. Source, tooling, tests, and resources
live at the repository root. No sibling V0 checkout or private knowledge vault
is required to build, test, or package it.

The permanent model route is `provider = farol`, `model = chatgpt`.
Existing preview bundle IDs, state roots, partitions, process names, and receipt
schemas are compatibility boundaries. Do not rename them as a source-layout fix.

- The accepted target is React + TypeScript for Farol-owned UI, plain TypeScript
  for Electron/preload/browser adapters, and Go for backend policy, application,
  state, orchestration, and native execution. New desktop source belongs under
  `apps/desktop/`; existing TypeScript remains under `src/` until its owned slice
  switches. Strict checks cover both trees. Do not move backend code into desktop
  adapters to evade the cutover.
- The Go modules are `modules/{computer,task,chat,release}`. Existing TypeScript
  `agent` behavior moves to `task` only where it represents coding-task delegation.
  `Turn` belongs to `chat`; Browser, Responses/SSE, IPC, and MCP are adapters.
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

- Preserve unrelated changes. Use named writers and stage only task-owned paths.
- **Coherent implementation checkpoint:** inspect the complete owned diff; run
  representative targeted tests and applicable type, static, generated and import
  checks; self-review the owned diff; run `git diff --check`; then create a coherent
  checkpoint commit. Stage only owned paths and inspect the staged diff. Use English
  Conventional Commits without assistant or vendor attribution. Retain the original
  terminal receipts, exact tested source identity, dependency evidence and limits.
  A checkpoint means safe, coherent and verified enough to preserve and integrate;
  it does not mean the whole task or product is accepted. `task ci:fast` is not
  required before every commit. The optional evidence consistency checker
  (`task checkpoint`, documented in `docs/checkpoints.md`) does not replace the
  implementing Lead's provenance/coverage audit or grant acceptance.
- **Stable integration candidate:** freeze the exact committed range, then run
  `task ci:fast` and applicable cross-module/aggregate checks once against those
  stable bytes. Fix failures with new commits and rerun affected checks. Preserve
  coverage only where it remains applicable to the new bytes; never mark failed
  or outcome-unknown evidence as passed. Accepted-main advancement requires the
  applicable aggregate and risk-based acceptance gates to be closed.
- **Final/package/release candidate:** run the applicable full CI, native, package,
  installation/live and release gates against exact committed bytes. Preserve
  separate evidence for source acceptance, packaging, installation and live use.
- **Review timing:** ordinary development uses self-review, targeted tests and
  bounded independent inspection where useful. Do not run formal R3/R4 after every
  moving implementation checkpoint. Formal Critic R3/R4 belongs to stable/frozen
  coherent integration ranges or final candidates when their risk classification
  requires it. Narrow regression-backed review fixes use targeted independent
  recheck where prior coverage remains applicable. Rerun the whole ladder only
  when policy requires it or a fix materially changes the reviewed risk surface.
  Keep the current Critic ladder: General/Specialists use Luna High, Strong/R3 uses
  GPT-6.1 Sol High, and Frontier/R4 uses GPT-6 Astra Max after accepted Strong.
  Claude review is optional for a specific unresolved question; it is not a
  required R3/R4 gate.
- Build candidates only with `task package` from clean committed bytes. Compiler,
  dependency, source, resource, and package attestation must remain fail closed.
- Native tests use disposable state and exact owned process cleanup. **Farol Dev is
  development-owned:** the active Lead may start, quit, restart, rebuild, and when
  required by the test plan recreate Dev-only runtime/profile state without per-run
  owner approval. Preserve explicitly quarantined unknown-effect evidence and never
  mutate the installed production Farol profile under this rule. When two displays
  are active, place visible Farol Dev work on the MacBook built-in display and avoid
  disturbing the owner's other screen; when only one display is active, visible
  launch, focus, and interaction on that display are allowed as needed. Do not stop
  to ask merely for Farol Dev lifecycle or focus permission. This exception does not
  authorize production installation/replacement/publication or replay of an
  outcome-unknown effect.
- The owner guard is a fingerprint, not a sandbox; a changed protected path fails
  a gate. It must not import or invoke a V0 implementation.
- Never commit credentials, tokens, authentication state, browser profiles,
  private prompts/transcripts, caches, or vendor runtime state.
- Keep this repository private. GitHub rename/create/push, remote changes,
  installation, activation, release, signing, licensing, and public visibility
  require a separate explicit owner decision during pre-cutover preparation.
- Live calls are one-shot. Never retry outcome-unknown or platform-refused work.
