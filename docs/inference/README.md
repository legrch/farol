# Bounded ChatGPT plan inference

This source-only slice composes the Chat-owned inference service with the public
Responses adapter and the existing private account-approval grant. Controlled
tests perform a selected-text summary through the production request builder and
stream parser. They use synthetic account, model, context, credential-store,
journal and HTTP evidence. They establish portable composition, not live model
quality, subscription entitlement, shipping activation or native qualification.

## Route map

| Existing path                                                                                      | Decision                                                                                                                             |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `modules/chat/app/services/lifecycle`, `modules/chat/infra/browser`, `boot/chatstart.go`           | KEEP the existing Browser conversation, Turn, five-slot queue and journal.                                                           |
| `apps/desktop/go-chat-responses.ts`, `modules/chat/infra/responses/sse.go`, `boot/chatdelivery.go` | KEEP inbound Responses serving and frame encoding. These serve another client; they are not outbound OpenAI inference.               |
| `modules/chat/app/services/accountapproval`, `modules/chat/app/port/accountapproval.go`            | ADAPT the existing private grant through `planresponses.ConsentFence`; token scopes cannot mint this grant.                          |
| `modules/chat/app/services/modelselection`, `modules/chat/app/port/modelpolicy.go`                 | KEEP current Browser settings resolution. Account-scoped direct model capabilities are a distinct mapped consumer value.             |
| `modules/task/infra/clients/codex`                                                                 | KEEP the selected App Server proxy client, Task intent, lineage and parent delivery. No second client or agent engine is introduced. |
| `modules/chat/app/services/inference`, `modules/chat/infra/clients/planresponses`                  | ADD bounded outbound no-tools inference through explicitly injected owner capabilities.                                              |

The permanent `provider=farol`, `model=chatgpt` route remains intact. Direct plan
inference does not create a conversation visible on chatgpt.com, allocate a
Browser slot, grant Computer access, or advertise a new shipping capability.

## Owned application and adapter contracts

`inference.New` requires a clock, deadline limiter, digester, credential provider, transport,
current authority, journal ledger and bounded in-memory publication. There are
no default stores, grants, ambient account selection or automatic retries.

`Binding` captures the operation/profile/backend/owner/session, exact selected
OAuth identity, consent revision, catalogue/model/effort evidence, context hash
and one absolute deadline. Input is copied; the entire ordered history and
binding enter the operation fingerprint. The ledger must atomically reserve the
operation before provider IO. Duplicate and uncertain reservations cannot
dispatch again. Settlement records content-free outcome metadata, not text or
credentials. The existing journal owner must implement this small extension;
the feature supplies no competing persistent lifecycle or conversation store.

Text stays transient until a same-response successful terminal, known journal
settlement and final current-authority publication. Withdrawal, expiry, account
change, consumer closure or lost persistence suppresses delivery. Suppression
preserves the original observed remote completion. Local cancellation after IO
starts proves neither remote cancellation nor absence of an effect. The final
physical socket/host writer must check the same original authority again; an
app-level gate cannot guarantee an atomic remote effect. An error after entering
publication stays UNKNOWN with the observed remote completion, because the
callback may already have published; the consumed operation is never repeated.
The injected `OperationDeadline` bounds every credential, journal and transport
port by the original deadline while preserving earlier caller cancellation.
Ports must obey this context. An operation-local clock high-water mark also
refuses zero or rollback observations before further dispatch or disclosure.

`ConsentFence` joins a live `SelectedAccountSource` to the existing private
`accountapproval.Grant`. The source serializes its complete callback against
account and catalogue changes. Detached snapshots and copied grant receipts
cannot supply this capability. The nested callback is synchronous and performs
no IO or owner reentry. OAuth credential refresh remains separate from Computer
task-authority renewal.

`CredentialManager` uses an injected atomic selected-record secret store,
refresh provider, consent policy, gate and clock. A refresh reservation precedes
provider IO. Only an exact CAS receipt publishes the complete access token,
rotating refresh token, granted scopes, expiry and generation. A lost response
or uncertain write remains fenced across later acquisition; no refresh replay
occurs. Refresh-produced records persist provenance; only the same live manager
that witnessed the exact final CAS receipt can reuse that revision/generation.
A fresh manager refuses every such record, including acknowledged rotations,
until the trusted secret/consent owner independently requalifies it under a new
identity epoch/revision. This conservative restart limit avoids claiming durable
receipt recovery from a later read. Local revoke clears the selected tokens and advances its identity epoch;
it does not call a remote revocation endpoint. No actual secret-store adapter,
OIDC verifier, OAuth listener, registration, sign-in UI or live token exchange
is implemented or invoked by this source slice.

