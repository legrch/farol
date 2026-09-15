# Farol Next implementation rules

These rules apply only under `vnext/`. The repository root safety, release, Git, and
non-interference rules still apply.

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
- The Next preview has its own bundle ID, user data, browser partition, state roots,
  loopback ports, process names, and local-only update channel. Never read or mutate
  the legacy Farol or installed `codex-chatgpt-web` identities.
- Use English for source, tests, UI, logs, errors, and implementation documentation.
