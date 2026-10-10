# Manual pull request preparation

Title: `feat(chat): add bounded ChatGPT-plan inference with controlled composition`

Source branch: `feature/chatgpt-plan-inference`

Base: the owner's integration target; no main merge is included.

## Body

Adds explicitly selected ChatGPT-plan OAuth inference using the fixed public
Responses endpoint, `store:false`, no tools and bounded streaming. The service
retains the original account, consent, model, input, operation and deadline;
withdrawal prevents delivery, and refused or unknown effects never permit
redispatch or API-key billing fallback. Credential rotation and future App Server
renewal preserve one-shot uncertainty and original lifetimes.

Actual app/credential-manager/account-grant/HTTP composition is covered with
controlled ports. A separate reproducible offline witness consumes the exact
published MODELS and CONTEXT production functions through the actual inference
service and Responses builder/parser. Producer code is assembled outside the
product checkout; shipping boot and shared owner paths are unchanged.

Validation: owned race tests and vet, bounded lifetime/SSE fuzzing, strict wire and
deadline regressions, and the pinned cross-feature witness's nine tests / 33
subcases pass. Exact source checkpoints, original failures, mapping restrictions
and reproducible manifests are documented in HANDOFF and CONSUMER-WITNESS.

Open gates: actual shipping owner ports/boot/physical writer, provider subscription
entitlement and live SIWC, native/Mac qualification, formal review and aggregate
acceptance. The original wire-generator and CI timeouts plus external native test
failures remain unresolved; no aggregate or live pass is claimed.

## Publication status

This file supplies source-only title/body for an owner-created PR. The original
GraphQL PR creation returned `Forbidden` and created no verified PR identifier.
No further creation route was attempted. A verified normal feature-branch push
is recorded separately; it does not mean that a PR or release exists.