## Restricted public transport

`planresponses.New` fixes `https://api.openai.com/v1/responses` and refuses
redirects. A controlled `http.RoundTripper` can exercise the same builder/parser
without external traffic. There is no endpoint override, API-key fallback,
tool execution, model substitution or application retry.

The body contains `model`, explicit ordered `input`, `store:false`, `stream:true`
and an explicitly selected supported reasoning effort when present. Messages
use user/assistant/developer roles. Prior function call/result pairs remain
ordered context; unresolved or invented results are refused. No tools are
offered by this request. The builder omits system messages, HTTP
`previous_response_id`, background/conversation fields and unsupported generic
generation options. The original absolute deadline bounds actual HTTP IO.

The SSE parser bounds total bytes, frames, event count and joined text. It checks
UTF-8 across arbitrary fragmentation, strict JSON with exact protocol keys
(including case and Unicode alias refusal), response identity, terminal
status and available sequence/item correlation. Keepalives convey no success.
EOF, malformed data, foreign identity or error after partial output cannot
produce a final answer. Empty valid completed text is accepted. Diagnostics are
fixed categories; provider messages, token values and partial answers are never
public errors.

## Model and context cooperation

`ModelSelection` pins slug, effort, capability evidence and account catalogue
epoch. A catalogue entry alone does not prove inference entitlement; model
denial is preserved without choosing another model. The accepted MODELS owner
should map its value into this private consumer shape. No shared schema or
current Browser resolver is changed.

`ContextSelection` pins checkpoint ID, ordered-input digest and bounded token
estimate. `InputHash` uses the existing injected SHA-256 adapter. Estimates are
not guaranteed billed token counts. The accepted CONTEXT owner should supply
its immutable bounded history, preserving all required prior call/results.
This service refuses unresolved histories instead of truncating them away.
Later catalogue, context or settings changes cannot alter the captured intent.

## App Server follow-on

`AppServerConfig` and `AppServerLifecycle` validate inert configuration and
metadata-only lifecycle values for a separately owned future integration. They
require the public plan resource, stdio, Responses wire API, `ACCESS_TOKEN` key,
matched real registered app/initialize name and explicit account-bound
model/effort evidence. Configuration arguments contain no credential value.

Renewal requires app-owned atomic token-generation evidence, exact clean joined
stop of the original process, a new initialized process and same-thread resume.
Refused/unknown lifetimes stay fenced; old epochs cannot publish. These values
perform no launch, RPC, socket discovery, credential access or provider work.
The current Task proxy client targets a selected existing host; wiring a new
plan process is a distinct future Task/process-owner decision, not a constructor
option added to that client here.

## Portable verification

From a checkout with the declared Go 1.26.2 and Node/npm toolchain:

```sh
GOTOOLCHAIN=local GOPROXY=off go test -race -count=1 -timeout 60s ./modules/chat/app/services/inference ./modules/chat/infra/clients/planresponses
GOTOOLCHAIN=local GOPROXY=off go vet ./modules/chat/app/services/inference ./modules/chat/infra/clients/planresponses
node tooling/check-go-architecture.mjs
node tooling/generate-desktop-wire.mjs --check
git diff --check
```

`TestProductionCompositionControlledSelectedTextSummary` is the concrete app,
actual private grant and production HTTP/SSE composition witness. Its outgoing
request and result publication counters each equal one. Adjacent composition
and unit tests retain failure, cancellation and withdrawal regressions. Fixture
responses are explicit synthetic evidence, not actual OpenAI answers.

`TestProductionCompositionRealCredentialRotationAndLostReply` adds the real
credential manager, synthetic atomic secret CAS and one-shot rotating provider
to that same service/grant/HTTP composition. A lost refresh reply or account
change produces no HTTP inference. `TestProductionCompositionDeadlineBoundsSecretOwnerIO`
shows the real deadline cancelling a waiting secret read before provider IO.

Applicable aggregate checks and independent review remain integration gates.
Live SIWC registration/identity verification, selected-account catalogue and
one-shot inference, revocation semantics, network MIME behavior, native secret
storage/process cleanup/resume and shipping activation require separately
authorized qualification. No package, installation or release is claimed.

## Current official references

Checked 10 October 2026:

- [ChatGPT plan overview](https://developers.openai.com/siwc/token-sharing-open-source)
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)

Documentation and catalogue evidence do not establish a successful live request.
