# Desktop/Core checkpoint K0

K0 is an additive backend foundation. The installed Electron application still uses its existing backend. Only the trusted host imports `apps/desktop/bridge/client.ts`; React and remote pages do not receive this client or its pipe.

Run `go build ./cmd/farol`, then `farol serve --profile <id>`. The build owns `boot.BuildID`, set with `-ldflags "-X github.com/legrch/farol/boot.BuildID=<accepted-build-id>"`; development defaults to `development`. The host launches the exact accepted executable with inherited stdin/stdout pipes. Each process generates a fresh 128-bit random incarnation. K0 does not implement an endpoint discovery service, global per-profile lock, app installation, automatic restart, or MCP socket attachment.

## Wire and generation

`api/desktop/v1/schema.json` is the single schema authority. `farol-wire/1` is a deliberately small local generator, not a general schema framework. Run `node tooling/generate-desktop-wire.mjs`; `--check` fails on drift. It uses the locked repository Prettier and Go formatter. Generated Go and TS contain the schema SHA-256; changing the schema requires regenerating both files. Validator templates are generator implementation, not independently authored DTOs.

Frames have a four-byte unsigned big-endian length and 1..1,048,576 UTF-8 JSON bytes. Admit size before allocation. Duplicate keys, invalid UTF-8, depth above 32, unknown envelope fields, numeric request IDs, batches and trailing JSON are refused. A truncated or invalid frame ends the connection; stdout is protocol only, stderr is diagnostics. The TS client counts at most 64 KiB diagnostic bytes and retains no diagnostic contents.

JSON-RPC 2.0 request IDs are opaque ASCII strings, 1..128 characters with letters, digits, `.`, `_`, `:`, `/` and `-`. They are never coerced to numbers. Faults without a recoverable request ID use JSON-RPC `id: null`. Requests use `params: { context?, operationId?, body }`. The handshake body carries major/minor, exact expected build and profile. Major must match and the requested minor must be supported. Adopt context only from that verified handshake result. All subsequent requests bind the exact profile and backend generation. The host remains responsible for accepted executable provenance and IPC sender checks; a handshake alone is not product workspace authority.

Every response echoes request and operation IDs. Outcomes are `ok`, `unavailable`, `unsupported`, `refused` or `unknown`. Unknown methods produce a JSON-RPC fault. Known but unregistered module capabilities return unavailable. Operation status is explicitly unsupported until its authoritative module owner supplies retained state. It must never dispatch a mutation to answer an observation. Request IDs cannot repeat on one connection, bounded at 4,096; the client limits in-flight requests to 32 and stops admitting while its writer is backpressured. A timeout or loss after dispatch is unknown, closes admission and never resends, restarts or switches executors. Fatal failure ends an owned child's input, waits one second, then stops that exact child; cleanup is confirmed only by a terminal child observation, with a two-second observation budget. Unconfirmed cleanup stays unknown and `close()` reports it. Borrowed children are never stopped. Backend cleanup does not prove cancellation of an OS child/provider operation; module journals still own those unknown outcomes.

PID, uint64 counters and sequences use canonical decimal strings (0..18446744073709551615). Safe bounded integer fields use JSON numbers. Timestamps are UTC RFC3339 with up to nine fractional digits. File ranges are UTF-8 byte offsets, never JS UTF-16 indexes. Transport does not add raw filesystem byte-name support. Module adapters own their independent app/contract DTO conversion.

Events bind context, stream and decimal sequence. The client rejects old incarnations/regressions and marks gaps stale; an event cannot change its trusted incarnation. A throwing event observer is unsubscribed; remaining observers and frame parsing continue without changing transport or pending outcomes. No event-producing business service is enabled in K0. Authoritative resnapshot/retention, cancellation, durable operation binding and delivery acknowledgement remain module-owned integration work.

## Composition and next read slice

`cmd/farol` is thin; `boot/container` wires concrete adapters. `transport/desktop.New` accepts only explicitly named methods from the canonical schema. A module-owned adapter maps `desktop.Request` to independent module contracts and supplies `desktop.Outcome`. Effect registrations require an operation ID, but Core supplies no generic durable operation journal: module owners must bind intent durably before effects and reconcile uncertainty. K0 registers no effects.

Computer owns `computer.workspace.read` and all filesystem authority. K1 adds its typed read body/result only after the Computer contract is agreed, then injects disposable trusted repositories through composition. Core supplies the common boundary and never recreates filesystem policy. The existing desktop host chooses the integrated executable; this file does not claim that production uses Go.

## Verification

`node tooling/check-core.mjs` runs generation drift, architecture, root Go race tests/vet, the focused real child-process TS contract tests and strict TypeScript compilation. The repository still requires `task ci:fast` before acceptance. A nested `resources/native/go` module is tested separately whenever it exists; the accepted K0 base predates that release-owned range, so root success cannot qualify it. Go race evidence here is Darwin/arm64 only.

The process/status test compiles the actual executable with `k0-test`, launches a disposable child, verifies its PID/build/profile/incarnation and records round-trip duration. Fixtures qualify hostile wire behavior, not installed application, browser, provider, workspace or update behavior. All processes and test state are owned and disposable; no visible UI is launched.
