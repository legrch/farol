# Deterministic wire admission

The inference-owned `Transport` now requires `Preflight(Request) error`. It is a
bounded pure operation: no credential access, refresh, storage, network, clock
read or owner reentry. The production `planresponses.Client` implements it by
calling the same `requestBody` serializer/strict JSON validator used by `Infer`.
There is no second JSON grammar in the app and no app import of infrastructure.

`Service.Infer` validates its detached ordered input/hash and original authority,
gives preflight a separate input slice, computes the original intent, then checks
original authority, cancellation, deadline and monotonic time immediately before
`Ledger.Reserve`. A preflight failure is `NotSent/INFERENCE_INVALID`; it enters no
journal, credential/refresh or HTTP port. Subsequent transport validation remains
defensive. Neither validation changes a previously consumed operation or grants
replay after an UNKNOWN effect.

Before this change, the real Service accepted `call:1`, `observe/selected`,
duplicate argument keys, an unpaired `\ud800`, and depth-33 JSON. Each real
adapter rejection followed one reserve and one credential acquisition. With the
real CredentialManager's expired synthetic record, each also performed one
controlled refresh and two atomic store writes, while making zero Responses
requests. The original ten-case failing test receipt is retained in the source
export. These were offline controlled effects, not live account operations.

Regression checks exercise those exact cases with ready and expired credentials,
plus a canonical input at the 256-KiB cap whose final wire envelope exceeds it.
They require reserve/acquire/refresh/store-write/HTTP counts all zero. App checks
also cover preflight mutation, cancellation/withdrawal/deadline, positive clock
rollback, withdrawal during intent digestion and a sticky consumed UNKNOWN.

The boot/integration owner must provide the mandatory pure method on any wrapper
implementing `Transport`; the actual Client already supplies it. A wrapper must
delegate to the same actual immutable wire grammar. This is a consumer-port
obligation, not evidence of shipping boot, secret-store, journal or authority
wiring. Original physical publication fences and one-shot live/Mac/review gates
remain required.
