# Farol repository guide

This is the standalone Farol repository. Source, tooling, tests, and resources
live at the repository root. No sibling V0 checkout or private knowledge vault
is required to build, test, or package it.

The permanent model route is `provider = farol`, `model = chatgpt`.
Existing preview bundle IDs, state roots, partitions, process names, and receipt
schemas are compatibility boundaries. Do not rename them as a source-layout fix.

- Keep production TypeScript under `src/` and enable strict compiler checks.
- The product modules are `computer`, `chat`, `agent`, and `release`. `Turn` belongs
  to `chat`; Browser, Responses/SSE, IPC, and MCP are adapters or mechanisms.
- Pure `domain` and `app` code must not import Electron, browser APIs, Node built-ins,
  networking, filesystem, ambient timers, or infrastructure. Define consumer-owned
  ports and inject concrete adapters in `src/boot/`.
- Cross-module access is allowed only from `infra/peer` to the owning module's
  published `contract`. Do not import another module's domain, app, or infra.
- `src/pkg/kernel/infra` may implement a kernel port only when at least two real
  module consumers use it. Shared implementations own no cross-consumer mutable
  singleton state. `boot` owns lifetimes.
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
- Run targeted tests, `task ci:fast`, and `git diff --check` before committing.
  Use English Conventional Commits without assistant or vendor attribution.
- Build candidates only with `task package` from clean committed bytes. Compiler,
  dependency, source, resource, and package attestation must remain fail closed.
- Native tests use disposable state, inactive or hidden windows, and exact owned
  process cleanup. Never take focus or compete with an owner's live runtime.
- The owner guard is a fingerprint, not a sandbox; a changed protected path fails
  a gate. It must not import or invoke a V0 implementation.
- Never commit credentials, tokens, authentication state, browser profiles,
  private prompts/transcripts, caches, or vendor runtime state.
- Keep this repository private. GitHub rename/create/push, remote changes,
  installation, activation, release, signing, licensing, and public visibility
  require a separate explicit owner decision during pre-cutover preparation.
- Live calls are one-shot. Never retry outcome-unknown or platform-refused work.
